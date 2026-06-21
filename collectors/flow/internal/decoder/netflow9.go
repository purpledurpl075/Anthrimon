package decoder

import (
	"encoding/binary"
	"fmt"
	"net"
	"sync"
	"time"

	"github.com/purpledurpl075/anthri-mon/collectors/flow/internal/model"
)

// ---- Field type constants (IANA NetFlow v9) ----------------------------------

const (
	nf9FieldInBytes              = 1
	nf9FieldInPkts               = 2
	nf9FieldProtocol             = 4
	nf9FieldTOS                  = 5
	nf9FieldTCPFlags             = 6
	nf9FieldL4SrcPort            = 7
	nf9FieldIPv4SrcAddr          = 8
	nf9FieldSrcMask              = 9
	nf9FieldInputSNMP            = 10
	nf9FieldL4DstPort            = 11
	nf9FieldIPv4DstAddr          = 12
	nf9FieldDstMask              = 13
	nf9FieldOutputSNMP           = 14
	nf9FieldIPv4NextHop          = 15
	nf9FieldSrcAS                = 16
	nf9FieldDstAS                = 17
	nf9FieldLastSwitched         = 21
	nf9FieldFirstSwitched        = 22
	nf9FieldOutBytes             = 23
	nf9FieldOutPkts              = 24
	nf9FieldIPv6SrcAddr          = 27
	nf9FieldIPv6DstAddr          = 28
	nf9FieldSamplingInterval     = 85
	nf9FieldFlowStartSeconds     = 150
	nf9FieldFlowEndSeconds       = 151
	nf9FieldFlowStartMilliseconds = 152
	nf9FieldFlowEndMilliseconds   = 153
)

// ---- Template cache ---------------------------------------------------------

const maxTemplates = 10000

// FieldDef describes one field within a NetFlow v9 / IPFIX template.
type FieldDef struct {
	TypeID uint16
	Length uint16
}

// templateKey uniquely identifies a template within the context of a single
// exporter (exporterIP:sourceID:templateID).
type templateKey struct {
	exporterIP string
	sourceID   uint32
	templateID uint16
}

// TemplateCache is a concurrency-safe store for NetFlow v9 / IPFIX template
// definitions. A single cache instance must be shared between the parser
// goroutine and any goroutines that might call ParseNetFlow9 / ParseIPFIX.
type TemplateCache struct {
	mu        sync.RWMutex
	templates map[templateKey][]FieldDef
	lastSeen  map[templateKey]time.Time
}

// NewTemplateCache constructs an empty TemplateCache.
func NewTemplateCache() *TemplateCache {
	return &TemplateCache{
		templates: make(map[templateKey][]FieldDef),
		lastSeen:  make(map[templateKey]time.Time),
	}
}

func (tc *TemplateCache) store(key templateKey, fields []FieldDef) {
	tc.mu.Lock()
	tc.templates[key] = fields
	tc.lastSeen[key] = time.Now()
	if len(tc.templates) > maxTemplates {
		tc.evictOldest()
	}
	tc.mu.Unlock()
}

// evictOldest removes the oldest 20% of templates. Must be called with mu held.
func (tc *TemplateCache) evictOldest() {
	toEvict := len(tc.templates) / 5
	if toEvict == 0 {
		toEvict = 1
	}
	for i := 0; i < toEvict; i++ {
		var oldestKey templateKey
		var oldestTime time.Time
		first := true
		for k, t := range tc.lastSeen {
			if first || t.Before(oldestTime) {
				oldestKey = k
				oldestTime = t
				first = false
			}
		}
		if first {
			break
		}
		delete(tc.templates, oldestKey)
		delete(tc.lastSeen, oldestKey)
	}
}

func (tc *TemplateCache) load(key templateKey) ([]FieldDef, bool) {
	tc.mu.RLock()
	f, ok := tc.templates[key]
	tc.mu.RUnlock()
	if ok {
		tc.mu.Lock()
		tc.lastSeen[key] = time.Now()
		tc.mu.Unlock()
	}
	return f, ok
}

// ---- NetFlow v9 parser ------------------------------------------------------

// nf9Header is parsed from the first 20 bytes of a NetFlow v9 UDP payload.
type nf9Header struct {
	version   uint16
	count     uint16 // number of flowsets
	sysUptime uint32 // ms
	unixSecs  uint32
	seqNum    uint32
	sourceID  uint32
}

// ParseNetFlow9 decodes a NetFlow v9 UDP payload. Templates encountered are
// stored in cache; data flowsets are decoded using previously-seen templates.
func ParseNetFlow9(pkt []byte, exporterIP net.IP, cache *TemplateCache) ([]model.FlowRecord, error) {
	if len(pkt) < 20 {
		return nil, fmt.Errorf("netflow v9: packet too short (%d bytes)", len(pkt))
	}
	hdr := nf9Header{
		version:   binary.BigEndian.Uint16(pkt[0:2]),
		count:     binary.BigEndian.Uint16(pkt[2:4]),
		sysUptime: binary.BigEndian.Uint32(pkt[4:8]),
		unixSecs:  binary.BigEndian.Uint32(pkt[8:12]),
		seqNum:    binary.BigEndian.Uint32(pkt[12:16]),
		sourceID:  binary.BigEndian.Uint32(pkt[16:20]),
	}
	if hdr.version != 9 {
		return nil, fmt.Errorf("netflow v9: unexpected version %d", hdr.version)
	}

	exporterStr := exporterIP.String()
	baseTime := time.Unix(int64(hdr.unixSecs), 0).UTC()

	return parseFlowSets(pkt[20:], exporterStr, hdr.sourceID, hdr.sysUptime, baseTime, cache, "netflow_v9", false)
}

// ---- IPFIX parser -----------------------------------------------------------

// ParseIPFIX decodes an IPFIX (RFC 7011) UDP payload. IPFIX uses the same
// flowset/set structure as NetFlow v9 but with a different set ID namespace
// (template sets = 2, option template sets = 3, data sets ≥ 256).
func ParseIPFIX(pkt []byte, exporterIP net.IP, cache *TemplateCache) ([]model.FlowRecord, error) {
	if len(pkt) < 16 {
		return nil, fmt.Errorf("ipfix: packet too short (%d bytes)", len(pkt))
	}
	version := binary.BigEndian.Uint16(pkt[0:2])
	if version != 10 {
		return nil, fmt.Errorf("ipfix: unexpected version %d", version)
	}
	// length := binary.BigEndian.Uint16(pkt[2:4])
	exportTime := binary.BigEndian.Uint32(pkt[4:8])
	// seqNum    := binary.BigEndian.Uint32(pkt[8:12])  // not used yet
	obsDomainID := binary.BigEndian.Uint32(pkt[12:16])

	exporterStr := exporterIP.String()
	baseTime := time.Unix(int64(exportTime), 0).UTC()

	// IPFIX: sysUptime not present in header; pass 0 — FIRST/LAST_SWITCHED
	// offsets will be treated relative to export time.
	return parseFlowSets(pkt[16:], exporterStr, obsDomainID, 0, baseTime, cache, "ipfix", true)
}

// ---- Shared flowset parser --------------------------------------------------

// parseFlowSets iterates over flowsets/sets in the payload (after the header)
// and decodes template and data sets.
func parseFlowSets(
	payload []byte,
	exporterStr string,
	sourceID uint32,
	sysUptime uint32,
	baseTime time.Time,
	cache *TemplateCache,
	flowType string,
	isIPFIX bool,
) ([]model.FlowRecord, error) {
	var records []model.FlowRecord
	off := 0

	for off+4 <= len(payload) {
		setID := binary.BigEndian.Uint16(payload[off : off+2])
		setLen := int(binary.BigEndian.Uint16(payload[off+2 : off+4]))
		if setLen < 4 {
			break // malformed
		}
		if off+setLen > len(payload) {
			break // truncated
		}

		setData := payload[off+4 : off+setLen]

		switch {
		case setID == 0 || setID == 1:
			// NF9: 0 = template flowset, 1 = option template flowset
			if !isIPFIX {
				parseTemplateFlowSet(setData, exporterStr, sourceID, cache)
			}
		case setID == 2:
			// IPFIX: template set
			if isIPFIX {
				parseTemplateFlowSet(setData, exporterStr, sourceID, cache)
			}
		case setID == 3:
			// IPFIX: options template set — skip for now
		case setID >= 256:
			// Data flowset (NF9) / data set (IPFIX): template ID == setID
			recs := parseDataSet(setData, setID, exporterStr, sourceID,
				sysUptime, baseTime, cache, flowType)
			records = append(records, recs...)
		// IDs 4-255 are reserved/unknown — skip silently.
		}

		off += setLen
		// Align to 4-byte boundary (NF9 spec; IPFIX sets own length).
		for off%4 != 0 && off < len(payload) {
			off++
		}
	}
	return records, nil
}

// parseTemplateFlowSet reads one or more template definitions from a template
// flowset / template set and stores them in the cache.
func parseTemplateFlowSet(data []byte, exporterStr string, sourceID uint32, cache *TemplateCache) {
	off := 0
	for off+4 <= len(data) {
		templateID := binary.BigEndian.Uint16(data[off : off+2])
		fieldCount := int(binary.BigEndian.Uint16(data[off+2 : off+4]))
		off += 4

		if templateID < 256 {
			// skip padding / malformed
			break
		}

		if off+fieldCount*4 > len(data) {
			break
		}

		fields := make([]FieldDef, fieldCount)
		for i := 0; i < fieldCount; i++ {
			typeID := binary.BigEndian.Uint16(data[off : off+2])
			length := binary.BigEndian.Uint16(data[off+2 : off+4])
			// For IPFIX enterprise fields the high bit of typeID is set;
			// we strip the enterprise bit and skip the 4-byte enterprise number.
			enterpriseBit := typeID & 0x8000
			typeID &= 0x7FFF
			fields[i] = FieldDef{TypeID: typeID, Length: length}
			off += 4
			if enterpriseBit != 0 {
				off += 4 // skip enterprise number
			}
		}

		key := templateKey{exporterStr, sourceID, templateID}
		cache.store(key, fields)
	}
}

// parseDataSet decodes flow records from a data flowset/set using the
// corresponding cached template.
func parseDataSet(
	data []byte,
	templateID uint16,
	exporterStr string,
	sourceID uint32,
	sysUptime uint32,
	baseTime time.Time,
	cache *TemplateCache,
	flowType string,
) []model.FlowRecord {
	key := templateKey{exporterStr, sourceID, templateID}
	fields, ok := cache.load(key)
	if !ok {
		// Template not yet received; drop silently (expected on first packet burst).
		return nil
	}

	// Compute fixed record size.
	recLen := 0
	for _, f := range fields {
		recLen += int(f.Length)
	}
	if recLen == 0 {
		return nil
	}

	var records []model.FlowRecord
	off := 0
	for off+recLen <= len(data) {
		rec := decodeDataRecord(data[off:off+recLen], fields, sysUptime, baseTime, flowType)
		records = append(records, rec)
		off += recLen
	}
	return records
}

// decodeDataRecord extracts field values from one data record and populates a
// FlowRecord. Fields unknown to this implementation are skipped.
func decodeDataRecord(
	data []byte,
	fields []FieldDef,
	sysUptime uint32,
	baseTime time.Time,
	flowType string,
) model.FlowRecord {
	var rec model.FlowRecord
	rec.FlowType = flowType
	rec.SamplingRate = 1

	var firstSwitched, lastSwitched uint32
	hasFirstSwitched, hasLastSwitched := false, false

	off := 0
	for _, f := range fields {
		end := off + int(f.Length)
		if end > len(data) {
			break
		}
		v := data[off:end]
		l := int(f.Length)

		switch f.TypeID {
		case nf9FieldInBytes:
			rec.Bytes = readUintN(v, l)
		case nf9FieldInPkts:
			rec.Packets = readUintN(v, l)
		case nf9FieldOutBytes:
			if rec.Bytes == 0 {
				rec.Bytes = readUintN(v, l)
			}
		case nf9FieldOutPkts:
			if rec.Packets == 0 {
				rec.Packets = readUintN(v, l)
			}
		case nf9FieldProtocol:
			if l >= 1 {
				rec.IPProtocol = v[0]
			}
		case nf9FieldTOS:
			if l >= 1 {
				rec.TOS = v[0]
				rec.DSCP = v[0] >> 2
			}
		case nf9FieldTCPFlags:
			if l >= 1 {
				rec.TCPFlags = v[0]
			}
		case nf9FieldL4SrcPort:
			if l >= 2 {
				rec.SrcPort = binary.BigEndian.Uint16(v[0:2])
			}
		case nf9FieldL4DstPort:
			if l >= 2 {
				rec.DstPort = binary.BigEndian.Uint16(v[0:2])
			}
		case nf9FieldIPv4SrcAddr:
			if l == 4 {
				rec.SrcIP = net.IP{v[0], v[1], v[2], v[3]}
			}
		case nf9FieldIPv4DstAddr:
			if l == 4 {
				rec.DstIP = net.IP{v[0], v[1], v[2], v[3]}
			}
		case nf9FieldIPv4NextHop:
			if l == 4 {
				rec.NextHop = net.IP{v[0], v[1], v[2], v[3]}
			}
		case nf9FieldIPv6SrcAddr:
			if l == 16 {
				ip := make(net.IP, 16)
				copy(ip, v)
				rec.SrcIP6 = ip
			}
		case nf9FieldIPv6DstAddr:
			if l == 16 {
				ip := make(net.IP, 16)
				copy(ip, v)
				rec.DstIP6 = ip
			}
		case nf9FieldSrcMask:
			if l >= 1 {
				rec.SrcPrefixLen = v[0]
			}
		case nf9FieldDstMask:
			if l >= 1 {
				rec.DstPrefixLen = v[0]
			}
		case nf9FieldInputSNMP:
			rec.InputIfIndex = uint32(readUintN(v, l))
		case nf9FieldOutputSNMP:
			rec.OutputIfIndex = uint32(readUintN(v, l))
		case nf9FieldSrcAS:
			rec.SrcASN = uint32(readUintN(v, l))
		case nf9FieldDstAS:
			rec.DstASN = uint32(readUintN(v, l))
		case nf9FieldFirstSwitched:
			if l == 4 {
				firstSwitched = binary.BigEndian.Uint32(v)
				hasFirstSwitched = true
			}
		case nf9FieldLastSwitched:
			if l == 4 {
				lastSwitched = binary.BigEndian.Uint32(v)
				hasLastSwitched = true
			}
		case nf9FieldFlowStartSeconds:
			if l >= 4 {
				rec.FlowStart = time.Unix(int64(binary.BigEndian.Uint32(v[0:4])), 0).UTC()
			}
		case nf9FieldFlowEndSeconds:
			if l >= 4 {
				rec.FlowEnd = time.Unix(int64(binary.BigEndian.Uint32(v[0:4])), 0).UTC()
			}
		case nf9FieldFlowStartMilliseconds:
			if l >= 8 {
				ms := int64(binary.BigEndian.Uint64(v[0:8]))
				rec.FlowStart = time.UnixMilli(ms).UTC()
			}
		case nf9FieldFlowEndMilliseconds:
			if l >= 8 {
				ms := int64(binary.BigEndian.Uint64(v[0:8]))
				rec.FlowEnd = time.UnixMilli(ms).UTC()
			}
		case nf9FieldSamplingInterval:
			s := uint32(readUintN(v, l))
			if s > 0 {
				rec.SamplingRate = s
			}
		}

		off = end
	}

	// FIRST_SWITCHED / LAST_SWITCHED are uptime-relative ms offsets.
	if hasFirstSwitched && rec.FlowStart.IsZero() {
		rec.FlowStart = uptimeToTime(baseTime, sysUptime, firstSwitched)
	}
	if hasLastSwitched && rec.FlowEnd.IsZero() {
		rec.FlowEnd = uptimeToTime(baseTime, sysUptime, lastSwitched)
	}

	// If still zero, fall back to export time.
	if rec.FlowStart.IsZero() {
		rec.FlowStart = baseTime
	}
	if rec.FlowEnd.IsZero() {
		rec.FlowEnd = baseTime
	}

	return rec
}

// readUintN reads an unsigned integer of length l (1, 2, 4, or 8 bytes) from
// the byte slice v in big-endian order.
func readUintN(v []byte, l int) uint64 {
	switch l {
	case 1:
		return uint64(v[0])
	case 2:
		return uint64(binary.BigEndian.Uint16(v[0:2]))
	case 4:
		return uint64(binary.BigEndian.Uint32(v[0:4]))
	case 8:
		return binary.BigEndian.Uint64(v[0:8])
	default:
		if len(v) == 0 {
			return 0
		}
		// Variable length: read up to 8 bytes big-endian.
		n := l
		if n > 8 {
			n = 8
		}
		var result uint64
		for i := 0; i < n; i++ {
			result = (result << 8) | uint64(v[i])
		}
		return result
	}
}
