package poller

import (
	"fmt"
	"net"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/gosnmp/gosnmp"
	"github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/client"
	"github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/model"
	"github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/oid"
)

// PollISISAdjacencies walks ISIS-MIB isisISAdjTable and isisISAdjIPAddrTable.
// It also walks isisCircTable to resolve circuit index → interface name.
// sysUpTimeTicks is used to calculate adjacency uptime from isisISAdjLastUpTime.
func PollISISAdjacencies(s *client.Session, deviceID uuid.UUID, ifByIndex map[int]string, sysUpTimeTicks uint32) ([]*model.ISISAdjacency, error) {
	adjPDUs, err := s.BulkWalkAll(oid.ISISAdjTable)
	if err != nil || len(adjPDUs) == 0 {
		return nil, err
	}

	// Build circuit index → ifIndex map from isisCircTable.
	circPDUs, _ := s.BulkWalkAll(oid.ISISCircTable)
	circToIfIdx := make(map[int]int)
	for _, pdu := range circPDUs {
		col, circIdx, _ := splitISISCircIndex(pdu.Name, oid.ISISCircTable)
		if col == 2 { // isisCircIfIndex
			circToIfIdx[circIdx] = client.PDUInt(pdu)
		}
	}

	// Build adjacency IP addresses from isisISAdjIPAddrTable.
	ipPDUs, _ := s.BulkWalkAll(oid.ISISAdjIPTable)
	type adjKey struct{ circ, adj int }
	type adjIPs struct{ ipv4, ipv6 string }
	ipMap := make(map[adjKey]adjIPs)
	for _, pdu := range ipPDUs {
		col, circIdx, adjIdx, _, _ := splitISISAdjIPIndex(pdu.Name, oid.ISISAdjIPTable)
		if col != 3 { // isisISAdjIPAddrAddress
			continue
		}
		k := adjKey{circIdx, adjIdx}
		ip := isisIPFromPDU(pdu)
		if strings.Contains(ip, ":") {
			e := ipMap[k]
			e.ipv6 = ip
			ipMap[k] = e
		} else if ip != "" {
			e := ipMap[k]
			e.ipv4 = ip
			ipMap[k] = e
		}
	}

	type adjRow struct {
		instance string
		state    int
		sysID    string
		usage    int
		lastUp   uint32
	}
	rows := make(map[adjKey]*adjRow)
	ensureRow := func(k adjKey, inst string) *adjRow {
		if r, ok := rows[k]; ok {
			return r
		}
		r := &adjRow{instance: inst}
		rows[k] = r
		return r
	}

	for _, pdu := range adjPDUs {
		col, circIdx, adjIdx, inst := splitISISAdjIndex(pdu.Name, oid.ISISAdjTable)
		if col < 0 {
			continue
		}
		k := adjKey{circIdx, adjIdx}
		r := ensureRow(k, inst)
		switch col {
		case 2: // isisISAdjState: 1=down,2=initializing,3=up,4=failed
			r.state = client.PDUInt(pdu)
		case 5: // isisISAdjNeighSysID: 6-byte neighbour system-id
			r.sysID = isisFormatSysID(pdu)
		case 7: // isisISAdjUsage: 1=undefined,2=level-1,3=level-2,4=level-1-2
			r.usage = client.PDUInt(pdu)
		case 10: // isisISAdjLastUpTime: TimeTicks when last entered Up
			r.lastUp = uint32(client.PDUUint64(pdu))
		}
	}

	results := make([]*model.ISISAdjacency, 0, len(rows))
	for k, r := range rows {
		if r.state == 0 {
			continue
		}
		ifName := ifByIndex[circToIfIdx[k.circ]]
		ips := ipMap[k]

		var uptimeSecs int64
		if r.state == 3 && r.lastUp > 0 && sysUpTimeTicks >= r.lastUp {
			// lastUpTime is a TimeTicks timestamp (hundredths of a second since agent start)
			uptimeSecs = int64(sysUpTimeTicks-r.lastUp) / 100
		}

		results = append(results, &model.ISISAdjacency{
			DeviceID:      deviceID,
			Instance:      r.instance,
			SysID:         r.sysID,
			InterfaceName: ifName,
			CircuitType:   isisLevelName(r.usage),
			AdjState:      isisAdjStateName(r.state),
			IPv4Address:   ips.ipv4,
			IPv6Address:   ips.ipv6,
			UptimeSeconds: uptimeSecs,
		})
	}
	return results, nil
}

// PollISISAreas walks ISIS-MIB isisSysAreaAddrTable to discover the area
// addresses configured for each IS-IS instance on a device.
func PollISISAreas(s *client.Session, deviceID uuid.UUID) ([]*model.ISISArea, error) {
	pdus, err := s.BulkWalkAll(oid.ISISSysAreaAddrTable)
	if err != nil || len(pdus) == 0 {
		return nil, err
	}

	seen := make(map[string]bool)
	var results []*model.ISISArea
	for _, pdu := range pdus {
		col, inst, ok := splitISISSysAreaAddrIndex(pdu.Name, oid.ISISSysAreaAddrTable)
		if !ok || col != 1 { // isisSysAreaAddr
			continue
		}
		b, ok := pdu.Value.([]byte)
		if !ok || len(b) == 0 {
			continue
		}
		areaAddr := isisFormatAreaAddr(b)
		if areaAddr == "" {
			continue
		}
		key := inst + "|" + areaAddr
		if seen[key] {
			continue
		}
		seen[key] = true
		results = append(results, &model.ISISArea{
			DeviceID: deviceID,
			Instance: inst,
			AreaAddr: areaAddr,
		})
	}
	return results, nil
}

// PollISISCircuitLevels walks ISIS-MIB isisCircLevelTable to collect
// per-circuit, per-level link parameters: metric, hello/hold timers, DIS
// priority and the currently elected LAN-DIS. It reuses isisCircTable to
// resolve circuit index -> interface name.
func PollISISCircuitLevels(s *client.Session, deviceID uuid.UUID, ifByIndex map[int]string) ([]*model.ISISCircuitLevel, error) {
	pdus, err := s.BulkWalkAll(oid.ISISCircLevelTable)
	if err != nil || len(pdus) == 0 {
		return nil, err
	}

	// Build circuit index → ifIndex map from isisCircTable.
	circPDUs, _ := s.BulkWalkAll(oid.ISISCircTable)
	circToIfIdx := make(map[int]int)
	for _, pdu := range circPDUs {
		col, circIdx, _ := splitISISCircIndex(pdu.Name, oid.ISISCircTable)
		if col == 2 { // isisCircIfIndex
			circToIfIdx[circIdx] = client.PDUInt(pdu)
		}
	}

	type levelKey struct{ circ, level int }
	type levelRow struct {
		instance     string
		metric       int
		wideMetric   int
		priority     int
		desIS        []byte
		helloMult    int
		helloTimerMs int
	}
	rows := make(map[levelKey]*levelRow)
	ensureRow := func(k levelKey, inst string) *levelRow {
		if r, ok := rows[k]; ok {
			return r
		}
		r := &levelRow{instance: inst}
		rows[k] = r
		return r
	}

	for _, pdu := range pdus {
		col, circIdx, levelIdx, inst := splitISISCircLevelIndex(pdu.Name, oid.ISISCircLevelTable)
		if col < 0 {
			continue
		}
		k := levelKey{circIdx, levelIdx}
		r := ensureRow(k, inst)
		switch col {
		case 2: // isisCircLevelMetric (narrow)
			r.metric = client.PDUInt(pdu)
		case 3: // isisCircLevelWideMetric
			r.wideMetric = client.PDUInt(pdu)
		case 4: // isisCircLevelISPriority
			r.priority = client.PDUInt(pdu)
		case 7: // isisCircLevelDesIS — LAN-DIS ID (7 bytes), all-zero = no DIS
			if b, ok := pdu.Value.([]byte); ok {
				r.desIS = b
			}
		case 8: // isisCircLevelHelloMultiplier
			r.helloMult = client.PDUInt(pdu)
		case 9: // isisCircLevelHelloTimer (milliseconds)
			r.helloTimerMs = client.PDUInt(pdu)
		}
	}

	results := make([]*model.ISISCircuitLevel, 0, len(rows))
	for k, r := range rows {
		ifName := ifByIndex[circToIfIdx[k.circ]]
		if ifName == "" {
			continue
		}

		metric := r.wideMetric
		if metric == 0 {
			metric = r.metric
		}

		helloSecs := r.helloTimerMs / 1000
		holdSecs := 0
		if helloSecs > 0 && r.helloMult > 0 {
			holdSecs = helloSecs * r.helloMult
		}

		results = append(results, &model.ISISCircuitLevel{
			DeviceID:      deviceID,
			Instance:      r.instance,
			InterfaceName: ifName,
			Level:         isisCircLevelName(k.level),
			Metric:        metric,
			HelloInterval: helloSecs,
			HoldTimer:     holdSecs,
			Priority:      r.priority,
			DISID:         isisFormatDIS(r.desIS),
		})
	}
	return results, nil
}

// PollISISLSPDatabase walks ISIS-MIB isisLSPSummaryTable to retrieve the
// link-state database: one row per LSP currently held by the device.
func PollISISLSPDatabase(s *client.Session, deviceID uuid.UUID) ([]*model.ISISLSP, error) {
	pdus, err := s.BulkWalkAll(oid.ISISLSPTable)
	if err != nil || len(pdus) == 0 {
		return nil, err
	}

	type lspKey struct {
		level int
		lspID string
	}
	type lspRow struct {
		instance   string
		seq        int64
		zeroLife   bool
		checksum   int
		lifetime   int
		pduLength  int
		attributes int
	}
	rows := make(map[lspKey]*lspRow)
	ensureRow := func(k lspKey, inst string) *lspRow {
		if r, ok := rows[k]; ok {
			return r
		}
		r := &lspRow{instance: inst}
		rows[k] = r
		return r
	}

	for _, pdu := range pdus {
		col, level, lspID, inst, ok := splitISISLSPIndex(pdu.Name, oid.ISISLSPTable)
		if !ok {
			continue
		}
		k := lspKey{level, lspID}
		r := ensureRow(k, inst)
		switch col {
		case 3: // isisLSPSeq
			r.seq = int64(client.PDUUint64(pdu))
		case 4: // isisLSPZeroLife — TruthValue: 1=true, 2=false
			r.zeroLife = client.PDUInt(pdu) == 1
		case 5: // isisLSPChecksum
			r.checksum = client.PDUInt(pdu)
		case 6: // isisLSPLifetimeRemain
			r.lifetime = client.PDUInt(pdu)
		case 7: // isisLSPPDULength
			r.pduLength = client.PDUInt(pdu)
		case 8: // isisLSPAttributes
			r.attributes = client.PDUInt(pdu)
		}
	}

	results := make([]*model.ISISLSP, 0, len(rows))
	for k, r := range rows {
		if r.zeroLife {
			continue // being purged; treat as absent from the database
		}
		results = append(results, &model.ISISLSP{
			DeviceID:          deviceID,
			Instance:          r.instance,
			Level:             isisCircLevelName(k.level),
			LSPID:             k.lspID,
			SequenceNumber:    r.seq,
			Checksum:          r.checksum,
			RemainingLifetime: r.lifetime,
			PDULength:         r.pduLength,
			OverloadBit:       r.attributes&0x04 != 0,
			AttachedBit:       r.attributes&0x78 != 0,
		})
	}
	return results, nil
}

// ── Index parsers ─────────────────────────────────────────────────────────────
//
// ISIS-MIB indices encode isisSysInstance as a length-prefixed OctetString.
// For the default/empty instance the length is 0 and no characters follow.

// splitISISAdjIndex extracts (col, circIndex, adjIndex, instance) from isisISAdjTable.
// OID tail: col.instLen[.instChars*].circIdx.adjIdx
func splitISISAdjIndex(pduName, tableOID string) (col, circIdx, adjIdx int, instance string) {
	parts, ok := isisStripBase(pduName, tableOID)
	if !ok || len(parts) < 4 {
		return -1, 0, 0, ""
	}
	col, _ = strconv.Atoi(parts[0])
	inst, skip := isisParseInstance(parts[1:])
	if skip < 0 || len(parts) < 2+skip+2 {
		return -1, 0, 0, ""
	}
	circIdx, _ = strconv.Atoi(parts[2+skip])
	adjIdx, _ = strconv.Atoi(parts[2+skip+1])
	return col, circIdx, adjIdx, inst
}

// splitISISCircIndex extracts (col, circIndex, instance) from isisCircTable.
// OID tail: col.instLen[.instChars*].circIdx
func splitISISCircIndex(pduName, tableOID string) (col, circIdx int, instance string) {
	parts, ok := isisStripBase(pduName, tableOID)
	if !ok || len(parts) < 3 {
		return -1, 0, ""
	}
	col, _ = strconv.Atoi(parts[0])
	inst, skip := isisParseInstance(parts[1:])
	if skip < 0 || len(parts) < 2+skip+1 {
		return -1, 0, ""
	}
	circIdx, _ = strconv.Atoi(parts[2+skip])
	return col, circIdx, inst
}

// splitISISAdjIPIndex extracts (col, circIdx, adjIdx, ipIdx, instance) from isisISAdjIPAddrTable.
// OID tail: col.instLen[.instChars*].circIdx.adjIdx.ipIdx
func splitISISAdjIPIndex(pduName, tableOID string) (col, circIdx, adjIdx, ipIdx int, instance string) {
	parts, ok := isisStripBase(pduName, tableOID)
	if !ok || len(parts) < 5 {
		return -1, 0, 0, 0, ""
	}
	col, _ = strconv.Atoi(parts[0])
	inst, skip := isisParseInstance(parts[1:])
	if skip < 0 || len(parts) < 2+skip+3 {
		return -1, 0, 0, 0, ""
	}
	circIdx, _ = strconv.Atoi(parts[2+skip])
	adjIdx, _ = strconv.Atoi(parts[2+skip+1])
	ipIdx, _ = strconv.Atoi(parts[2+skip+2])
	return col, circIdx, adjIdx, ipIdx, inst
}

// splitISISSysAreaAddrIndex extracts (col, instance) from isisSysAreaAddrTable.
// OID tail: col.instLen[.instChars*].areaAddrBytes* -- the area address is the
// table's IMPLIED second index component, but for column 1 (isisSysAreaAddr)
// the same bytes are also the PDU value, so callers read it from there.
func splitISISSysAreaAddrIndex(pduName, tableOID string) (col int, instance string, ok bool) {
	parts, sok := isisStripBase(pduName, tableOID)
	if !sok || len(parts) < 2 {
		return -1, "", false
	}
	col, _ = strconv.Atoi(parts[0])
	inst, skip := isisParseInstance(parts[1:])
	if skip < 0 {
		return -1, "", false
	}
	return col, inst, true
}

// splitISISCircLevelIndex extracts (col, circIndex, levelIndex, instance) from isisCircLevelTable.
// OID tail: col.instLen[.instChars*].circIdx.levelIdx
func splitISISCircLevelIndex(pduName, tableOID string) (col, circIdx, levelIdx int, instance string) {
	parts, ok := isisStripBase(pduName, tableOID)
	if !ok || len(parts) < 4 {
		return -1, 0, 0, ""
	}
	col, _ = strconv.Atoi(parts[0])
	inst, skip := isisParseInstance(parts[1:])
	if skip < 0 || len(parts) < 2+skip+2 {
		return -1, 0, 0, ""
	}
	circIdx, _ = strconv.Atoi(parts[2+skip])
	levelIdx, _ = strconv.Atoi(parts[2+skip+1])
	return col, circIdx, levelIdx, inst
}

// splitISISLSPIndex extracts (col, level, lspID, instance) from isisLSPSummaryTable.
// OID tail: col.instLen[.instChars*].lspLevel.b1.b2.b3.b4.b5.b6.b7.b8 (8-byte LSP ID, fixed-size)
func splitISISLSPIndex(pduName, tableOID string) (col, level int, lspID string, instance string, ok bool) {
	parts, sok := isisStripBase(pduName, tableOID)
	if !sok || len(parts) < 10 {
		return -1, 0, "", "", false
	}
	col, _ = strconv.Atoi(parts[0])
	inst, skip := isisParseInstance(parts[1:])
	if skip < 0 || len(parts) < 2+skip+9 {
		return -1, 0, "", "", false
	}
	level, _ = strconv.Atoi(parts[2+skip])
	b := make([]byte, 8)
	for i := 0; i < 8; i++ {
		v, e := strconv.Atoi(parts[2+skip+1+i])
		if e != nil {
			return -1, 0, "", "", false
		}
		b[i] = byte(v)
	}
	return col, level, isisFormatLSPID(b), inst, true
}

// isisStripBase strips the table OID prefix and returns the remaining parts.
func isisStripBase(pduName, tableOID string) ([]string, bool) {
	full := strings.TrimPrefix(pduName, ".")
	base := strings.TrimPrefix(tableOID, ".")
	if !strings.HasPrefix(full, base+".") {
		return nil, false
	}
	return strings.Split(full[len(base)+1:], "."), true
}

// isisParseInstance reads the length-prefixed OctetString instance from OID parts.
// Returns (instance string, number of parts consumed after the length byte).
// parts[0] is the length integer.
func isisParseInstance(parts []string) (string, int) {
	if len(parts) == 0 {
		return "", -1
	}
	instLen, err := strconv.Atoi(parts[0])
	if err != nil || instLen < 0 || len(parts) < 1+instLen {
		return "", -1
	}
	b := make([]byte, instLen)
	for i := 0; i < instLen; i++ {
		v, e := strconv.Atoi(parts[1+i])
		if e != nil {
			return "", -1
		}
		b[i] = byte(v)
	}
	// consumed parts[0] (length) + instLen chars = instLen chars after the length byte
	return string(b), instLen
}

// ── PDU value helpers ─────────────────────────────────────────────────────────

// isisIPFromPDU decodes an InetAddress PDU value to a dotted or colon notation string.
func isisIPFromPDU(pdu gosnmp.SnmpPDU) string {
	b, ok := pdu.Value.([]byte)
	if !ok {
		return ""
	}
	switch len(b) {
	case 4:
		return fmt.Sprintf("%d.%d.%d.%d", b[0], b[1], b[2], b[3])
	case 16:
		return net.IP(b).String()
	}
	return ""
}

// isisFormatSysID converts a 6-byte IS-IS system-id PDU value to "xxxx.xxxx.xxxx" notation.
func isisFormatSysID(pdu gosnmp.SnmpPDU) string {
	b, ok := pdu.Value.([]byte)
	if !ok || len(b) != 6 {
		return ""
	}
	return fmt.Sprintf("%02x%02x.%02x%02x.%02x%02x", b[0], b[1], b[2], b[3], b[4], b[5])
}

// isisFormatAreaAddr renders an ISO area address as dotted hex groups, e.g.
// bytes [0x49,0x00,0x01] -> "49.0001" (AFI byte, then 2-byte groups).
func isisFormatAreaAddr(b []byte) string {
	if len(b) == 0 {
		return ""
	}
	parts := []string{fmt.Sprintf("%02x", b[0])}
	rest := b[1:]
	for i := 0; i < len(rest); i += 2 {
		if i+2 <= len(rest) {
			parts = append(parts, fmt.Sprintf("%02x%02x", rest[i], rest[i+1]))
		} else {
			parts = append(parts, fmt.Sprintf("%02x", rest[i]))
		}
	}
	return strings.Join(parts, ".")
}

// isisFormatDIS renders the 7-byte LAN-DIS ID (isisCircLevelDesIS) as
// "xxxx.xxxx.xxxx.NN", or "" if no DIS has been elected (all-zero/empty).
func isisFormatDIS(b []byte) string {
	if len(b) != 7 {
		return ""
	}
	for _, v := range b {
		if v != 0 {
			return fmt.Sprintf("%02x%02x.%02x%02x.%02x%02x.%02x", b[0], b[1], b[2], b[3], b[4], b[5], b[6])
		}
	}
	return ""
}

// isisFormatLSPID renders an 8-byte LSP ID as "xxxx.xxxx.xxxx.NN-NN":
// 6-byte system ID, 1-byte pseudonode ID, 1-byte LSP fragment number.
func isisFormatLSPID(b []byte) string {
	if len(b) != 8 {
		return ""
	}
	return fmt.Sprintf("%02x%02x.%02x%02x.%02x%02x.%02x-%02x", b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7])
}

// isisCircLevelName converts an isisCircLevelIndex/isisLSPLevel value (1 or 2)
// to its level name.
func isisCircLevelName(level int) string {
	switch level {
	case 1:
		return "level-1"
	case 2:
		return "level-2"
	default:
		return "unknown"
	}
}

func isisLevelName(usage int) string {
	switch usage {
	case 2:
		return "level-1"
	case 3:
		return "level-2"
	case 4:
		return "level-1-2"
	default:
		return "unknown" // 1=undefined (adjacency still initializing)
	}
}

func isisAdjStateName(state int) string {
	switch state {
	case 1:
		return "down"
	case 2:
		return "initializing"
	case 3:
		return "up"
	case 4:
		return "failed"
	default:
		return "unknown"
	}
}
