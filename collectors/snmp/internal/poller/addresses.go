package poller

import (
	"encoding/hex"
	"fmt"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/client"
	"github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/model"
	"github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/oid"
)

// PollARPTable walks ipNetToMediaTable and returns ARP entries.
// ifByIndex maps ifIndex → interface name for port resolution.
func PollARPTable(s *client.Session, deviceID uuid.UUID, ifByIndex map[int]string) ([]*model.ARPEntry, error) {
	pdus, err := s.BulkWalkAll(oid.ARPTable)
	if err != nil || len(pdus) == 0 {
		return nil, err
	}

	type rowKey struct{ ifIdx int; ip string }
	type row struct {
		mac       []byte
		ip        string
		entryType int
	}
	rows := make(map[rowKey]*row)
	ensure := func(k rowKey) *row {
		if r, ok := rows[k]; ok { return r }
		r := &row{}; rows[k] = r; return r
	}

	for _, pdu := range pdus {
		col, ifIdx, ip := splitARPIndex(pdu.Name)
		if col < 0 || ip == "" {
			continue
		}
		k := rowKey{ifIdx, ip}
		r := ensure(k)
		switch col {
		case 2: // ipNetToMediaPhysAddress
			if b, ok := pdu.Value.([]byte); ok {
				r.mac = b
			}
		case 3: // ipNetToMediaNetAddress
			r.ip = client.PDUString(pdu)
			if r.ip == "" {
				r.ip = ip // fall back to OID-embedded IP
			}
		case 4: // ipNetToMediaType
			r.entryType = client.PDUInt(pdu)
		}
	}

	results := make([]*model.ARPEntry, 0, len(rows))
	for k, r := range rows {
		if len(r.mac) != 6 || isZeroMAC(r.mac) {
			continue
		}
		if r.entryType == 2 { // invalid — skip
			continue
		}
		ip := r.ip
		if ip == "" {
			ip = k.ip
		}
		results = append(results, &model.ARPEntry{
			DeviceID:      deviceID,
			IPAddress:     ip,
			MACAddress:    formatMAC(r.mac),
			InterfaceName: ifByIndex[k.ifIdx],
			EntryType:     arpTypeName(r.entryType),
		})
	}
	return results, nil
}

// splitARPIndex parses col, ifIndex, and dotted-IP from an ipNetToMediaTable PDU name.
// OID suffix after table root: col.ifIndex.a.b.c.d
func splitARPIndex(pduName string) (col, ifIdx int, ip string) {
	full := strings.TrimPrefix(pduName, ".")
	base := strings.TrimPrefix(oid.ARPTable, ".")
	if !strings.HasPrefix(full, base+".") {
		return -1, -1, ""
	}
	parts := strings.Split(full[len(base)+1:], ".")
	// parts[0]=col, parts[1]=ifIndex, parts[2..5]=IP octets
	if len(parts) < 6 {
		return -1, -1, ""
	}
	c, _ := strconv.Atoi(parts[0])
	i, _ := strconv.Atoi(parts[1])
	ipStr := strings.Join(parts[2:6], ".")
	return c, i, ipStr
}

func arpTypeName(v int) string {
	switch v {
	case 3: return "dynamic"
	case 4: return "static"
	default: return "other"
	}
}

// PollMACTable walks dot1dTpFdbTable and dot1dBasePortTable, resolves
// bridge port numbers to interface names, and returns MAC forwarding entries.
func PollMACTable(s *client.Session, deviceID uuid.UUID, ifByIndex map[int]string) ([]*model.MACEntry, error) {
	// Build bridge port → ifIndex map first.
	portPDUs, err := s.BulkWalkAll(oid.MACPortTable)
	if err != nil {
		return nil, err
	}
	bridgePortToIfIdx := make(map[int]int)
	for _, pdu := range portPDUs {
		col, portNum := splitBridgePortIndex(pdu.Name)
		if col == 2 && portNum > 0 { // dot1dBasePortIfIndex
			bridgePortToIfIdx[portNum] = client.PDUInt(pdu)
		}
	}

	fdbPDUs, err := s.BulkWalkAll(oid.MACFdbTable)
	if err != nil || len(fdbPDUs) == 0 {
		return nil, err
	}

	type row struct {
		mac       [6]byte
		bridgePort int
		status    int
	}
	rows := make(map[[6]byte]*row)
	ensure := func(mac [6]byte) *row {
		if r, ok := rows[mac]; ok { return r }
		r := &row{mac: mac}; rows[mac] = r; return r
	}

	for _, pdu := range fdbPDUs {
		col, mac, ok := splitMACFdbIndex(pdu.Name)
		if !ok {
			continue
		}
		r := ensure(mac)
		switch col {
		case 2: r.bridgePort = client.PDUInt(pdu)
		case 3: r.status = client.PDUInt(pdu)
		}
	}

	// dot1dTpFdbTable (above) only covers the default/native VLAN on most
	// VLAN-aware bridges. dot1qTpFdbTable (Q-BRIDGE-MIB) covers every VLAN's
	// FDB in one walk and uses the same dot1dBasePort numbering, so merge it
	// in — it's what fills in end-device ports on tagged-VLAN access ports.
	if qPDUs, err := s.BulkWalkAll(oid.Dot1qTpFdbTable); err == nil {
		for _, pdu := range qPDUs {
			col, mac, ok := splitDot1qFdbIndex(pdu.Name)
			if !ok {
				continue
			}
			r := ensure(mac)
			switch col {
			case 2: // dot1qTpFdbPort — 0 means "not learned", don't clobber
				if p := client.PDUInt(pdu); p > 0 {
					r.bridgePort = p
				}
			case 3: // dot1qTpFdbStatus — don't let an invalid row on an
				// unrelated VLAN mark an otherwise-valid entry invalid
				if v := client.PDUInt(pdu); v != 2 {
					r.status = v
				}
			}
		}
	}

	results := make([]*model.MACEntry, 0, len(rows))
	for mac, r := range rows {
		if r.status == 2 { // invalid
			continue
		}
		if isZeroMAC(mac[:]) {
			continue
		}
		portName := ""
		if ifIdx, ok := bridgePortToIfIdx[r.bridgePort]; ok {
			portName = ifByIndex[ifIdx]
		}
		results = append(results, &model.MACEntry{
			DeviceID:   deviceID,
			MACAddress: formatMAC(mac[:]),
			PortName:   portName,
			EntryType:  macStatusName(r.status),
		})
	}
	return results, nil
}

// splitBridgePortIndex parses col and portNum from a dot1dBasePortTable PDU name.
func splitBridgePortIndex(pduName string) (col, portNum int) {
	full := strings.TrimPrefix(pduName, ".")
	base := strings.TrimPrefix(oid.MACPortTable, ".")
	if !strings.HasPrefix(full, base+".") {
		return -1, -1
	}
	parts := strings.SplitN(full[len(base)+1:], ".", 2)
	if len(parts) < 2 {
		return -1, -1
	}
	c, _ := strconv.Atoi(parts[0])
	p, _ := strconv.Atoi(parts[1])
	return c, p
}

// splitMACFdbIndex parses col and MAC (as [6]byte) from a dot1dTpFdbTable PDU name.
// OID suffix: col.a.b.c.d.e.f (6 decimal octets).
func splitMACFdbIndex(pduName string) (col int, mac [6]byte, ok bool) {
	full := strings.TrimPrefix(pduName, ".")
	base := strings.TrimPrefix(oid.MACFdbTable, ".")
	if !strings.HasPrefix(full, base+".") {
		return 0, mac, false
	}
	parts := strings.Split(full[len(base)+1:], ".")
	if len(parts) < 7 {
		return 0, mac, false
	}
	c, err := strconv.Atoi(parts[0])
	if err != nil {
		return 0, mac, false
	}
	for i := 0; i < 6; i++ {
		v, err := strconv.Atoi(parts[i+1])
		if err != nil || v < 0 || v > 255 {
			return 0, mac, false
		}
		mac[i] = byte(v)
	}
	return c, mac, true
}

// splitDot1qFdbIndex parses col and MAC (as [6]byte) from a dot1qTpFdbTable
// PDU name. OID suffix: col.fdbId.a.b.c.d.e.f (fdbId + 6 decimal MAC octets).
func splitDot1qFdbIndex(pduName string) (col int, mac [6]byte, ok bool) {
	full := strings.TrimPrefix(pduName, ".")
	base := strings.TrimPrefix(oid.Dot1qTpFdbTable, ".")
	if !strings.HasPrefix(full, base+".") {
		return 0, mac, false
	}
	parts := strings.Split(full[len(base)+1:], ".")
	if len(parts) < 8 {
		return 0, mac, false
	}
	c, err := strconv.Atoi(parts[0])
	if err != nil {
		return 0, mac, false
	}
	// parts[1] = dot1qFdbId (unused — bridge-port numbering is FDB-independent)
	for i := 0; i < 6; i++ {
		v, err := strconv.Atoi(parts[i+2])
		if err != nil || v < 0 || v > 255 {
			return 0, mac, false
		}
		mac[i] = byte(v)
	}
	return c, mac, true
}

func macStatusName(v int) string {
	switch v {
	case 3: return "learned"
	case 4: return "self"
	case 5: return "static"
	default: return "other"
	}
}

func formatMAC(b []byte) string {
	if len(b) != 6 {
		return hex.EncodeToString(b)
	}
	return fmt.Sprintf("%02x:%02x:%02x:%02x:%02x:%02x",
		b[0], b[1], b[2], b[3], b[4], b[5])
}

func isZeroMAC(b []byte) bool {
	for _, v := range b {
		if v != 0 { return false }
	}
	return true
}
