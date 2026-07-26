package poller

import (
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/client"
	"github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/model"
	"github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/oid"
	"github.com/rs/zerolog/log"
)

// PollVLANs walks the Q-BRIDGE-MIB tables and returns per-VLAN metadata and
// per-interface VLAN membership records.
//
// ifByIndex maps ifIndex → interface name and is used only for internal
// resolution; the writer resolves IfIndex to interface_id independently.
//
// All walk failures are treated as non-fatal: an empty slice + nil error is
// returned so the poll cycle can continue.
func PollVLANs(s *client.Session, deviceID uuid.UUID, ifByIndex map[int]string) ([]*model.VLANResult, []*model.InterfaceVLANResult, error) {
	// ── 1. Walk dot1qVlanStaticName → vlan_id → name ──────────────────────────
	// Some devices only populate the current table, not the static table.
	// We try static first (gives names), then fall back to current table for IDs.
	vlanNames := make(map[int]string) // vlanID → name

	namePDUs, err := s.BulkWalkAll(oid.Dot1qVlanStaticName)
	if err != nil {
		log.Debug().Err(err).Msg("vlan: dot1qVlanStaticName walk failed, skipping VLAN collection")
		return nil, nil, nil
	}
	base := strings.TrimPrefix(oid.Dot1qVlanStaticName, ".")
	for _, pdu := range namePDUs {
		full := strings.TrimPrefix(pdu.Name, ".")
		if !strings.HasPrefix(full, base+".") {
			continue
		}
		suffix := full[len(base)+1:]
		vlanID, err := strconv.Atoi(suffix)
		if err != nil {
			continue
		}
		vlanNames[vlanID] = client.PDUString(pdu)
	}

	// Fallback: probe current VLAN table for IDs when static table is empty.
	// Try EgressPorts (col 3) first; some vendors (e.g. Arista EOS) only populate
	// UntaggedPorts (col 4), so fall through to that if col 3 is empty.
	if len(vlanNames) == 0 {
		for _, probeOID := range []string{oid.Dot1qVlanCurrentEgressPorts, oid.Dot1qVlanCurrentUntaggedPorts} {
			probe, _ := s.BulkWalkAll(probeOID)
			for _, pdu := range probe {
				if vlanID, ok := parseVlanCurrentIndex(pdu.Name, probeOID); ok {
					if _, exists := vlanNames[vlanID]; !exists {
						vlanNames[vlanID] = ""
					}
				}
			}
			if len(vlanNames) > 0 {
				break
			}
		}
		if len(vlanNames) == 0 {
			log.Debug().Msg("vlan: no Q-BRIDGE-MIB VLAN data found on this device")
			return nil, nil, nil
		}
	}

	vlans := make([]*model.VLANResult, 0, len(vlanNames))
	for id, name := range vlanNames {
		vlans = append(vlans, &model.VLANResult{
			DeviceID: deviceID,
			VlanID:   id,
			Name:     name,
		})
	}

	// ── 2. Build bridge port → ifIndex mapping (dot1dBasePortTable col 2) ─────
	bridgePortToIfIdx := buildBridgePortMap(s)

	// ── 3+4. Walk egress and untagged port bitmaps ────────────────────────────
	// EgressPorts (col 3) = all ports (tagged+untagged) in the VLAN.
	// UntaggedPorts (col 4) = access/native ports (untagged egress).
	// Some devices (e.g. Arista EOS) only populate col 4; in that case use it
	// as egress too — all reported ports are access ports, correctly untagged.
	egressPDUs, _ := s.BulkWalkAll(oid.Dot1qVlanCurrentEgressPorts)
	untagPDUs, _ := s.BulkWalkAll(oid.Dot1qVlanCurrentUntaggedPorts)

	// If egress is empty but untagged has data, treat untagged as egress.
	useUntagAsEgress := len(egressPDUs) == 0 && len(untagPDUs) > 0
	if useUntagAsEgress {
		egressPDUs = untagPDUs
	}
	if len(egressPDUs) == 0 {
		return vlans, nil, nil
	}

	egressBitmaps := make(map[int][]byte)
	for _, pdu := range egressPDUs {
		vlanID, ok := parseVlanCurrentIndex(pdu.Name, oid.Dot1qVlanCurrentEgressPorts)
		if !ok {
			vlanID, ok = parseVlanCurrentIndex(pdu.Name, oid.Dot1qVlanCurrentUntaggedPorts)
		}
		if !ok {
			continue
		}
		if b, ok2 := pdu.Value.([]byte); ok2 {
			egressBitmaps[vlanID] = b
		}
	}

	untagBitmaps := make(map[int][]byte)
	if useUntagAsEgress {
		// Same data for both — all ports are untagged access ports
		for k, v := range egressBitmaps {
			untagBitmaps[k] = v
		}
	} else {
		for _, pdu := range untagPDUs {
			vlanID, ok := parseVlanCurrentIndex(pdu.Name, oid.Dot1qVlanCurrentUntaggedPorts)
			if !ok {
				continue
			}
			if b, ok2 := pdu.Value.([]byte); ok2 {
				untagBitmaps[vlanID] = b
			}
		}
	}

	// ── 5. Build InterfaceVLANResults from egress bitmaps ─────────────────────
	var ifvlans []*model.InterfaceVLANResult
	for vlanID, egress := range egressBitmaps {
		untag := untagBitmaps[vlanID]
		for portNum := 1; portNum <= len(egress)*8; portNum++ {
			if !bitmapBitSet(egress, portNum) {
				continue
			}
			ifIdx, ok := bridgePortToIfIdx[portNum]
			if !ok {
				if len(bridgePortToIfIdx) > 0 {
					continue // map exists but port not in it — skip
				}
				ifIdx = portNum // no bridge map → assume portNum == ifIndex (Arista EOS)
			}
			tagged := !bitmapBitSet(untag, portNum)
			ifvlans = append(ifvlans, &model.InterfaceVLANResult{
				DeviceID: deviceID,
				IfIndex:  ifIdx,
				VlanID:   vlanID,
				Tagged:   tagged,
			})
		}
	}

	return vlans, ifvlans, nil
}

// buildBridgePortMap walks dot1dBasePortTable and returns a map of
// bridge port number → ifIndex.  Errors are swallowed — callers get an empty map.
func buildBridgePortMap(s *client.Session) map[int]int {
	portPDUs, err := s.BulkWalkAll(oid.MACPortTable)
	m := make(map[int]int)
	if err != nil {
		log.Warn().Err(err).Msg("vlan: dot1dBasePortTable walk failed")
		return m
	}
	for _, pdu := range portPDUs {
		col, portNum := splitBridgePortIndex(pdu.Name)
		if col == 2 && portNum > 0 { // dot1dBasePortIfIndex
			m[portNum] = client.PDUInt(pdu)
		}
	}
	return m
}

// parseVlanCurrentIndex extracts the VlanIndex from a dot1qVlanCurrent* PDU name.
// The OID suffix after the table base is: col.TimeMark.VlanIndex
// We skip TimeMark and return VlanIndex.
func parseVlanCurrentIndex(pduName, tableBase string) (vlanID int, ok bool) {
	full := strings.TrimPrefix(pduName, ".")
	base := strings.TrimPrefix(tableBase, ".")
	if !strings.HasPrefix(full, base+".") {
		return 0, false
	}
	// suffix = "timeMark.vlanID"
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

// bitmapBitSet reports whether bridge port portNum (1-indexed, MSB-first) is
// set in the given octet-string bitmap.
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

// PollVLANsJuniper collects VLAN definitions (name + 802.1Q tag) using
// JUNIPER-VLAN-MIB's jnxExVlanTable, used as a fallback on Junos devices whose
// Q-BRIDGE-MIB tables come back empty (confirmed unimplemented on at least
// Junos EX3300 15.1R6/R7). No per-interface membership is returned — no
// physical-port-to-VLAN table was found via SNMP on this platform, only the
// VLAN-to-L3-IRB-interface binding, which isn't the same thing.
func PollVLANsJuniper(s *client.Session, deviceID uuid.UUID) ([]*model.VLANResult, error) {
	namePDUs, err := s.BulkWalkAll(oid.JnxExVlanName)
	if err != nil {
		return nil, err
	}
	names := make(map[int]string)
	nameBase := strings.TrimPrefix(oid.JnxExVlanName, ".")
	for _, pdu := range namePDUs {
		full := strings.TrimPrefix(pdu.Name, ".")
		if !strings.HasPrefix(full, nameBase+".") {
			continue
		}
		idx, err := strconv.Atoi(full[len(nameBase)+1:])
		if err != nil {
			continue
		}
		names[idx] = client.PDUString(pdu)
	}
	if len(names) == 0 {
		log.Debug().Msg("vlan(juniper): jnxExVlanName empty — device may not support JUNIPER-VLAN-MIB")
		return nil, nil
	}

	tagPDUs, _ := s.BulkWalkAll(oid.JnxExVlanTag)
	tags := make(map[int]int)
	tagBase := strings.TrimPrefix(oid.JnxExVlanTag, ".")
	for _, pdu := range tagPDUs {
		full := strings.TrimPrefix(pdu.Name, ".")
		if !strings.HasPrefix(full, tagBase+".") {
			continue
		}
		idx, err := strconv.Atoi(full[len(tagBase)+1:])
		if err != nil {
			continue
		}
		tags[idx] = client.PDUInt(pdu)
	}

	vlans := make([]*model.VLANResult, 0, len(names))
	for idx, name := range names {
		tag := tags[idx]
		if tag <= 0 {
			continue
		}
		vlans = append(vlans, &model.VLANResult{DeviceID: deviceID, VlanID: tag, Name: name})
	}
	log.Debug().Int("vlans", len(vlans)).Msg("vlan(juniper): jnxExVlanTable parsed")
	return vlans, nil
}

// PollVLANsHPICF collects VLAN data using HP-ICF-VLAN-MIB, used on HP ProCurve
// and Aruba ProVision switches that do not populate Q-BRIDGE-MIB tables.
//
//	hpicfVlanInfoName         → VLAN names indexed by VlanID
//	hpicfVlanPortInfoVlanId   → access (native) VLAN per ifIndex
//	hpicfVlanPortInfoTaggedVlans → tagged VLAN bitmap per ifIndex
func PollVLANsHPICF(s *client.Session, deviceID uuid.UUID) ([]*model.VLANResult, []*model.InterfaceVLANResult, error) {
	// ── 1. VLAN names ─────────────────────────────────────────────────────────
	namePDUs, _ := s.BulkWalkAll(oid.HpicfVlanInfoName)
	vlanNames := make(map[int]string)
	nameBase := strings.TrimPrefix(oid.HpicfVlanInfoName, ".")
	for _, pdu := range namePDUs {
		full := strings.TrimPrefix(pdu.Name, ".")
		if !strings.HasPrefix(full, nameBase+".") {
			continue
		}
		id, err := strconv.Atoi(full[len(nameBase)+1:])
		if err != nil {
			continue
		}
		vlanNames[id] = client.PDUString(pdu)
	}
	if len(vlanNames) == 0 {
		log.Debug().Msg("vlan(hpicf): no VLAN data found")
		return nil, nil, nil
	}
	log.Debug().Int("vlans", len(vlanNames)).Msg("vlan(hpicf): found VLANs")

	vlans := make([]*model.VLANResult, 0, len(vlanNames))
	for id, name := range vlanNames {
		vlans = append(vlans, &model.VLANResult{DeviceID: deviceID, VlanID: id, Name: name})
	}

	// ── 2. Port assignments via Q-BRIDGE-MIB ─────────────────────────────────
	// ProCurve supports dot1qPvid (access VLAN per bridge port) and
	// dot1qVlanCurrentEgressPorts/UntaggedPorts (membership bitmaps per VLAN)
	// even though dot1qVlanStaticTable is not populated.
	// Bridge port → ifIndex mapping comes from dot1dBasePortTable.
	bridgeToIfIdx := buildBridgePortMap(s)

	// Access VLAN per bridge port (dot1qPvid)
	pvPDUs, _ := s.BulkWalkAll(oid.Dot1qPvid)
	accessByIfIdx := make(map[int]int) // ifIndex → access VLAN ID
	pvBase := strings.TrimPrefix(oid.Dot1qPvid, ".")
	for _, pdu := range pvPDUs {
		full := strings.TrimPrefix(pdu.Name, ".")
		if !strings.HasPrefix(full, pvBase+".") {
			continue
		}
		bp, err := strconv.Atoi(full[len(pvBase)+1:])
		if err != nil {
			continue
		}
		ifIdx := bridgeToIfIdx[bp]
		if ifIdx == 0 {
			ifIdx = bp // ProCurve often maps bridge port == ifIndex
		}
		accessByIfIdx[ifIdx] = client.PDUInt(pdu)
	}

	// Egress (tagged+untagged) and untagged bitmaps per VLAN
	egressPDUs, _ := s.BulkWalkAll(oid.Dot1qVlanCurrentEgressPorts)
	untagPDUs, _ := s.BulkWalkAll(oid.Dot1qVlanCurrentUntaggedPorts)
	egressBitmaps := make(map[int][]byte)
	untagBitmaps := make(map[int][]byte)
	for _, pdu := range egressPDUs {
		if vlanID, ok := parseVlanCurrentIndex(pdu.Name, oid.Dot1qVlanCurrentEgressPorts); ok {
			if b, ok2 := pdu.Value.([]byte); ok2 {
				egressBitmaps[vlanID] = b
			}
		}
	}
	for _, pdu := range untagPDUs {
		if vlanID, ok := parseVlanCurrentIndex(pdu.Name, oid.Dot1qVlanCurrentUntaggedPorts); ok {
			if b, ok2 := pdu.Value.([]byte); ok2 {
				untagBitmaps[vlanID] = b
			}
		}
	}

	// ── 3. Build InterfaceVLANResults ─────────────────────────────────────────
	var ifvlans []*model.InterfaceVLANResult

	// Access VLAN (untagged) per port from dot1qPvid
	for ifIdx, vlanID := range accessByIfIdx {
		if vlanID == 0 {
			continue
		}
		ifvlans = append(ifvlans, &model.InterfaceVLANResult{
			DeviceID: deviceID,
			IfIndex:  ifIdx,
			VlanID:   vlanID,
			Tagged:   false,
		})
	}

	// Tagged memberships from egress bitmaps (egress but not in untagged = tagged)
	for vlanID, egress := range egressBitmaps {
		untag := untagBitmaps[vlanID]
		for portNum := 1; portNum <= len(egress)*8; portNum++ {
			if !bitmapBitSet(egress, portNum) {
				continue
			}
			if bitmapBitSet(untag, portNum) {
				continue // untagged — already handled via dot1qPvid
			}
			ifIdx := bridgeToIfIdx[portNum]
			if ifIdx == 0 {
				ifIdx = portNum
			}
			ifvlans = append(ifvlans, &model.InterfaceVLANResult{
				DeviceID: deviceID,
				IfIndex:  ifIdx,
				VlanID:   vlanID,
				Tagged:   true,
			})
		}
	}

	return vlans, ifvlans, nil
}
