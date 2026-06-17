package poller

import (
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/client"
	"github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/model"
	"github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/oid"
)

// PollInterfaces walks ifTable and ifXTable, merges the results by ifIndex,
// and returns one InterfaceResult per interface. HC (64-bit) counters from
// ifXTable take precedence over 32-bit ifTable counters when both are present.
//
// sysUpTimeTicks is the device's current sysUpTime in hundredths of a second,
// used to convert ifLastChange timeticks to an absolute UTC timestamp.
func PollInterfaces(s *client.Session, deviceID uuid.UUID, sysUpTimeTicks uint32) ([]*model.InterfaceResult, error) {
	// Walk both tables in parallel via two separate calls. For devices that
	// don't support ifXTable we get an empty slice — not an error.
	ifPDUs, err := s.BulkWalkAll(oid.IfTable)
	if err != nil {
		return nil, fmt.Errorf("walk ifTable: %w", err)
	}
	ifxPDUs, err := s.BulkWalkAll(oid.IfXTable)
	if err != nil {
		return nil, fmt.Errorf("walk ifXTable: %w", err)
	}

	now := time.Now().UTC()

	// Build intermediate maps keyed by ifIndex (integer).
	type ifRow struct {
		// ifTable fields
		descr       string
		ifType      int
		mtu         int
		speed       uint64 // ifSpeed bps (32-bit, unreliable for >1G)
		physAddr    string
		adminStatus int
		operStatus  int
		lastChange  uint32 // timeticks
		inOctets    uint64
		inUcastPkts uint64
		inDiscards  uint64
		inErrors    uint64
		outOctets   uint64
		outUcastPkts uint64
		outDiscards  uint64
		outErrors    uint64

		// ifXTable fields (preferred)
		name          string
		alias         string
		highSpeed     uint64 // ifHighSpeed Mbps
		hcInOctets    uint64
		hcInUcastPkts uint64
		hcOutOctets   uint64
		hcOutUcastPkts uint64
	}

	rows := make(map[int]*ifRow)
	ensure := func(idx int) *ifRow {
		if r, ok := rows[idx]; ok {
			return r
		}
		r := &ifRow{}
		rows[idx] = r
		return r
	}

	// Process ifTable PDUs.
	for _, pdu := range ifPDUs {
		col, idx := splitTableOID(pdu.Name, oid.IfTable)
		if idx < 0 {
			continue
		}
		r := ensure(idx)
		switch col {
		case 2:
			r.descr = client.PDUString(pdu)
		case 3:
			r.ifType = client.PDUInt(pdu)
		case 4:
			r.mtu = client.PDUInt(pdu)
		case 5:
			r.speed = client.PDUUint64(pdu)
		case 6:
			r.physAddr = client.PDUMACAddress(pdu)
		case 7:
			r.adminStatus = client.PDUInt(pdu)
		case 8:
			r.operStatus = client.PDUInt(pdu)
		case 9:
			r.lastChange = uint32(client.PDUUint64(pdu))
		case 10:
			r.inOctets = client.PDUUint64(pdu)
		case 11:
			r.inUcastPkts = client.PDUUint64(pdu)
		case 13:
			r.inDiscards = client.PDUUint64(pdu)
		case 14:
			r.inErrors = client.PDUUint64(pdu)
		case 16:
			r.outOctets = client.PDUUint64(pdu)
		case 17:
			r.outUcastPkts = client.PDUUint64(pdu)
		case 19:
			r.outDiscards = client.PDUUint64(pdu)
		case 20:
			r.outErrors = client.PDUUint64(pdu)
		}
	}

	// Process ifXTable PDUs.
	for _, pdu := range ifxPDUs {
		col, idx := splitTableOID(pdu.Name, oid.IfXTable)
		if idx < 0 {
			continue
		}
		r := ensure(idx)
		switch col {
		case 1:
			r.name = client.PDUString(pdu)
		case 6:
			r.hcInOctets = client.PDUUint64(pdu)
		case 7:
			r.hcInUcastPkts = client.PDUUint64(pdu)
		case 10:
			r.hcOutOctets = client.PDUUint64(pdu)
		case 11:
			r.hcOutUcastPkts = client.PDUUint64(pdu)
		case 15:
			r.highSpeed = client.PDUUint64(pdu)
		case 18:
			r.alias = client.PDUString(pdu)
		}
	}

	// Merge into result structs.
	results := make([]*model.InterfaceResult, 0, len(rows))
	for ifIdx, r := range rows {
		res := &model.InterfaceResult{
			DeviceID:    deviceID,
			IfIndex:     ifIdx,
			IfDescr:     r.descr,
			IfName:      r.name,
			IfAlias:     r.alias,
			IfType:      oid.IfTypeName(r.ifType),
			MTU:         r.mtu,
			MACAddress:  r.physAddr,
			AdminStatus: ifStatusName(r.adminStatus),
			OperStatus:  ifOperStatusName(r.operStatus),
			PollTime:    now,
		}

		// Speed: prefer ifHighSpeed (Mbps → bps) when available.
		if r.highSpeed > 0 {
			res.SpeedBPS = r.highSpeed * 1_000_000
		} else {
			res.SpeedBPS = r.speed
		}

		// Counters: prefer HC 64-bit; fall back to 32-bit when HC is zero
		// (some devices populate HC only once counters exceed 32-bit range).
		res.InOctets = pickCounter(r.hcInOctets, r.inOctets)
		res.InUcastPkts = pickCounter(r.hcInUcastPkts, r.inUcastPkts)
		res.InDiscards = r.inDiscards
		res.InErrors = r.inErrors
		res.OutOctets = pickCounter(r.hcOutOctets, r.outOctets)
		res.OutUcastPkts = pickCounter(r.hcOutUcastPkts, r.outUcastPkts)
		res.OutDiscards = r.outDiscards
		res.OutErrors = r.outErrors

		// Convert ifLastChange timeticks to UTC timestamp.
		// ifLastChange is the sysUpTime value at the time of the last change.
		// boot_time = now - sysUpTime/100s
		// last_change_time = boot_time + ifLastChange/100s
		if r.lastChange > 0 && sysUpTimeTicks > 0 {
			bootTime := now.Add(-time.Duration(sysUpTimeTicks) * 10 * time.Millisecond)
			res.LastChange = bootTime.Add(time.Duration(r.lastChange) * 10 * time.Millisecond)
		}

		results = append(results, res)
	}

	// Populate IP addresses from ipAddrTable (ifIndex → IPs).
	ipMap, _ := pollIPAddrTable(s)
	for _, res := range results {
		if ips, ok := ipMap[res.IfIndex]; ok {
			res.IPAddresses = ips
		}
	}

	return results, nil
}

// PollInterfaceState fetches only admin/oper status and naming fields — no
// counters. It walks the individual column subtrees rather than full ifTable/
// ifXTable, which is cheaper at the higher state-ticker cadence (15 s).
func PollInterfaceState(s *client.Session, deviceID uuid.UUID) ([]*model.InterfaceResult, error) {
	type row struct {
		descr       string
		ifType      int
		mtu         int
		speed       uint64
		adminStatus int
		operStatus  int
		name        string
		alias       string
		highSpeed   uint64
	}
	rows := make(map[int]*row)
	ensure := func(idx int) *row {
		if r, ok := rows[idx]; ok {
			return r
		}
		r := &row{}
		rows[idx] = r
		return r
	}

	// IfDescr (ifTable.2)
	if pdus, err := s.BulkWalkAll(oid.IfDescr); err == nil {
		for _, pdu := range pdus {
			_, idx := splitTableOID(pdu.Name, oid.IfDescr)
			if idx >= 0 {
				ensure(idx).descr = client.PDUString(pdu)
			}
		}
	}
	// IfType (ifTable.3)
	if pdus, err := s.BulkWalkAll(oid.IfType); err == nil {
		for _, pdu := range pdus {
			_, idx := splitTableOID(pdu.Name, oid.IfType)
			if idx >= 0 {
				ensure(idx).ifType = client.PDUInt(pdu)
			}
		}
	}
	// IfMtu (ifTable.4)
	if pdus, err := s.BulkWalkAll(oid.IfMtu); err == nil {
		for _, pdu := range pdus {
			_, idx := splitTableOID(pdu.Name, oid.IfMtu)
			if idx >= 0 {
				ensure(idx).mtu = client.PDUInt(pdu)
			}
		}
	}
	// IfSpeed (ifTable.5)
	if pdus, err := s.BulkWalkAll(oid.IfSpeed); err == nil {
		for _, pdu := range pdus {
			_, idx := splitTableOID(pdu.Name, oid.IfSpeed)
			if idx >= 0 {
				ensure(idx).speed = client.PDUUint64(pdu)
			}
		}
	}
	// IfAdminStatus (ifTable.7) — must succeed or the state poll is pointless
	pdus, err := s.BulkWalkAll(oid.IfAdminStatus)
	if err != nil {
		return nil, fmt.Errorf("walk IfAdminStatus: %w", err)
	}
	for _, pdu := range pdus {
		_, idx := splitTableOID(pdu.Name, oid.IfAdminStatus)
		if idx >= 0 {
			ensure(idx).adminStatus = client.PDUInt(pdu)
		}
	}
	// IfOperStatus (ifTable.8) — must succeed
	pdus, err = s.BulkWalkAll(oid.IfOperStatus)
	if err != nil {
		return nil, fmt.Errorf("walk IfOperStatus: %w", err)
	}
	for _, pdu := range pdus {
		_, idx := splitTableOID(pdu.Name, oid.IfOperStatus)
		if idx >= 0 {
			ensure(idx).operStatus = client.PDUInt(pdu)
		}
	}
	// IfName (ifXTable.1)
	if pdus, err := s.BulkWalkAll(oid.IfName); err == nil {
		for _, pdu := range pdus {
			_, idx := splitTableOID(pdu.Name, oid.IfName)
			if idx >= 0 {
				ensure(idx).name = client.PDUString(pdu)
			}
		}
	}
	// IfHighSpeed (ifXTable.15)
	if pdus, err := s.BulkWalkAll(oid.IfHighSpeed); err == nil {
		for _, pdu := range pdus {
			_, idx := splitTableOID(pdu.Name, oid.IfHighSpeed)
			if idx >= 0 {
				ensure(idx).highSpeed = client.PDUUint64(pdu)
			}
		}
	}
	// IfAlias (ifXTable.18)
	if pdus, err := s.BulkWalkAll(oid.IfAlias); err == nil {
		for _, pdu := range pdus {
			_, idx := splitTableOID(pdu.Name, oid.IfAlias)
			if idx >= 0 {
				ensure(idx).alias = client.PDUString(pdu)
			}
		}
	}

	now := time.Now().UTC()
	results := make([]*model.InterfaceResult, 0, len(rows))
	for ifIdx, r := range rows {
		res := &model.InterfaceResult{
			DeviceID:    deviceID,
			IfIndex:     ifIdx,
			IfDescr:     r.descr,
			IfName:      r.name,
			IfAlias:     r.alias,
			IfType:      oid.IfTypeName(r.ifType),
			MTU:         r.mtu,
			AdminStatus: ifStatusName(r.adminStatus),
			OperStatus:  ifOperStatusName(r.operStatus),
			PollTime:    now,
		}
		if r.highSpeed > 0 {
			res.SpeedBPS = r.highSpeed * 1_000_000
		} else {
			res.SpeedBPS = r.speed
		}
		results = append(results, res)
	}

	// Populate IP addresses.
	ipMap, _ := pollIPAddrTable(s)
	for _, res := range results {
		if ips, ok := ipMap[res.IfIndex]; ok {
			res.IPAddresses = ips
		}
	}

	return results, nil
}

// pollIPAddrTable walks ipAddrTable and returns a map of ifIndex → []InterfaceIP.
func pollIPAddrTable(s *client.Session) (map[int][]model.InterfaceIP, error) {
	pdus, err := s.BulkWalkAll(oid.IPAddrTable)
	if err != nil || len(pdus) == 0 {
		return nil, err
	}

	type row struct {
		ifIndex int
		mask    string
	}
	// keyed by IP address string
	rows := make(map[string]*row)
	ensureRow := func(ip string) *row {
		if r, ok := rows[ip]; ok { return r }
		r := &row{}; rows[ip] = r; return r
	}

	for _, pdu := range pdus {
		full := strings.TrimPrefix(pdu.Name, ".")
		base := strings.TrimPrefix(oid.IPAddrTable, ".")
		if !strings.HasPrefix(full, base+".") { continue }
		rest := full[len(base)+1:]
		parts := strings.SplitN(rest, ".", 2)
		if len(parts) < 2 { continue }
		col, _ := strconv.Atoi(parts[0])
		ipStr := parts[1]
		r := ensureRow(ipStr)
		switch col {
		case 2: r.ifIndex = client.PDUInt(pdu)
		case 3: r.mask = client.PDUString(pdu)
		}
	}

	result := make(map[int][]model.InterfaceIP)
	for ip, r := range rows {
		if r.ifIndex == 0 { continue }
		pl := maskToPrefixLen(r.mask)
		result[r.ifIndex] = append(result[r.ifIndex], model.InterfaceIP{
			Address:   ip,
			PrefixLen: pl,
			Version:   4,
		})
	}
	return result, nil
}

// maskToPrefixLen converts a dotted-decimal subnet mask to CIDR prefix length.
func maskToPrefixLen(mask string) int {
	parts := strings.Split(mask, ".")
	if len(parts) != 4 { return 0 }
	bits := 0
	for _, p := range parts {
		v, err := strconv.Atoi(p)
		if err != nil { break }
		b := uint8(v)
		for b != 0 {
			bits += int(b & 1)
			b >>= 1
		}
	}
	return bits
}

// splitTableOID extracts the column number and row index from a PDU OID.
// tableBase is the root OID of the table (e.g. "1.3.6.1.2.1.2.2.1" for ifTable).
// Returns col=-1 and idx=-1 if the OID doesn't match the table.
func splitTableOID(pduName, tableBase string) (col, idx int) {
	full := strings.TrimPrefix(pduName, ".")
	base := strings.TrimPrefix(tableBase, ".")

	if !strings.HasPrefix(full, base+".") {
		return -1, -1
	}
	rest := full[len(base)+1:] // e.g. "2.3" → col=2, idx=3

	parts := strings.SplitN(rest, ".", 2)
	if len(parts) != 2 {
		return -1, -1
	}

	c, err1 := strconv.Atoi(parts[0])
	i, err2 := strconv.Atoi(parts[1])
	if err1 != nil || err2 != nil {
		return -1, -1
	}
	return c, i
}

func ifStatusName(v int) string {
	switch v {
	case 1:
		return "up"
	case 2:
		return "down"
	case 3:
		return "testing"
	default:
		return "unknown"
	}
}

func ifOperStatusName(v int) string {
	switch v {
	case 1:
		return "up"
	case 2:
		return "down"
	case 3:
		return "testing"
	case 4:
		return "unknown"
	case 5:
		return "dormant"
	case 6:
		return "not_present"
	case 7:
		return "lower_layer_down"
	default:
		return "unknown"
	}
}

// pickCounter returns hc if non-zero, otherwise falls back to the 32-bit value.
func pickCounter(hc, fallback uint64) uint64 {
	if hc > 0 {
		return hc
	}
	return fallback
}

// formatIndex extracts the trailing index from an OID string.
// E.g. "1.3.6.1.2.1.99.1.1.1.4.17" with prefix "1.3.6.1.2.1.99.1.1.1.4"
// returns "17".
func formatIndex(pduName, prefix string) string {
	full := strings.TrimPrefix(pduName, ".")
	p := strings.TrimPrefix(prefix, ".")
	if !strings.HasPrefix(full, p+".") {
		return ""
	}
	return full[len(p)+1:]
}
