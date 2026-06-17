package poller

import (
	"encoding/hex"
	"fmt"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/rs/zerolog/log"
	"github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/client"
	"github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/model"
	"github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/oid"
)

// ── LLDP ─────────────────────────────────────────────────────────────────────

// PollLLDPNeighbors walks lldpRemTable + lldpLocPortTable + lldpRemManAddrTable.
// Tries the IEEE OID namespace first (1.0.8802), falls back to IETF (1.3.6.1.2.1.111).
func PollLLDPNeighbors(s *client.Session, deviceID uuid.UUID) ([]*model.LLDPNeighbor, error) {
	neighbors, found, err := pollLLDPNS(s, deviceID, oid.LLDPRemTableIEEE, oid.LLDPLocPortIEEE, oid.LLDPRemManAddrIEEE)
	if err != nil {
		return nil, err
	}
	if found {
		return neighbors, nil
	}
	neighbors, _, err = pollLLDPNS(s, deviceID, oid.LLDPRemTableIETF, oid.LLDPLocPortIETF, oid.LLDPRemManAddrIETF)
	if err != nil {
		return nil, err
	}
	// Return non-nil empty slice to signal "poll ran, no neighbors" so the
	// writer can prune stale rows.  nil means "poll did not run / SNMP failed".
	if neighbors == nil {
		neighbors = []*model.LLDPNeighbor{}
	}
	return neighbors, nil
}

func pollLLDPNS(s *client.Session, deviceID uuid.UUID, remBase, locBase, manBase string) ([]*model.LLDPNeighbor, bool, error) {
	remPDUs, err := s.BulkWalkAll(remBase)
	if err != nil {
		return nil, false, err
	}
	if len(remPDUs) == 0 {
		return nil, false, nil
	}

	locPDUs, _ := s.BulkWalkAll(locBase)
	manPDUs, _ := s.BulkWalkAll(manBase)

	// portNum → local port name.
	// Col 4 = lldpLocPortDesc (ifName) — preferred.
	// Col 3 = lldpLocPortId — fallback (used by ProCurve/Aruba which omit col 4).
	portNames := make(map[int]string)
	for _, pdu := range locPDUs {
		col, idx := splitLLDPLocIndex(pdu.Name, locBase)
		if idx <= 0 {
			continue
		}
		val := client.PDUString(pdu)
		if val == "" {
			continue
		}
		switch col {
		case 4:
			portNames[idx] = val // preferred — overwrite col 3 if already set
		case 3:
			if portNames[idx] == "" {
				portNames[idx] = val // fallback only
			}
		}
	}

	// management address index → first IPv4 ("portNum.remIdx" → IP)
	mgmtByKey := make(map[string]string)
	for _, pdu := range manPDUs {
		ip, portNum, remIdx := parseLLDPManAddrIndex(pdu.Name, manBase)
		if ip != "" {
			k := fmt.Sprintf("%d.%d", portNum, remIdx)
			if _, exists := mgmtByKey[k]; !exists {
				mgmtByKey[k] = ip
			}
		}
	}

	type rowKey struct{ portNum, remIdx int }
	type row struct {
		chassisSub int
		chassisID  []byte
		portSub    int
		portID     []byte
		portDesc   string
		sysName    string
		capEnabled []byte
	}
	rows := make(map[rowKey]*row)
	ensure := func(k rowKey) *row {
		if r, ok := rows[k]; ok {
			return r
		}
		r := &row{}
		rows[k] = r
		return r
	}

	for _, pdu := range remPDUs {
		col, _, portNum, remIdx := splitLLDPRemIndex(pdu.Name, remBase)
		if col < 0 {
			continue
		}
		k := rowKey{portNum, remIdx}
		r := ensure(k)
		switch col {
		case 4:
			r.chassisSub = client.PDUInt(pdu)
		case 5:
			if b, ok := pdu.Value.([]byte); ok {
				r.chassisID = b
			} else {
				r.chassisID = []byte(client.PDUString(pdu))
			}
		case 6:
			r.portSub = client.PDUInt(pdu)
		case 7:
			if b, ok := pdu.Value.([]byte); ok {
				r.portID = b
			} else {
				r.portID = []byte(client.PDUString(pdu))
			}
		case 8:
			r.portDesc = client.PDUString(pdu)
		case 9:
			r.sysName = client.PDUString(pdu)
		case 12:
			if b, ok := pdu.Value.([]byte); ok {
				r.capEnabled = b
			}
		}
	}

	results := make([]*model.LLDPNeighbor, 0, len(rows))
	for k, r := range rows {
		local := portNames[k.portNum]
		if local == "" {
			local = strconv.Itoa(k.portNum)
		}
		results = append(results, &model.LLDPNeighbor{
			DeviceID:         deviceID,
			LocalPort:        local,
			ChassisIDSubtype: lldpChassisSubtypeName(r.chassisSub),
			ChassisID:        formatLLDPID(r.chassisSub, r.chassisID),
			PortIDSubtype:    lldpPortSubtypeName(r.portSub),
			PortID:           formatLLDPID(r.portSub, r.portID),
			PortDesc:         r.portDesc,
			SystemName:       r.sysName,
			MgmtIP:           mgmtByKey[fmt.Sprintf("%d.%d", k.portNum, k.remIdx)],
			Capabilities:     parseLLDPCapabilities(r.capEnabled),
		})
	}
	return results, true, nil
}

// splitLLDPRemIndex parses col, timeMark, portNum, remIndex from the PDU name.
func splitLLDPRemIndex(pduName, base string) (col, timeMark, portNum, remIdx int) {
	full := strings.TrimPrefix(pduName, ".")
	b := strings.TrimPrefix(base, ".")
	if !strings.HasPrefix(full, b+".") {
		return -1, -1, -1, -1
	}
	parts := strings.SplitN(full[len(b)+1:], ".", 4)
	if len(parts) < 4 {
		return -1, -1, -1, -1
	}
	c, _ := strconv.Atoi(parts[0])
	tm, _ := strconv.Atoi(parts[1])
	pn, _ := strconv.Atoi(parts[2])
	ri, _ := strconv.Atoi(parts[3])
	return c, tm, pn, ri
}

// splitLLDPLocIndex parses col, portNum from the lldpLocPortTable PDU name.
func splitLLDPLocIndex(pduName, base string) (col, portNum int) {
	full := strings.TrimPrefix(pduName, ".")
	b := strings.TrimPrefix(base, ".")
	if !strings.HasPrefix(full, b+".") {
		return -1, -1
	}
	parts := strings.SplitN(full[len(b)+1:], ".", 2)
	if len(parts) < 2 {
		return -1, -1
	}
	c, _ := strconv.Atoi(parts[0])
	pn, _ := strconv.Atoi(parts[1])
	return c, pn
}

// parseLLDPManAddrIndex extracts the first IPv4 address embedded in the OID index.
// Index suffix: col.timeMark.portNum.remIndex.addrSubtype.addrLen.a.b.c.d
func parseLLDPManAddrIndex(pduName, base string) (ip string, portNum, remIdx int) {
	full := strings.TrimPrefix(pduName, ".")
	b := strings.TrimPrefix(base, ".")
	if !strings.HasPrefix(full, b+".") {
		return "", 0, 0
	}
	parts := strings.Split(full[len(b)+1:], ".")
	// col(0) . timeMark(1) . portNum(2) . remIdx(3) . addrSubtype(4) . addrLen(5) . addr(6+)
	if len(parts) < 10 {
		return "", 0, 0
	}
	pn, _ := strconv.Atoi(parts[2])
	ri, _ := strconv.Atoi(parts[3])
	addrSubtype, _ := strconv.Atoi(parts[4])
	addrLen, _ := strconv.Atoi(parts[5])
	if addrSubtype == 1 && addrLen == 4 && len(parts) >= 10 {
		ip = strings.Join(parts[6:10], ".")
	}
	return ip, pn, ri
}

func lldpChassisSubtypeName(v int) string {
	switch v {
	case 1:
		return "chassisComponent"
	case 2:
		return "interfaceAlias"
	case 3:
		return "portComponent"
	case 4:
		return "macAddress"
	case 5:
		return "networkAddress"
	case 6:
		return "interfaceName"
	case 7:
		return "local"
	default:
		return "unknown"
	}
}

func lldpPortSubtypeName(v int) string {
	switch v {
	case 1:
		return "interfaceAlias"
	case 2:
		return "portComponent"
	case 3:
		return "macAddress"
	case 4:
		return "networkAddress"
	case 5:
		return "interfaceName"
	case 6:
		return "agentCircuitId"
	case 7:
		return "local"
	default:
		return "unknown"
	}
}

// formatLLDPID renders a chassis/port ID bytes based on subtype.
// MAC subtypes (3=macAddress for port, 4=macAddress for chassis) → "aa:bb:cc:dd:ee:ff".
func formatLLDPID(subtype int, b []byte) string {
	if len(b) == 0 {
		return ""
	}
	if (subtype == 4 || subtype == 3) && len(b) == 6 {
		return fmt.Sprintf("%s:%s:%s:%s:%s:%s",
			hex.EncodeToString(b[0:1]), hex.EncodeToString(b[1:2]),
			hex.EncodeToString(b[2:3]), hex.EncodeToString(b[3:4]),
			hex.EncodeToString(b[4:5]), hex.EncodeToString(b[5:6]),
		)
	}
	s := strings.TrimSpace(string(b))
	for _, c := range s {
		if c < 0x20 || c > 0x7e {
			return hex.EncodeToString(b)
		}
	}
	return s
}

// parseLLDPCapabilities decodes the 2-byte BITS capability field (RFC 802.1AB).
// BITS type is MSB-first: bit 0 = 0x80, bit 1 = 0x40, etc.
func parseLLDPCapabilities(b []byte) []string {
	if len(b) == 0 {
		return nil
	}
	caps := []struct {
		mask byte
		name string
	}{
		{0x80, "other"},
		{0x40, "switch"},
		{0x20, "bridge"},
		{0x10, "wlanAccessPoint"},
		{0x08, "router"},
		{0x04, "telephone"},
		{0x02, "docsisCableDevice"},
		{0x01, "stationOnly"},
	}
	var out []string
	for _, cap := range caps {
		if b[0]&cap.mask != 0 {
			out = append(out, cap.name)
		}
	}
	return out
}

// ── CDP ───────────────────────────────────────────────────────────────────────

// PollCDPNeighbors walks cdpCacheTable (Cisco-proprietary).
// ifByIndex maps ifIndex → ifName, built from the interface poll in the same cycle.
func PollCDPNeighbors(s *client.Session, deviceID uuid.UUID, ifByIndex map[int]string) ([]*model.CDPNeighbor, error) {
	pdus, err := s.BulkWalkAll(oid.CDPCacheTable)
	if err != nil {
		return nil, err
	}
	if len(pdus) == 0 {
		log.Debug().Str("device_id", deviceID.String()).Msg("cdp: cdpCacheTable empty (CDP not enabled, or no neighbors)")
		// Successful poll, no CDP neighbors.  Non-nil empty slice signals the
		// writer to prune stale rows (nil would mean "poll did not run").
		return []*model.CDPNeighbor{}, nil
	}

	type rowKey struct{ ifIdx, devIdx int }
	type row struct {
		addresses  []byte
		deviceID   string
		devicePort string
		platform   string
		caps       []byte
		nativeVLAN int
		duplex     int
	}
	rows := make(map[rowKey]*row)
	ensure := func(k rowKey) *row {
		if r, ok := rows[k]; ok {
			return r
		}
		r := &row{}
		rows[k] = r
		return r
	}

	for _, pdu := range pdus {
		col, ifIdx, devIdx := splitCDPIndex(pdu.Name)
		if col < 0 {
			continue
		}
		k := rowKey{ifIdx, devIdx}
		r := ensure(k)
		// CISCO-CDP-MIB cdpCacheEntry columns: 3=AddressType, 4=Address,
		// 5=Version, 6=DeviceId, 7=DevicePort, 8=Platform, 9=Capabilities,
		// 10=VTPMgmtDomain, 11=NativeVLAN, 12=Duplex.
		switch col {
		case 4:
			if b, ok := pdu.Value.([]byte); ok {
				r.addresses = b
			}
		case 6:
			r.deviceID = client.PDUString(pdu)
		case 7:
			r.devicePort = client.PDUString(pdu)
		case 8:
			r.platform = client.PDUString(pdu)
		case 9:
			if b, ok := pdu.Value.([]byte); ok {
				r.caps = b
			}
		case 11:
			r.nativeVLAN = client.PDUInt(pdu)
		case 12:
			r.duplex = client.PDUInt(pdu)
		}
	}

	results := make([]*model.CDPNeighbor, 0, len(rows))
	for k, r := range rows {
		localPort := ifByIndex[k.ifIdx]
		if localPort == "" {
			localPort = strconv.Itoa(k.ifIdx)
		}
		results = append(results, &model.CDPNeighbor{
			DeviceID:     deviceID,
			LocalPort:    localPort,
			RemoteDevice: r.deviceID,
			RemotePort:   r.devicePort,
			MgmtIP:       parseCDPAddresses(r.addresses),
			Platform:     r.platform,
			Capabilities: parseCDPCapabilities(r.caps),
			NativeVLAN:   r.nativeVLAN,
			Duplex:       cdpDuplexName(r.duplex),
		})
	}
	log.Debug().Str("device_id", deviceID.String()).Int("cdp_neighbors", len(results)).Msg("cdp: cdpCacheTable parsed")
	return results, nil
}

// splitCDPIndex extracts column, ifIndex, deviceIndex from a cdpCacheTable PDU name.
func splitCDPIndex(pduName string) (col, ifIdx, devIdx int) {
	full := strings.TrimPrefix(pduName, ".")
	base := strings.TrimPrefix(oid.CDPCacheTable, ".")
	if !strings.HasPrefix(full, base+".") {
		return -1, -1, -1
	}
	parts := strings.SplitN(full[len(base)+1:], ".", 3)
	if len(parts) < 3 {
		return -1, -1, -1
	}
	c, _ := strconv.Atoi(parts[0])
	i, _ := strconv.Atoi(parts[1])
	d, _ := strconv.Atoi(parts[2])
	return c, i, d
}

// parseCDPAddresses extracts the first IPv4 from the cdpCacheAddresses OCTET STRING.
// Format: 4-byte count | (1B protoType, 1B protoLen, N bytes proto, 2B addrLen, M bytes addr)…
func parseCDPAddresses(b []byte) string {
	if len(b) < 4 {
		return ""
	}
	pos := 4 // skip 4-byte count
	for pos < len(b) {
		if pos+2 > len(b) {
			break
		}
		protoType := b[pos]
		protoLen := int(b[pos+1])
		pos += 2 + protoLen
		if pos+2 > len(b) {
			break
		}
		addrLen := int(b[pos])<<8 | int(b[pos+1])
		pos += 2
		if pos+addrLen > len(b) {
			break
		}
		addr := b[pos : pos+addrLen]
		pos += addrLen
		// IPv4: protoType=1 (NLPID), proto byte=0xCC, addrLen=4
		if protoType == 1 && addrLen == 4 {
			return fmt.Sprintf("%d.%d.%d.%d", addr[0], addr[1], addr[2], addr[3])
		}
	}
	return ""
}

func parseCDPCapabilities(b []byte) []string {
	if len(b) == 0 {
		return nil
	}
	var cap32 uint32
	for i := 0; i < len(b) && i < 4; i++ {
		cap32 = (cap32 << 8) | uint32(b[i])
	}
	bits := []struct {
		mask uint32
		name string
	}{
		{0x01, "router"}, {0x02, "trans-bridge"}, {0x04, "source-route-bridge"},
		{0x08, "switch"}, {0x10, "host"}, {0x20, "igmp"}, {0x40, "repeater"},
	}
	var out []string
	for _, bit := range bits {
		if cap32&bit.mask != 0 {
			out = append(out, bit.name)
		}
	}
	return out
}

func cdpDuplexName(v int) string {
	switch v {
	case 1:
		return "full"
	case 2:
		return "half"
	default:
		return ""
	}
}
