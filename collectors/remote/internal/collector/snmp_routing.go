package collector

import (
	"fmt"
	"net"
	"strconv"
	"strings"

	"github.com/gosnmp/gosnmp"
	"github.com/rs/zerolog"

	"github.com/purpledurpl075/anthri-mon/collectors/remote/internal/hub"
)

// This file ports BGP4-MIB, OSPF-MIB, and ISIS-MIB polling from the hub-local
// SNMP collector (collectors/snmp/internal/poller/{bgp,ospf,isis}.go) — the
// remote collector previously only had these for Arista (eAPI) and Aruba CX
// (REST); every SNMP-only vendor behind a remote collector had none. Record
// shapes match what eapi_arista.go/rest_aruba.go already send to the same
// hub endpoints (POST /collectors/bgp-sessions, /ospf-neighbors,
// /isis-neighbors), which is why the field names below aren't identical to
// the hub-local Go structs' field names.

const (
	oidBGPLocalAs   = "1.3.6.1.2.1.15.2.0"
	oidBGPPeerTable = "1.3.6.1.2.1.15.3.1"

	oidOSPFNbrTable = "1.3.6.1.2.1.14.10.1"
	oidOSPFIfTable  = "1.3.6.1.2.1.14.7.1"

	oidISISAdjTable = "1.3.6.1.2.1.138.1.6.1"
	// oid.ISISCircTable in the hub-local collector claims "1.3.6.1.2.1.138.1.3.1"
	// — confirmed live that's wrong too, it's a scalar (isisCircIndexNext).
	// The real table is one arc further: 1.3.6.1.2.1.138.1.3.2.
	oidISISCircTable  = "1.3.6.1.2.1.138.1.3.2"
	oidISISAdjIPTable = "1.3.6.1.2.1.138.1.6.2"
)

// routingIsVendorAPI reports whether BGP/OSPF/ISIS/route state for this
// device is authoritative from a vendor API rather than SNMP — Arista eAPI,
// Aruba CX REST, or (as of this file) Junos NETCONF. SNMP must not also post
// this data for these devices: two sources racing to upsert/mark-stale the
// same rows would fight each other on every poll cycle.
func routingIsVendorAPI(dev hub.Device) bool {
	return (dev.Vendor == "arista" && dev.EapiEnabled) ||
		(dev.Vendor == "aruba_cx" && dev.RestCollectionEnabled) ||
		(dev.Vendor == "juniper" && dev.NetconfEnabled)
}

// ─── BGP4-MIB ───────────────────────────────────────────────────────────────

// pollBGPSessions walks bgpPeerTable (RFC 1657) and returns records for
// POST /collectors/bgp-sessions.
func pollBGPSessions(g *gosnmp.GoSNMP, dev hub.Device, log zerolog.Logger) []map[string]any {
	var localASN int64
	if resp, err := g.Get([]string{oidBGPLocalAs}); err == nil && len(resp.Variables) > 0 {
		localASN = int64(pduUint64(resp.Variables[0]))
	}

	type row struct {
		state       int
		remoteASN   int64
		inUpdates   int64
		outUpdates  int64
		fsmTrans    int64
		established uint32
		estTicks    bool
	}
	rows := make(map[string]*row)
	ensure := func(ip string) *row {
		if r, ok := rows[ip]; ok {
			return r
		}
		r := &row{}
		rows[ip] = r
		return r
	}

	base := strings.TrimPrefix(oidBGPPeerTable, ".")
	if err := g.BulkWalk(oidBGPPeerTable, func(pdu gosnmp.SnmpPDU) error {
		full := strings.TrimPrefix(pdu.Name, ".")
		if !strings.HasPrefix(full, base+".") {
			return nil
		}
		parts := strings.Split(full[len(base)+1:], ".")
		if len(parts) < 5 {
			return nil
		}
		col, err := strconv.Atoi(parts[0])
		if err != nil {
			return nil
		}
		peerIP := strings.Join(parts[1:5], ".")
		r := ensure(peerIP)
		// Column numbers verified live against Junos (standard RFC1657
		// bgpPeerEntry layout — cols 7/8 are RemoteAddr/RemotePort, not
		// In/OutUpdates as the hub-local poller's comments claimed; that
		// table has no standard prefix-count column at all).
		switch col {
		case 2:
			r.state = pduInt(pdu)
		case 9:
			r.remoteASN = int64(pduUint64(pdu))
		case 10:
			r.inUpdates = int64(pduUint64(pdu))
		case 11:
			r.outUpdates = int64(pduUint64(pdu))
		case 15:
			r.fsmTrans = int64(pduUint64(pdu))
		case 16:
			// A direct pdu.Value.(uint32) assertion is unreliable here —
			// gosnmp doesn't consistently box Gauge32/TimeTicks as uint32
			// (confirmed live: always failed on Junos, leaving established
			// stuck at 0). pduUint64 handles all the numeric variants.
			r.established = uint32(pduUint64(pdu))
			r.estTicks = pdu.Type == gosnmp.TimeTicks
		}
		return nil
	}); err != nil {
		log.Debug().Err(err).Str("device_id", dev.ID).Msg("bgp: bgpPeerTable walk failed")
		return nil
	}
	if len(rows) == 0 {
		return nil
	}

	var sysUpTime uint32
	if resp, err := g.Get([]string{oidSysUpTime}); err == nil && len(resp.Variables) > 0 {
		sysUpTime = uint32(pduUint64(resp.Variables[0]))
	}

	records := make([]map[string]any, 0, len(rows))
	for peerIP, r := range rows {
		if r.state == 0 && r.remoteASN == 0 {
			continue
		}
		var uptimeSecs int64
		if r.state == 6 && r.established > 0 {
			if r.estTicks {
				if sysUpTime >= r.established {
					uptimeSecs = int64((sysUpTime - r.established) / 100)
				}
			} else {
				uptimeSecs = int64(r.established)
			}
		}
		records = append(records, map[string]any{
			"device_id":   dev.ID,
			"vrf":         "default",
			"peer_ip":     peerIP,
			"peer_asn":    r.remoteASN,
			"local_asn":   localASN,
			"state":       bgpStateName(r.state),
			"uptime_s":    uptimeSecs,
			"in_updates":  r.inUpdates,
			"out_updates": r.outUpdates,
			"flap_count":  r.fsmTrans,
		})
	}
	return records
}

func bgpStateName(v int) string {
	switch v {
	case 1:
		return "idle"
	case 2:
		return "connect"
	case 3:
		return "active"
	case 4:
		return "opensent"
	case 5:
		return "openconfirm"
	case 6:
		return "established"
	default:
		return "unknown"
	}
}

// ─── OSPF-MIB ───────────────────────────────────────────────────────────────

// pollOSPFNeighbors walks ospfNbrTable + ospfIfTable and returns records for
// POST /collectors/ospf-neighbors. ipToIfName resolves a local interface IP
// (ospfIfTable's index) to an interface name via the same ipAddrTable data
// used for interface inventory.
func pollOSPFNeighbors(g *gosnmp.GoSNMP, dev hub.Device, ipToIfName map[string]string, log zerolog.Logger) []map[string]any {
	type rowKey struct {
		ip       string
		addrless int
	}
	type row struct {
		routerID string
		state    int
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

	nbrBase := strings.TrimPrefix(oidOSPFNbrTable, ".")
	if err := g.BulkWalk(oidOSPFNbrTable, func(pdu gosnmp.SnmpPDU) error {
		col, ip, addrless, ok := ospfSplitIndex(pdu.Name, nbrBase)
		if !ok {
			return nil
		}
		r := ensure(rowKey{ip, addrless})
		switch col {
		case 3:
			r.routerID = ospfIPFromPDU(pdu)
		case 6:
			r.state = pduInt(pdu)
		}
		return nil
	}); err != nil {
		log.Debug().Err(err).Str("device_id", dev.ID).Msg("ospf: ospfNbrTable walk failed")
		return nil
	}
	if len(rows) == 0 {
		return nil
	}

	// ospfIfTable: local interface IP -> area. Reuse the same index shape.
	ifBase := strings.TrimPrefix(oidOSPFIfTable, ".")
	areaByIfIP := make(map[string]string)
	_ = g.BulkWalk(oidOSPFIfTable, func(pdu gosnmp.SnmpPDU) error {
		col, ip, _, ok := ospfSplitIndex(pdu.Name, ifBase)
		if !ok || col != 3 {
			return nil
		}
		if area := ospfIPFromPDU(pdu); area != "" {
			areaByIfIP[ip] = area
		}
		return nil
	})

	records := make([]map[string]any, 0, len(rows))
	for k, r := range rows {
		if r.state == 0 {
			continue
		}
		records = append(records, map[string]any{
			"device_id":      dev.ID,
			"vrf":            "default",
			"router_id":      r.routerID,
			"neighbor_ip":    k.ip,
			"interface_name": ipToIfName[k.ip],
			"area":           areaByIfIP[k.ip],
			"state":          ospfStateName(r.state),
		})
	}
	return records
}

// ospfSplitIndex parses col, dotted-IP, addressLessIndex from an OSPF table
// PDU name. Both ospfNbrTable and ospfIfTable share this index shape:
// col.a.b.c.d.addressLessIndex
func ospfSplitIndex(pduName, base string) (col int, ip string, addrless int, ok bool) {
	full := strings.TrimPrefix(pduName, ".")
	if !strings.HasPrefix(full, base+".") {
		return 0, "", 0, false
	}
	parts := strings.Split(full[len(base)+1:], ".")
	if len(parts) < 6 {
		return 0, "", 0, false
	}
	c, err := strconv.Atoi(parts[0])
	if err != nil {
		return 0, "", 0, false
	}
	ip = strings.Join(parts[1:5], ".")
	al, _ := strconv.Atoi(parts[5])
	return c, ip, al, true
}

func ospfIPFromPDU(pdu gosnmp.SnmpPDU) string {
	switch v := pdu.Value.(type) {
	case []byte:
		if len(v) == 4 {
			return fmt.Sprintf("%d.%d.%d.%d", v[0], v[1], v[2], v[3])
		}
	case string:
		return strings.TrimSpace(v)
	}
	return ""
}

func ospfStateName(v int) string {
	switch v {
	case 1:
		return "down"
	case 2:
		return "attempt"
	case 3:
		return "init"
	case 4:
		return "twoWay"
	case 5:
		return "exchangeStart"
	case 6:
		return "exchange"
	case 7:
		return "loading"
	case 8:
		return "full"
	default:
		return "unknown"
	}
}

// ─── ISIS-MIB (adjacencies only) ───────────────────────────────────────────

// pollISISAdjacencies walks isisISAdjTable + isisCircTable + isisISAdjIPAddrTable
// and returns records for POST /collectors/isis-neighbors. Areas, circuit
// levels, and the LSP database (which the hub-local collector also polls)
// have no collector-facing ingest endpoint yet, so they're out of scope here.
func pollISISAdjacencies(g *gosnmp.GoSNMP, dev hub.Device, ifNameByIdx map[string]string, localIfaceToRemoteHostname map[string]string, sysUpTimeTicks uint32, log zerolog.Logger) []map[string]any {
	type adjKey struct{ circ, adj int }
	type adjRow struct {
		instance string
		state    int
		sysID    []byte
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

	// Column numbers below are verified live against Junos, not taken on
	// faith from the hub-local poller's comments — those turned out to be
	// wrong too (col 5 claimed as the 6-byte neighbor sys-id, but the real
	// 6-byte value is at col 4; col 10 claimed as isisISAdjLastUpTime, but
	// the real TimeTicks value is at col 11). isisISAdjUsage (circuit
	// level) couldn't be confidently identified this way — this lab only
	// has level-2 adjacencies (level 1 is disabled in config on both
	// devices), so there's no contrasting level-1 sample to distinguish the
	// right column from neighboring integer-valued columns. Left as
	// "unknown" rather than guess and risk mislabeling.
	adjBase := strings.TrimPrefix(oidISISAdjTable, ".")
	if err := g.BulkWalk(oidISISAdjTable, func(pdu gosnmp.SnmpPDU) error {
		col, circIdx, adjIdx, inst, ok := isisSplitAdjIndex(pdu.Name, adjBase)
		if !ok {
			return nil
		}
		r := ensureRow(adjKey{circIdx, adjIdx}, inst)
		switch col {
		case 2:
			r.state = pduInt(pdu)
		case 4:
			if b, ok := pdu.Value.([]byte); ok {
				r.sysID = b
			}
		case 11:
			r.lastUp = uint32(pduUint64(pdu))
		}
		return nil
	}); err != nil {
		log.Debug().Err(err).Str("device_id", dev.ID).Msg("isis: isisISAdjTable walk failed")
		return nil
	}
	if len(rows) == 0 {
		return nil
	}

	// isisCircTable: circuit index -> ifIndex.
	circBase := strings.TrimPrefix(oidISISCircTable, ".")
	circToIfIdx := make(map[int]int)
	_ = g.BulkWalk(oidISISCircTable, func(pdu gosnmp.SnmpPDU) error {
		col, circIdx, _, ok := isisSplitCircIndex(pdu.Name, circBase)
		if ok && col == 2 {
			circToIfIdx[circIdx] = pduInt(pdu)
		}
		return nil
	})

	// isisISAdjIPAddrTable: (circ,adj) -> IPv4/IPv6.
	ipBase := strings.TrimPrefix(oidISISAdjIPTable, ".")
	type adjIPs struct{ v4, v6 string }
	ipByAdj := make(map[adjKey]adjIPs)
	_ = g.BulkWalk(oidISISAdjIPTable, func(pdu gosnmp.SnmpPDU) error {
		col, circIdx, adjIdx, _, ok := isisSplitAdjIPIndex(pdu.Name, ipBase)
		if !ok || col != 3 {
			return nil
		}
		ip := isisIPFromPDU(pdu)
		if ip == "" {
			return nil
		}
		k := adjKey{circIdx, adjIdx}
		e := ipByAdj[k]
		if strings.Contains(ip, ":") {
			e.v6 = ip
		} else {
			e.v4 = ip
		}
		ipByAdj[k] = e
		return nil
	})

	records := make([]map[string]any, 0, len(rows))
	for k, r := range rows {
		if r.state == 0 {
			continue
		}
		ifName := ifNameByIdx[strconv.Itoa(circToIfIdx[k.circ])]
		ips := ipByAdj[k]

		var uptimeSecs int64
		if r.state == 3 && r.lastUp > 0 && sysUpTimeTicks >= r.lastUp {
			uptimeSecs = int64(sysUpTimeTicks-r.lastUp) / 100
		}

		rec := map[string]any{
			"device_id":      dev.ID,
			"instance":       r.instance,
			"sys_id":         isisFormatSysID(r.sysID),
			"interface_name": ifName,
			"circuit_type":   "unknown",
			"adj_state":      isisAdjStateName(r.state),
			"uptime_seconds": uptimeSecs,
		}
		if hostname := localIfaceToRemoteHostname[ifName]; hostname != "" {
			rec["hostname"] = hostname
		}
		if ips.v4 != "" {
			rec["ipv4_address"] = ips.v4
		}
		if ips.v6 != "" {
			rec["ipv6_address"] = ips.v6
		}
		records = append(records, rec)
	}
	return records
}

func isisSplitAdjIndex(pduName, base string) (col, circIdx, adjIdx int, instance string, ok bool) {
	parts, sok := isisStripBase(pduName, base)
	if !sok || len(parts) < 1 {
		return 0, 0, 0, "", false
	}
	col, _ = strconv.Atoi(parts[0])
	inst, rest, iok := isisConsumeInstance(parts[1:], 2)
	if !iok {
		return 0, 0, 0, "", false
	}
	circIdx, _ = strconv.Atoi(rest[0])
	adjIdx, _ = strconv.Atoi(rest[1])
	return col, circIdx, adjIdx, inst, true
}

func isisSplitCircIndex(pduName, base string) (col, circIdx int, instance string, ok bool) {
	parts, sok := isisStripBase(pduName, base)
	if !sok || len(parts) < 1 {
		return 0, 0, "", false
	}
	col, _ = strconv.Atoi(parts[0])
	inst, rest, iok := isisConsumeInstance(parts[1:], 1)
	if !iok {
		return 0, 0, "", false
	}
	circIdx, _ = strconv.Atoi(rest[0])
	return col, circIdx, inst, true
}

func isisSplitAdjIPIndex(pduName, base string) (col, circIdx, adjIdx, ipIdx int, ok bool) {
	parts, sok := isisStripBase(pduName, base)
	if !sok || len(parts) < 1 {
		return 0, 0, 0, 0, false
	}
	col, _ = strconv.Atoi(parts[0])
	_, rest, iok := isisConsumeInstance(parts[1:], 3)
	if !iok {
		return 0, 0, 0, 0, false
	}
	circIdx, _ = strconv.Atoi(rest[0])
	adjIdx, _ = strconv.Atoi(rest[1])
	ipIdx, _ = strconv.Atoi(rest[2])
	return col, circIdx, adjIdx, ipIdx, true
}

// isisStripBase strips the table OID prefix and the SEQUENCE OF Entry's
// fixed ".1" sub-id (always present — every standard SNMP table PDU name is
// <table-oid>.1.<col>.<index...>), returning the remaining dot-separated
// parts starting at the column number.
func isisStripBase(pduName, base string) ([]string, bool) {
	full := strings.TrimPrefix(pduName, ".")
	prefix := base + ".1."
	if !strings.HasPrefix(full, prefix) {
		return nil, false
	}
	return strings.Split(full[len(prefix):], "."), true
}

// isisConsumeInstance parses the length-prefixed OctetString isisSysInstance
// component, given that exactly `want` index components must remain after
// it. Tries the length-prefixed interpretation first; if that doesn't leave
// exactly `want` parts, falls back to "no instance component present at
// all" — confirmed live: Junos omits the isisSysInstance length-prefix
// entirely for the default/unnamed instance (the OID goes straight from the
// column number to the real index components), rather than encoding it as
// a literal zero-length byte. This is very likely why isis_neighbors has
// been empty in this project generally (hub-local's poller has the same
// length-prefix assumption), not just for Junos.
func isisConsumeInstance(parts []string, want int) (instance string, rest []string, ok bool) {
	if len(parts) > 0 {
		if instLen, err := strconv.Atoi(parts[0]); err == nil && instLen >= 0 && instLen <= 255 &&
			len(parts) == 1+instLen+want {
			b := make([]byte, instLen)
			valid := true
			for i := 0; i < instLen; i++ {
				v, e := strconv.Atoi(parts[1+i])
				if e != nil || v < 0 || v > 255 {
					valid = false
					break
				}
				b[i] = byte(v)
			}
			if valid {
				return string(b), parts[1+instLen:], true
			}
		}
	}
	if len(parts) == want {
		return "", parts, true
	}
	return "", nil, false
}

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

// isisFormatSysID renders a 6-byte IS-IS system-id as "xxxx.xxxx.xxxx".
func isisFormatSysID(b []byte) string {
	if len(b) != 6 {
		return ""
	}
	return fmt.Sprintf("%02x%02x.%02x%02x.%02x%02x", b[0], b[1], b[2], b[3], b[4], b[5])
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
