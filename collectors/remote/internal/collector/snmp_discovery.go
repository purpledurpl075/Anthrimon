package collector

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/gosnmp/gosnmp"
	"github.com/rs/zerolog"

	"github.com/purpledurpl075/anthri-mon/collectors/remote/internal/hub"
)

// This file implements the discovery-table polls the remote collector was
// missing relative to the hub-local SNMP collector: interface inventory,
// VLANs, ARP/MAC tables, and LLDP neighbors. The hub-local collector writes
// these straight to Postgres; the remote collector has no DB access, so each
// poll here is pushed to the hub over its own dedicated /collectors/* endpoint.
// Interface inventory MUST be posted before VLANs/addresses in a poll cycle —
// the hub resolves VLAN/ARP/MAC records to an interface_id by (device_id,
// if_name), so those joins are no-ops until the interfaces rows exist.

const (
	oidIPAddrTable     = "1.3.6.1.2.1.4.20.1"       // RFC1213 ipAddrTable (IPv4 only)
	oidARPTable        = "1.3.6.1.2.1.4.22.1"       // ipNetToMediaTable
	oidMACFdbTable     = "1.3.6.1.2.1.17.4.3.1"     // dot1dTpFdbTable (BRIDGE-MIB)
	oidDot1qTpFdbTable = "1.3.6.1.2.1.17.7.1.2.2.1" // Q-BRIDGE-MIB, VLAN-aware FDB

	oidDot1qVlanStaticName           = "1.3.6.1.2.1.17.7.1.4.1.1.1"
	oidDot1qVlanCurrentEgressPorts   = "1.3.6.1.2.1.17.7.1.4.2.1.3"
	oidDot1qVlanCurrentUntaggedPorts = "1.3.6.1.2.1.17.7.1.4.2.1.4"

	// JUNIPER-VLAN-MIB — jnxExVlanTable. Junos EX doesn't populate the
	// standard Q-BRIDGE-MIB static/current VLAN tables (confirmed: both
	// return noSuchObject), so VLAN definitions fall back to this vendor MIB.
	// Col 2 = jnxExVlanName, col 5 = jnxExVlanTag (802.1Q tag; 0 = untagged
	// default VLAN, skipped since it isn't a meaningful catalog entry).
	// No per-physical-port membership table was found on this firmware —
	// only the VLAN-to-L3-IRB-interface binding (jnxExVlanPortGroupTable),
	// which doesn't cover access/trunk port assignment.
	oidJnxExVlanName = "1.3.6.1.4.1.2636.3.40.1.5.1.5.1.2"
	oidJnxExVlanTag  = "1.3.6.1.4.1.2636.3.40.1.5.1.5.1.5"

	oidLLDPRemTableIEEE   = "1.0.8802.1.1.2.1.4.1.1"
	oidLLDPRemTableIETF   = "1.3.6.1.2.1.111.1.4.1.1"
	oidLLDPLocPortIEEE    = "1.0.8802.1.1.2.1.3.7.1"
	oidLLDPLocPortIETF    = "1.3.6.1.2.1.111.1.3.7.1"
	oidLLDPRemManAddrIEEE = "1.0.8802.1.1.2.1.4.2.1"
	oidLLDPRemManAddrIETF = "1.3.6.1.2.1.111.1.4.2.1"

	// JUNIPER-MIB — jnxOperatingTable. Junos doesn't implement
	// HOST-RESOURCES-MIB's hrProcessorLoad/hrStorageTable (confirmed:
	// noSuchObject on at least EX3300 15.1R6/R7), so CPU/memory fall back to
	// this vendor MIB. The table has one row per chassis component (power
	// supplies, fans, PICs, FPC, Routing Engine) — only the Routing Engine
	// row is a meaningful "device CPU/memory" reading; the hub averages all
	// cpu_index samples it receives per device, so including the other
	// components' rows (which read 0) would badly understate real load.
	oidJnxOperatingDescr = "1.3.6.1.4.1.2636.3.1.13.1.5"
	oidJnxOperatingCPU   = "1.3.6.1.4.1.2636.3.1.13.1.8"
	// jnxOperatingBuffer: despite the name, on the Routing Engine/FPC row
	// this reads installed memory in bytes (confirmed live: exactly
	// 1073741824 == 1GiB, matching the EX3300's real RAM). jnxOperatingMemory
	// (col 11) is a 0-100 utilization percent, not a byte count.
	oidJnxOperatingBuffer = "1.3.6.1.4.1.2636.3.1.13.1.10"
	oidJnxOperatingMemory = "1.3.6.1.4.1.2636.3.1.13.1.11"
)

var ifTypeNames = map[int]string{
	1:   "other",
	6:   "ethernetCsmacd",
	24:  "softwareLoopback",
	53:  "propVirtual",
	131: "tunnel",
	135: "l2vlan",
	136: "l3ipvlan",
	161: "ieee8023adLag",
	166: "mpls",
	188: "atmVciEndPt",
}

func ifTypeName(v int) string {
	if name, ok := ifTypeNames[v]; ok {
		return name
	}
	return "other"
}

func ifAdminStatusName(v int) string {
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

func formatMAC(b []byte) string {
	if len(b) != 6 {
		return ""
	}
	return fmt.Sprintf("%02x:%02x:%02x:%02x:%02x:%02x", b[0], b[1], b[2], b[3], b[4], b[5])
}

func isZeroMAC(b []byte) bool {
	for _, v := range b {
		if v != 0 {
			return false
		}
	}
	return true
}

// ─── Interface inventory ───────────────────────────────────────────────────

// pollInterfaceInventory walks ifTable, ifXTable, and ipAddrTable and returns
// one record per interface for POST /collectors/interfaces.
func pollInterfaceInventory(g *gosnmp.GoSNMP, dev hub.Device, log zerolog.Logger) []map[string]any {
	type ifRow struct {
		descr, alias, name string
		ifType             int
		mtu                int
		physAddr           []byte
		adminStatus        int
		operStatus         int
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

	if err := g.BulkWalk(oidIfTable, func(pdu gosnmp.SnmpPDU) error {
		col, idx := splitColIdx(pdu.Name, oidIfTable)
		if idx < 0 {
			return nil
		}
		r := ensure(idx)
		switch col {
		case 2:
			r.descr = pduString(pdu)
		case 3:
			r.ifType = pduInt(pdu)
		case 4:
			r.mtu = pduInt(pdu)
		case 6:
			if b, ok := pdu.Value.([]byte); ok {
				r.physAddr = b
			}
		case 7:
			r.adminStatus = pduInt(pdu)
		case 8:
			r.operStatus = pduInt(pdu)
		}
		return nil
	}); err != nil {
		log.Debug().Err(err).Str("device_id", dev.ID).Msg("interface inventory: ifTable walk error")
	}

	if err := g.BulkWalk(oidIfXTable, func(pdu gosnmp.SnmpPDU) error {
		col, idx := splitColIdx(pdu.Name, oidIfXTable)
		if idx < 0 {
			return nil
		}
		r := ensure(idx)
		switch col {
		case 1:
			r.name = pduString(pdu)
		case 18:
			r.alias = pduString(pdu)
		}
		return nil
	}); err != nil {
		log.Debug().Err(err).Str("device_id", dev.ID).Msg("interface inventory: ifXTable walk error")
	}

	ipsByIdx := pollIPAddrTable(g)

	records := make([]map[string]any, 0, len(rows))
	for idx, r := range rows {
		name := r.name
		if name == "" {
			name = r.descr
		}
		if name == "" {
			name = fmt.Sprintf("if%d", idx)
		}
		rec := map[string]any{
			"device_id":    dev.ID,
			"if_index":     idx,
			"name":         name,
			"description":  r.alias,
			"if_type":      ifTypeName(r.ifType),
			"mtu":          r.mtu,
			"admin_status": ifAdminStatusName(r.adminStatus),
			"oper_status":  ifOperStatusName(r.operStatus),
		}
		if mac := formatMAC(r.physAddr); mac != "" {
			rec["mac_address"] = mac
		}
		if ips, ok := ipsByIdx[idx]; ok {
			rec["ip_addresses"] = ips
		}
		records = append(records, rec)
	}
	return records
}

// pollIPAddrTable walks the RFC1213 ipAddrTable and returns ifIndex → list of
// {"address": "a.b.c.d", "prefix_len": N, "version": 4} maps.
func pollIPAddrTable(g *gosnmp.GoSNMP) map[int][]map[string]any {
	type row struct {
		ifIndex int
		mask    string
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

	base := strings.TrimPrefix(oidIPAddrTable, ".")
	_ = g.BulkWalk(oidIPAddrTable, func(pdu gosnmp.SnmpPDU) error {
		full := strings.TrimPrefix(pdu.Name, ".")
		if !strings.HasPrefix(full, base+".") {
			return nil
		}
		rest := full[len(base)+1:]
		parts := strings.SplitN(rest, ".", 2)
		if len(parts) < 2 {
			return nil
		}
		col, err := strconv.Atoi(parts[0])
		if err != nil {
			return nil
		}
		r := ensure(parts[1])
		switch col {
		case 2:
			r.ifIndex = pduInt(pdu)
		case 3:
			r.mask = pduString(pdu)
		}
		return nil
	})

	result := make(map[int][]map[string]any)
	for ip, r := range rows {
		if r.ifIndex == 0 {
			continue
		}
		result[r.ifIndex] = append(result[r.ifIndex], map[string]any{
			"address":    ip,
			"prefix_len": maskToPrefixLen(r.mask),
			"version":    4,
		})
	}
	return result
}

// ─── Bridge port mapping (shared by VLAN + MAC polling) ────────────────────

// buildBridgePortToIfIndex walks dot1dBasePortIfIndex and returns bridge port
// number → ifIndex. Empty map (not an error) on devices without BRIDGE-MIB.
func buildBridgePortToIfIndex(g *gosnmp.GoSNMP) map[int]int {
	m := make(map[int]int)
	_ = g.BulkWalk(oidDot1dBasePortIfIndex, func(pdu gosnmp.SnmpPDU) error {
		portNum := lastOIDIndex(pdu.Name)
		if portNum > 0 {
			m[portNum] = pduInt(pdu)
		}
		return nil
	})
	return m
}

func bitmapBitSet(bitmap []byte, portNum int) bool {
	if len(bitmap) == 0 || portNum < 1 {
		return false
	}
	idx := (portNum - 1) / 8
	bit := 7 - (portNum-1)%8
	if idx >= len(bitmap) {
		return false
	}
	return (bitmap[idx]>>uint(bit))&1 == 1
}

func parseVlanCurrentIndex(pduName, tableBase string) (vlanID int, ok bool) {
	full := strings.TrimPrefix(pduName, ".")
	base := strings.TrimPrefix(tableBase, ".")
	if !strings.HasPrefix(full, base+".") {
		return 0, false
	}
	suffix := full[len(base)+1:]
	dot := strings.LastIndex(suffix, ".")
	if dot < 0 {
		return 0, false
	}
	id, err := strconv.Atoi(suffix[dot+1:])
	if err != nil {
		return 0, false
	}
	return id, true
}

// ─── VLANs ──────────────────────────────────────────────────────────────────

// pollVLANTable walks the Q-BRIDGE-MIB and returns a flat list of VLAN
// definitions and per-interface membership records for POST /collectors/vlans.
// ifNameByIdx must come from resolveIfNames(g) run earlier in the same cycle.
func pollVLANTable(g *gosnmp.GoSNMP, dev hub.Device, ifNameByIdx map[string]string, log zerolog.Logger) []map[string]any {
	vlanNames := make(map[int]string)
	nameBase := strings.TrimPrefix(oidDot1qVlanStaticName, ".")
	nameErr := g.BulkWalk(oidDot1qVlanStaticName, func(pdu gosnmp.SnmpPDU) error {
		full := strings.TrimPrefix(pdu.Name, ".")
		if !strings.HasPrefix(full, nameBase+".") {
			return nil
		}
		vlanID, err := strconv.Atoi(full[len(nameBase)+1:])
		if err != nil {
			return nil
		}
		vlanNames[vlanID] = pduString(pdu)
		return nil
	})
	if nameErr != nil {
		log.Debug().Err(nameErr).Str("device_id", dev.ID).Msg("vlan: dot1qVlanStaticName walk failed")
		return nil
	}

	if len(vlanNames) == 0 {
		for _, probeOID := range []string{oidDot1qVlanCurrentEgressPorts, oidDot1qVlanCurrentUntaggedPorts} {
			_ = g.BulkWalk(probeOID, func(pdu gosnmp.SnmpPDU) error {
				if vlanID, ok := parseVlanCurrentIndex(pdu.Name, probeOID); ok {
					if _, exists := vlanNames[vlanID]; !exists {
						vlanNames[vlanID] = ""
					}
				}
				return nil
			})
			if len(vlanNames) > 0 {
				break
			}
		}
		if len(vlanNames) == 0 {
			return nil
		}
	}

	var records []map[string]any
	for id, name := range vlanNames {
		records = append(records, map[string]any{
			"device_id": dev.ID,
			"vlan_id":   id,
			"name":      name,
		})
	}

	bridgeToIf := buildBridgePortToIfIndex(g)

	egressBitmaps := make(map[int][]byte)
	_ = g.BulkWalk(oidDot1qVlanCurrentEgressPorts, func(pdu gosnmp.SnmpPDU) error {
		if vlanID, ok := parseVlanCurrentIndex(pdu.Name, oidDot1qVlanCurrentEgressPorts); ok {
			if b, ok2 := pdu.Value.([]byte); ok2 {
				egressBitmaps[vlanID] = b
			}
		}
		return nil
	})
	untagBitmaps := make(map[int][]byte)
	_ = g.BulkWalk(oidDot1qVlanCurrentUntaggedPorts, func(pdu gosnmp.SnmpPDU) error {
		if vlanID, ok := parseVlanCurrentIndex(pdu.Name, oidDot1qVlanCurrentUntaggedPorts); ok {
			if b, ok2 := pdu.Value.([]byte); ok2 {
				untagBitmaps[vlanID] = b
			}
		}
		return nil
	})
	// Some vendors (e.g. Arista EOS) only populate the untagged table; treat
	// it as the egress table too so those VLANs still surface as access ports.
	if len(egressBitmaps) == 0 && len(untagBitmaps) > 0 {
		egressBitmaps = untagBitmaps
	}

	for vlanID, egress := range egressBitmaps {
		untag := untagBitmaps[vlanID]
		for portNum := 1; portNum <= len(egress)*8; portNum++ {
			if !bitmapBitSet(egress, portNum) {
				continue
			}
			ifIdx, ok := bridgeToIf[portNum]
			if !ok {
				if len(bridgeToIf) > 0 {
					continue
				}
				ifIdx = portNum
			}
			ifName := ifNameByIdx[strconv.Itoa(ifIdx)]
			if ifName == "" {
				continue
			}
			records = append(records, map[string]any{
				"device_id": dev.ID,
				"vlan_id":   vlanID,
				"if_name":   ifName,
				"tagged":    !bitmapBitSet(untag, portNum),
			})
		}
	}
	return records
}

// pollVLANDefsJuniper walks JUNIPER-VLAN-MIB's jnxExVlanTable and returns VLAN
// definition records only (no per-port membership — see the oidJnxExVlan*
// comment for why). Used as a fallback when the device's Q-BRIDGE-MIB is
// unimplemented, which is the case on at least Junos EX3300 15.1R6/R7.
func pollVLANDefsJuniper(g *gosnmp.GoSNMP, dev hub.Device, log zerolog.Logger) []map[string]any {
	names := make(map[int]string)
	nameBase := strings.TrimPrefix(oidJnxExVlanName, ".")
	if err := g.BulkWalk(oidJnxExVlanName, func(pdu gosnmp.SnmpPDU) error {
		full := strings.TrimPrefix(pdu.Name, ".")
		if !strings.HasPrefix(full, nameBase+".") {
			return nil
		}
		idx, err := strconv.Atoi(full[len(nameBase)+1:])
		if err != nil {
			return nil
		}
		names[idx] = pduString(pdu)
		return nil
	}); err != nil {
		log.Debug().Err(err).Str("device_id", dev.ID).Msg("vlan(juniper): jnxExVlanName walk failed")
		return nil
	}
	if len(names) == 0 {
		return nil
	}

	tags := make(map[int]int)
	tagBase := strings.TrimPrefix(oidJnxExVlanTag, ".")
	_ = g.BulkWalk(oidJnxExVlanTag, func(pdu gosnmp.SnmpPDU) error {
		full := strings.TrimPrefix(pdu.Name, ".")
		if !strings.HasPrefix(full, tagBase+".") {
			return nil
		}
		idx, err := strconv.Atoi(full[len(tagBase)+1:])
		if err != nil {
			return nil
		}
		tags[idx] = pduInt(pdu)
		return nil
	})

	var records []map[string]any
	for idx, name := range names {
		tag := tags[idx]
		if tag <= 0 {
			continue // untagged default VLAN — not a meaningful catalog entry
		}
		records = append(records, map[string]any{
			"device_id": dev.ID,
			"vlan_id":   tag,
			"name":      name,
		})
	}
	return records
}

// ─── ARP + MAC address tables ──────────────────────────────────────────────

// pollAddressTable walks ipNetToMediaTable (ARP) and dot1dTpFdbTable +
// dot1qTpFdbTable (MAC/FDB) and returns a flat list of records for
// POST /collectors/addresses.
func pollAddressTable(g *gosnmp.GoSNMP, dev hub.Device, ifNameByIdx map[string]string, log zerolog.Logger) []map[string]any {
	var records []map[string]any

	// ── ARP (ipNetToMediaTable) ──────────────────────────────────────────────
	type arpRow struct {
		mac       []byte
		entryType int
	}
	arpRows := make(map[string]*arpRow) // key: "ifIdx.ip"
	arpBase := strings.TrimPrefix(oidARPTable, ".")
	if err := g.BulkWalk(oidARPTable, func(pdu gosnmp.SnmpPDU) error {
		full := strings.TrimPrefix(pdu.Name, ".")
		if !strings.HasPrefix(full, arpBase+".") {
			return nil
		}
		parts := strings.Split(full[len(arpBase)+1:], ".")
		if len(parts) < 6 {
			return nil
		}
		col, err := strconv.Atoi(parts[0])
		if err != nil {
			return nil
		}
		ifIdx, _ := strconv.Atoi(parts[1])
		ip := strings.Join(parts[2:6], ".")
		key := fmt.Sprintf("%d.%s", ifIdx, ip)
		r, ok := arpRows[key]
		if !ok {
			r = &arpRow{}
			arpRows[key] = r
		}
		switch col {
		case 2:
			if b, ok2 := pdu.Value.([]byte); ok2 {
				r.mac = b
			}
		case 4:
			r.entryType = pduInt(pdu)
		}
		return nil
	}); err != nil {
		log.Debug().Err(err).Str("device_id", dev.ID).Msg("addresses: ipNetToMediaTable walk error")
	}
	for key, r := range arpRows {
		if len(r.mac) != 6 || isZeroMAC(r.mac) || r.entryType == 2 {
			continue
		}
		parts := strings.SplitN(key, ".", 2)
		ifIdx, _ := strconv.Atoi(parts[0])
		records = append(records, map[string]any{
			"device_id":      dev.ID,
			"ip_address":     parts[1],
			"mac_address":    formatMAC(r.mac),
			"interface_name": ifNameByIdx[strconv.Itoa(ifIdx)],
		})
	}

	// ── MAC/FDB (BRIDGE-MIB + Q-BRIDGE-MIB) ──────────────────────────────────
	bridgePortToIfIdx := buildBridgePortToIfIndex(g)

	type macRow struct {
		bridgePort int
		status     int
	}
	macRows := make(map[[6]byte]*macRow)
	ensureMAC := func(mac [6]byte) *macRow {
		if r, ok := macRows[mac]; ok {
			return r
		}
		r := &macRow{}
		macRows[mac] = r
		return r
	}

	fdbBase := strings.TrimPrefix(oidMACFdbTable, ".")
	_ = g.BulkWalk(oidMACFdbTable, func(pdu gosnmp.SnmpPDU) error {
		full := strings.TrimPrefix(pdu.Name, ".")
		if !strings.HasPrefix(full, fdbBase+".") {
			return nil
		}
		parts := strings.Split(full[len(fdbBase)+1:], ".")
		if len(parts) < 7 {
			return nil
		}
		col, err := strconv.Atoi(parts[0])
		if err != nil {
			return nil
		}
		var mac [6]byte
		for i := 0; i < 6; i++ {
			v, err := strconv.Atoi(parts[i+1])
			if err != nil || v < 0 || v > 255 {
				return nil
			}
			mac[i] = byte(v)
		}
		r := ensureMAC(mac)
		switch col {
		case 2:
			r.bridgePort = pduInt(pdu)
		case 3:
			r.status = pduInt(pdu)
		}
		return nil
	})

	qBase := strings.TrimPrefix(oidDot1qTpFdbTable, ".")
	_ = g.BulkWalk(oidDot1qTpFdbTable, func(pdu gosnmp.SnmpPDU) error {
		full := strings.TrimPrefix(pdu.Name, ".")
		if !strings.HasPrefix(full, qBase+".") {
			return nil
		}
		parts := strings.Split(full[len(qBase)+1:], ".")
		if len(parts) < 8 {
			return nil
		}
		col, err := strconv.Atoi(parts[0])
		if err != nil {
			return nil
		}
		var mac [6]byte
		for i := 0; i < 6; i++ {
			v, err := strconv.Atoi(parts[i+2])
			if err != nil || v < 0 || v > 255 {
				return nil
			}
			mac[i] = byte(v)
		}
		r := ensureMAC(mac)
		switch col {
		case 2:
			if p := pduInt(pdu); p > 0 {
				r.bridgePort = p
			}
		case 3:
			if v := pduInt(pdu); v != 2 {
				r.status = v
			}
		}
		return nil
	})

	for mac, r := range macRows {
		if r.status == 2 || isZeroMAC(mac[:]) {
			continue
		}
		portName := ""
		if ifIdx, ok := bridgePortToIfIdx[r.bridgePort]; ok {
			portName = ifNameByIdx[strconv.Itoa(ifIdx)]
		}
		if portName == "" {
			continue
		}
		records = append(records, map[string]any{
			"device_id":   dev.ID,
			"mac_address": formatMAC(mac[:]),
			"port_name":   portName,
		})
	}

	return records
}

// ─── LLDP neighbors ─────────────────────────────────────────────────────────

// pollLLDPTable walks lldpRemTable + lldpLocPortTable + lldpRemManAddrTable
// (trying the IEEE OID namespace first, falling back to IETF) and returns a
// flat list of records for POST /collectors/lldp-neighbors.
func pollLLDPTable(g *gosnmp.GoSNMP, dev hub.Device, log zerolog.Logger) []map[string]any {
	records, found := pollLLDPNamespace(g, dev, oidLLDPRemTableIEEE, oidLLDPLocPortIEEE, oidLLDPRemManAddrIEEE, log)
	if found {
		return records
	}
	records, _ = pollLLDPNamespace(g, dev, oidLLDPRemTableIETF, oidLLDPLocPortIETF, oidLLDPRemManAddrIETF, log)
	return records
}

func pollLLDPNamespace(g *gosnmp.GoSNMP, dev hub.Device, remBase, locBase, manBase string, log zerolog.Logger) ([]map[string]any, bool) {
	var remPDUs []gosnmp.SnmpPDU
	if err := g.BulkWalk(remBase, func(pdu gosnmp.SnmpPDU) error {
		remPDUs = append(remPDUs, pdu)
		return nil
	}); err != nil {
		log.Debug().Err(err).Str("device_id", dev.ID).Msg("lldp: lldpRemTable walk error")
		return nil, false
	}
	if len(remPDUs) == 0 {
		return nil, false
	}

	var locPDUs, manPDUs []gosnmp.SnmpPDU
	_ = g.BulkWalk(locBase, func(pdu gosnmp.SnmpPDU) error { locPDUs = append(locPDUs, pdu); return nil })
	_ = g.BulkWalk(manBase, func(pdu gosnmp.SnmpPDU) error { manPDUs = append(manPDUs, pdu); return nil })

	portNames := make(map[int]string)
	locBaseTrim := strings.TrimPrefix(locBase, ".")
	for _, pdu := range locPDUs {
		full := strings.TrimPrefix(pdu.Name, ".")
		if !strings.HasPrefix(full, locBaseTrim+".") {
			continue
		}
		parts := strings.SplitN(full[len(locBaseTrim)+1:], ".", 2)
		if len(parts) < 2 {
			continue
		}
		col, _ := strconv.Atoi(parts[0])
		idx, _ := strconv.Atoi(parts[1])
		if idx <= 0 {
			continue
		}
		val := pduString(pdu)
		if val == "" {
			continue
		}
		switch col {
		case 4:
			portNames[idx] = val
		case 3:
			if portNames[idx] == "" {
				portNames[idx] = val
			}
		}
	}

	mgmtByKey := make(map[string]string)
	manBaseTrim := strings.TrimPrefix(manBase, ".")
	for _, pdu := range manPDUs {
		full := strings.TrimPrefix(pdu.Name, ".")
		if !strings.HasPrefix(full, manBaseTrim+".") {
			continue
		}
		// suffix: timeMark.portNum.remIdx.addrSubtype.addrLen.a.b.c.d
		parts := strings.Split(full[len(manBaseTrim)+1:], ".")
		if len(parts) < 9 {
			continue
		}
		portNum, _ := strconv.Atoi(parts[1])
		remIdx, _ := strconv.Atoi(parts[2])
		addrSubtype, _ := strconv.Atoi(parts[3])
		addrLen, _ := strconv.Atoi(parts[4])
		if addrSubtype != 1 || addrLen != 4 || len(parts) < 9 {
			continue
		}
		ip := strings.Join(parts[5:9], ".")
		k := fmt.Sprintf("%d.%d", portNum, remIdx)
		if _, exists := mgmtByKey[k]; !exists {
			mgmtByKey[k] = ip
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

	remBaseTrim := strings.TrimPrefix(remBase, ".")
	for _, pdu := range remPDUs {
		full := strings.TrimPrefix(pdu.Name, ".")
		if !strings.HasPrefix(full, remBaseTrim+".") {
			continue
		}
		// suffix: col.timeMark.portNum.remIndex
		parts := strings.SplitN(full[len(remBaseTrim)+1:], ".", 4)
		if len(parts) < 4 {
			continue
		}
		col, _ := strconv.Atoi(parts[0])
		portNum, _ := strconv.Atoi(parts[2])
		remIdx, _ := strconv.Atoi(parts[3])
		k := rowKey{portNum, remIdx}
		r := ensure(k)
		switch col {
		case 4:
			r.chassisSub = pduInt(pdu)
		case 5:
			if b, ok := pdu.Value.([]byte); ok {
				r.chassisID = b
			} else {
				r.chassisID = []byte(pduString(pdu))
			}
		case 6:
			r.portSub = pduInt(pdu)
		case 7:
			if b, ok := pdu.Value.([]byte); ok {
				r.portID = b
			} else {
				r.portID = []byte(pduString(pdu))
			}
		case 8:
			r.portDesc = pduString(pdu)
		case 9:
			r.sysName = pduString(pdu)
		case 12:
			if b, ok := pdu.Value.([]byte); ok {
				r.capEnabled = b
			}
		}
	}

	records := make([]map[string]any, 0, len(rows))
	for k, r := range rows {
		local := portNames[k.portNum]
		if local == "" {
			local = strconv.Itoa(k.portNum)
		}
		chassisID := formatLLDPID(r.chassisSub, r.chassisID)
		if chassisID == "" {
			continue
		}
		rec := map[string]any{
			"device_id":                 dev.ID,
			"local_port_name":           local,
			"remote_chassis_id_subtype": lldpChassisSubtypeName(r.chassisSub),
			"remote_chassis_id":         chassisID,
			"remote_port_id_subtype":    lldpPortSubtypeName(r.portSub),
			"remote_port_id":            formatLLDPID(r.portSub, r.portID),
			"remote_port_desc":          r.portDesc,
			"remote_system_name":        r.sysName,
		}
		if ip := mgmtByKey[fmt.Sprintf("%d.%d", k.portNum, k.remIdx)]; ip != "" {
			rec["remote_mgmt_ip"] = ip
		}
		if caps := parseLLDPCapabilities(r.capEnabled); len(caps) > 0 {
			rec["remote_system_capabilities"] = caps
		}
		records = append(records, rec)
	}
	return records, true
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

// formatLLDPID renders a chassis/port ID based on subtype: MAC subtypes as
// "aa:bb:cc:dd:ee:ff", otherwise as a printable string (or hex if not printable).
func formatLLDPID(subtype int, b []byte) string {
	if len(b) == 0 {
		return ""
	}
	if (subtype == 4 || subtype == 3) && len(b) == 6 {
		return formatMAC(b)
	}
	s := strings.TrimSpace(string(b))
	for _, c := range s {
		if c < 0x20 || c > 0x7e {
			return fmt.Sprintf("%x", b)
		}
	}
	return s
}

// parseLLDPCapabilities decodes the 2-byte BITS capability field (RFC 802.1AB).
func parseLLDPCapabilities(b []byte) []string {
	if len(b) == 0 {
		return nil
	}
	caps := []struct {
		mask byte
		name string
	}{
		{0x80, "other"}, {0x40, "switch"}, {0x20, "bridge"}, {0x10, "wlanAccessPoint"},
		{0x08, "router"}, {0x04, "telephone"}, {0x02, "docsisCableDevice"}, {0x01, "stationOnly"},
	}
	var out []string
	for _, c := range caps {
		if b[0]&c.mask != 0 {
			out = append(out, c.name)
		}
	}
	return out
}

// ─── Juniper CPU/memory (JUNIPER-MIB fallback) ─────────────────────────────

// pollJuniperHealth walks jnxOperatingTable and returns CPU/memory metric
// lines for the Routing Engine row only (see oidJnxOperating* comment for
// why the other chassis-component rows are excluded). Returns nil if no
// Routing Engine row is found (e.g. non-Junos-EX-family sysDescr match).
func pollJuniperHealth(g *gosnmp.GoSNMP, dev hub.Device, ts int64, log zerolog.Logger) []string {
	descrBase := strings.TrimPrefix(oidJnxOperatingDescr, ".")
	fullIndex := func(pduName, base string) string {
		full := strings.TrimPrefix(pduName, ".")
		b := strings.TrimPrefix(base, ".")
		if !strings.HasPrefix(full, b+".") {
			return ""
		}
		return full[len(b)+1:]
	}

	var reIdx string
	if err := g.BulkWalk(oidJnxOperatingDescr, func(pdu gosnmp.SnmpPDU) error {
		if strings.Contains(pduString(pdu), "Routing Engine") {
			reIdx = fullIndex(pdu.Name, descrBase)
		}
		return nil
	}); err != nil {
		log.Debug().Err(err).Str("device_id", dev.ID).Msg("juniper health: jnxOperatingDescr walk failed")
		return nil
	}
	if reIdx == "" {
		return nil
	}

	var cpuPct, memPct, memTotalBytes int
	_ = g.BulkWalk(oidJnxOperatingCPU, func(pdu gosnmp.SnmpPDU) error {
		if fullIndex(pdu.Name, oidJnxOperatingCPU) == reIdx {
			cpuPct = pduInt(pdu)
		}
		return nil
	})
	_ = g.BulkWalk(oidJnxOperatingMemory, func(pdu gosnmp.SnmpPDU) error {
		if fullIndex(pdu.Name, oidJnxOperatingMemory) == reIdx {
			memPct = pduInt(pdu)
		}
		return nil
	})
	_ = g.BulkWalk(oidJnxOperatingBuffer, func(pdu gosnmp.SnmpPDU) error {
		if fullIndex(pdu.Name, oidJnxOperatingBuffer) == reIdx {
			memTotalBytes = pduInt(pdu)
		}
		return nil
	})

	lines := []string{
		fmt.Sprintf(`anthrimon_device_cpu_util_pct{device_id=%q,cpu_index="0"} %d %d`, dev.ID, cpuPct, ts),
	}
	if memTotalBytes > 0 {
		memUsedBytes := int64(float64(memTotalBytes) * float64(memPct) / 100.0)
		lines = append(lines,
			fmt.Sprintf(`anthrimon_device_mem_total_bytes{device_id=%q,mem_type="ram"} %d %d`, dev.ID, memTotalBytes, ts),
			fmt.Sprintf(`anthrimon_device_mem_used_bytes{device_id=%q,mem_type="ram"} %d %d`, dev.ID, memUsedBytes, ts),
		)
	}
	return lines
}
