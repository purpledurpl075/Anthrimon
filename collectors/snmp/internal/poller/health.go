package poller

import (
	"fmt"
	"math"
	"strings"
	"time"
	"unicode"

	"github.com/gosnmp/gosnmp"
	"github.com/google/uuid"
	"github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/client"
	"github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/model"
	"github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/oid"
	"github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/vendor"
)

// PollHealth collects CPU, memory, and temperature metrics from a device.
// Vendor-specific OID sets override the standard MIBs when the profile
// provides them; otherwise standard HOST-RESOURCES-MIB and ENTITY-SENSOR-MIB
// are used.
func PollHealth(s *client.Session, deviceID uuid.UUID, profile *vendor.Profile, sysUpTimeTicks uint32) (*model.HealthResult, error) {
	uptimeTicks := sysUpTimeTicks
	if profile != nil && profile.UptimeOID != "" {
		if pdus, err := s.Get([]string{profile.UptimeOID}); err == nil && len(pdus) > 0 {
			uptimeTicks = uint32(client.PDUUint64(pdus[0]))
		}
	}
	result := &model.HealthResult{
		DeviceID:   deviceID,
		UptimeSecs: uint64(uptimeTicks) / 100,
		PollTime:   time.Now().UTC(),
	}

	var err error
	result.CPUSamples, err = pollCPU(s, profile)
	if err != nil {
		return nil, err
	}

	result.MemSamples, err = pollMemory(s, profile)
	if err != nil {
		return nil, err
	}

	result.TempSamples, err = pollTemperature(s, profile)
	if err != nil {
		return nil, err
	}

	// Optical power collection is best-effort; skip on devices with no transceivers.
	if profile == nil || !profile.SkipDOM {
		result.OpticalSamples, _ = pollOpticalSensors(s, profile)
	}

	return result, nil
}

// pollOpticalSensors collects DOM TX/RX optical power readings.
// For Juniper it uses JUNIPER-DOM-MIB; for all other vendors it walks
// ENTITY-SENSOR-MIB for both type-6 (watts) and type-14 (dBm) sensors.
func pollOpticalSensors(s *client.Session, profile *vendor.Profile) ([]model.OpticalSample, error) {
	if profile != nil && profile.DBVendorType == "juniper" {
		return pollOpticalSensorsJuniper(s)
	}
	return pollOpticalSensorsEntity(s)
}

// pollOpticalSensorsEntity walks ENTITY-SENSOR-MIB (RFC 3433) for optical power
// sensors of type 6 (watts, used by Arista EOS and Aruba-CX) and type 14 (dBm,
// used by Cisco IOS-XE/XR/NX-OS).  Watts are converted mW→dBm; dBm values are
// used directly after applying the standard RFC 3433 scale/precision.
func pollOpticalSensorsEntity(s *client.Session) ([]model.OpticalSample, error) {
	typePDUs, err := s.BulkWalkAll(oid.EntPhySensorType)
	if err != nil || len(typePDUs) == 0 {
		return nil, nil
	}

	// Collect indexes of optical-power sensors (watts or dBm), tracking type.
	type sensorMeta struct{ sensorType int }
	optIndexes := make(map[string]sensorMeta)
	for _, pdu := range typePDUs {
		t := client.PDUInt(pdu)
		if t == oid.EntSensorTypeWatts || t == oid.EntSensorTypeDBm {
			idx := formatIndex(pdu.Name, oid.EntPhySensorType)
			if idx != "" {
				optIndexes[idx] = sensorMeta{sensorType: t}
			}
		}
	}
	if len(optIndexes) == 0 {
		return nil, nil
	}

	// Read raw sensor values.
	valuePDUs, err := s.BulkWalkAll(oid.EntPhySensorValue)
	if err != nil {
		return nil, nil
	}
	valueByIdx := make(map[string]int)
	for _, pdu := range valuePDUs {
		idx := formatIndex(pdu.Name, oid.EntPhySensorValue)
		if _, ok := optIndexes[idx]; ok {
			valueByIdx[idx] = client.PDUInt(pdu)
		}
	}

	// Read scale and precision for unit conversion.
	scaleByIdx := make(map[string]int)
	if sp, e := s.BulkWalkAll(oid.EntPhySensorScale); e == nil {
		for _, pdu := range sp {
			idx := formatIndex(pdu.Name, oid.EntPhySensorScale)
			if _, ok := optIndexes[idx]; ok {
				scaleByIdx[idx] = client.PDUInt(pdu)
			}
		}
	}
	precByIdx := make(map[string]int)
	if pp, e := s.BulkWalkAll(oid.EntPhySensorPrecision); e == nil {
		for _, pdu := range pp {
			idx := formatIndex(pdu.Name, oid.EntPhySensorPrecision)
			if _, ok := optIndexes[idx]; ok {
				precByIdx[idx] = client.PDUInt(pdu)
			}
		}
	}

	// Resolve sensor names from entPhysicalName / entPhysicalDescr.
	nameByIdx := make(map[string]string)
	if np, e := s.BulkWalkAll(oid.EntPhysicalName); e == nil {
		for _, pdu := range np {
			idx := formatIndex(pdu.Name, oid.EntPhysicalName)
			if v := client.PDUString(pdu); v != "" {
				nameByIdx[idx] = v
			}
		}
	}
	if dp, e := s.BulkWalkAll(oid.EntPhysicalDescr); e == nil {
		for _, pdu := range dp {
			idx := formatIndex(pdu.Name, oid.EntPhysicalDescr)
			if _, already := nameByIdx[idx]; !already {
				if v := client.PDUString(pdu); v != "" {
					nameByIdx[idx] = v
				}
			}
		}
	}

	var samples []model.OpticalSample
	for idx, rawVal := range valueByIdx {
		name := nameByIdx[idx]
		if name == "" {
			continue
		}
		// Filter to optical power sensors by description.
		lower := strings.ToLower(name)
		if !isOpticalPowerSensor(lower) {
			continue
		}

		// RFC 3433 scale: actual exponent = (enum - 9) * 3
		scaleEnum := scaleByIdx[idx]
		if scaleEnum == 0 {
			scaleEnum = oid.EntSensorScaleUnits
		}
		scaleExp := (scaleEnum - oid.EntSensorScaleUnits) * 3
		precision := precByIdx[idx]

		var dbm float64
		meta := optIndexes[idx]
		if meta.sensorType == oid.EntSensorTypeDBm {
			// Value is already in dBm; apply scale/precision only.
			dbm = float64(rawVal) * math.Pow10(scaleExp) / math.Pow10(precision)
		} else {
			// Type 6 = watts; convert mW → dBm.
			watts := float64(rawVal) * math.Pow10(scaleExp) / math.Pow10(precision)
			mw := watts * 1000.0
			if mw > 0 {
				dbm = 10.0 * math.Log10(mw)
			} else {
				dbm = -40.0
			}
		}
		dbm = math.Round(dbm*1000) / 1000

		samples = append(samples, model.OpticalSample{
			IfaceName:  extractIfaceName(name),
			SensorName: name,
			Direction:  classifyOpticalDirection(name),
			PowerDBm:   dbm,
		})
	}
	return samples, nil
}

// pollOpticalSensorsJuniper walks JUNIPER-DOM-MIB for TX and RX optical power.
// Values are in units of 0.001 mW (1 µW); convert to dBm.
// Indexed by ifIndex, resolved to interface name via IF-MIB ifDescr.
func pollOpticalSensorsJuniper(s *client.Session) ([]model.OpticalSample, error) {
	// Resolve ifIndex → interface name.
	descrPDUs, err := s.BulkWalkAll("1.3.6.1.2.1.2.2.1.2") // ifDescr
	if err != nil {
		return nil, nil
	}
	ifName := make(map[string]string)
	for _, pdu := range descrPDUs {
		parts := strings.Split(pdu.Name, ".")
		if len(parts) < 1 {
			continue
		}
		idx := parts[len(parts)-1]
		if v := client.PDUString(pdu); v != "" {
			ifName[idx] = v
		}
	}

	toDBm := func(val int) float64 {
		mw := float64(val) * 0.001
		if mw <= 0 {
			return -40.0
		}
		return math.Round(10.0*math.Log10(mw)*1000) / 1000
	}

	var samples []model.OpticalSample
	for _, pair := range []struct {
		tableOID  string
		direction string
	}{
		{oid.JnxDomCurrentTxPower, "tx"},
		{oid.JnxDomCurrentRxPower, "rx"},
	} {
		pdus, e := s.BulkWalkAll(pair.tableOID)
		if e != nil {
			continue
		}
		for _, pdu := range pdus {
			parts := strings.Split(pdu.Name, ".")
			ifIdx := parts[len(parts)-1]
			iface := ifName[ifIdx]
			if iface == "" {
				continue
			}
			val := client.PDUInt(pdu)
			samples = append(samples, model.OpticalSample{
				IfaceName:  iface,
				SensorName: iface + " DOM " + pair.direction + " power",
				Direction:  pair.direction,
				PowerDBm:   toDBm(val),
			})
		}
	}
	return samples, nil
}

// isOpticalPowerSensor returns true when the lowercase sensor description
// suggests an optical TX or RX power reading.
func isOpticalPowerSensor(lower string) bool {
	return strings.Contains(lower, "dom") ||
		strings.Contains(lower, "tx power") ||
		strings.Contains(lower, "rx power") ||
		strings.Contains(lower, "tx-power") ||
		strings.Contains(lower, "rx-power") ||
		strings.Contains(lower, "txpower") ||
		strings.Contains(lower, "rxpower") ||
		strings.Contains(lower, "optical power") ||
		strings.Contains(lower, "laser output power") ||
		strings.Contains(lower, "laser rx power")
}

// extractIfaceName extracts the interface name from a sensor description.
//
// Handles two common patterns:
//   - Arista / most vendors: "DOM TX Power Sensor for Ethernet2"  → "Ethernet2"
//   - Cisco / Aruba-CX:      "GigabitEthernet0/0/0 Tx Power Sensor" → "GigabitEthernet0/0/0"
func extractIfaceName(sensorName string) string {
	lower := strings.ToLower(sensorName)

	// Pattern 1: "... for <iface>" (Arista EOS and similar).
	const sep = " for "
	if idx := strings.LastIndex(lower, sep); idx >= 0 {
		iface := strings.TrimSpace(sensorName[idx+len(sep):])
		return strings.TrimRightFunc(iface, func(r rune) bool {
			return !unicode.IsPrint(r) || r > 127
		})
	}

	// Pattern 2: "<iface> <optical-keyword> ..." (Cisco IOS-XE/XR, Aruba-CX).
	// Strip the first optical keyword and everything after it.
	for _, kw := range []string{" tx power", " rx power", " tx-power", " rx-power",
		" txpower", " rxpower", " dom", " transceiver", " optical", " laser"} {
		if i := strings.Index(lower, kw); i > 0 {
			return strings.TrimSpace(sensorName[:i])
		}
	}

	return sensorName
}

// classifyOpticalDirection returns "tx", "rx", or "unknown" from the sensor name.
func classifyOpticalDirection(name string) string {
	lower := strings.ToLower(name)
	switch {
	case strings.Contains(lower, "tx") || strings.Contains(lower, "transmit"):
		return "tx"
	case strings.Contains(lower, "rx") || strings.Contains(lower, "receive"):
		return "rx"
	default:
		return "unknown"
	}
}

// ── CPU ───────────────────────────────────────────────────────────────────────

func pollCPU(s *client.Session, profile *vendor.Profile) ([]model.CPUSample, error) {
	if profile != nil && profile.CPUOIDs != nil {
		return pollCPUVendor(s, profile)
	}
	return pollCPUStandard(s)
}

// pollCPUStandard walks hrProcessorLoad (one row per CPU, value 0–100).
func pollCPUStandard(s *client.Session) ([]model.CPUSample, error) {
	pdus, err := s.BulkWalkAll(oid.HrProcessorLoad)
	if err != nil {
		return nil, err
	}
	var samples []model.CPUSample
	for i, pdu := range pdus {
		samples = append(samples, model.CPUSample{
			CPUIndex: i,
			LoadPct:  float64(client.PDUUint64(pdu)),
		})
	}
	return samples, nil
}

// pollCPUVendor handles vendor-specific CPU OID sets.
func pollCPUVendor(s *client.Session, profile *vendor.Profile) ([]model.CPUSample, error) {
	oset := profile.CPUOIDs
	var samples []model.CPUSample

	for _, walkOID := range oset.Walk {
		pdus, err := s.BulkWalkAll(walkOID)
		if err != nil {
			return nil, err
		}
		for i, pdu := range pdus {
			samples = append(samples, model.CPUSample{
				CPUIndex: i,
				LoadPct:  float64(client.PDUUint64(pdu)),
			})
		}
	}

	if len(oset.Scalar) > 0 {
		pdus, err := s.Get(oset.Scalar)
		if err != nil {
			return nil, err
		}
		for i, pdu := range pdus {
			load := float64(client.PDUUint64(pdu))
			if oset.IdleComplement {
				load = 100 - load // ssCpuIdle → CPU usage
			}
			samples = append(samples, model.CPUSample{
				CPUIndex: i,
				LoadPct:  load,
			})
		}
	}

	return samples, nil
}

// ── Memory ────────────────────────────────────────────────────────────────────

func pollMemory(s *client.Session, profile *vendor.Profile) ([]model.MemorySample, error) {
	if profile != nil && profile.MemoryOIDs != nil {
		return pollMemoryVendor(s, profile)
	}
	return pollMemoryStandard(s)
}

// pollMemoryStandard walks hrStorageTable and keeps RAM and virtual-memory rows.
func pollMemoryStandard(s *client.Session) ([]model.MemorySample, error) {
	pdus, err := s.BulkWalkAll(oid.HrStorageTable)
	if err != nil {
		return nil, err
	}

	type storageRow struct {
		storageType string
		descr       string
		allocUnits  uint64
		size        uint64
		used        uint64
	}

	rows := make(map[int]*storageRow)
	ensureRow := func(i int) *storageRow {
		if r, ok := rows[i]; ok {
			return r
		}
		r := &storageRow{}
		rows[i] = r
		return r
	}

	for _, pdu := range pdus {
		col, idx := splitTableOID(pdu.Name, oid.HrStorageTable)
		if idx < 0 {
			continue
		}
		r := ensureRow(idx)
		switch col {
		case 2:
			r.storageType = client.PDUString(pdu)
		case 3:
			r.descr = client.PDUString(pdu)
		case 4:
			r.allocUnits = client.PDUUint64(pdu)
		case 5:
			r.size = client.PDUUint64(pdu)
		case 6:
			r.used = client.PDUUint64(pdu)
		}
	}

	var samples []model.MemorySample
	for _, r := range rows {
		t := classifyStorageType(r.storageType)
		if t != "ram" && t != "virtual" {
			continue
		}
		if r.size == 0 {
			continue
		}
		samples = append(samples, model.MemorySample{
			Descr:      r.descr,
			Type:       t,
			TotalBytes: r.size * r.allocUnits,
			UsedBytes:  r.used * r.allocUnits,
		})
	}
	return samples, nil
}

// pollMemoryVendor handles vendor-specific memory OID sets.
//
// Scalar convention (e.g. FortiGate): first OID = % used, second = total KB.
// Walk convention (e.g. HP ProCurve hpicfMemEntry): each walked subtree is a
// table where column 3 = allocated/used bytes, column 4 = free bytes per row.
func pollMemoryVendor(s *client.Session, profile *vendor.Profile) ([]model.MemorySample, error) {
	oset := profile.MemoryOIDs

	if len(oset.Scalar) >= 2 {
		pdus, err := s.Get(oset.Scalar[:2])
		if err != nil {
			return nil, err
		}
		if len(pdus) < 2 {
			return nil, nil
		}
		var totalBytes, usedBytes uint64
		if oset.KBAvailable {
			// UCD-SNMP: [totalKB, availKB]; used = total - avail
			totalKB := client.PDUUint64(pdus[0])
			availKB := client.PDUUint64(pdus[1])
			totalBytes = totalKB * 1024
			if availKB < totalKB {
				usedBytes = (totalKB - availKB) * 1024
			}
		} else {
			// FortiGate: [usedPct, totalKB]
			usedPct := client.PDUUint64(pdus[0])
			totalKB := client.PDUUint64(pdus[1])
			totalBytes = totalKB * 1024
			usedBytes = totalBytes * usedPct / 100
		}
		return []model.MemorySample{{
			Descr:      "RAM",
			Type:       "ram",
			TotalBytes: totalBytes,
			UsedBytes:  usedBytes,
		}}, nil
	}

	// Walk convention: col 3 = total bytes, col 4 = used bytes per row.
	// Used by HP-ICF hpicfMemoryTable and any future vendor with same layout.
	var samples []model.MemorySample
	for _, walkOID := range oset.Walk {
		pdus, err := s.BulkWalkAll(walkOID)
		if err != nil {
			return nil, err
		}

		type memRow struct{ used, free uint64 }
		rows := make(map[int]*memRow)
		ensureRow := func(i int) *memRow {
			if r, ok := rows[i]; ok {
				return r
			}
			r := &memRow{}
			rows[i] = r
			return r
		}

		for _, pdu := range pdus {
			col, idx := splitTableOID(pdu.Name, walkOID)
			if idx < 0 {
				continue
			}
			// HP-ICF hpicfMemEntryData (WA/WB firmware, walked from .1.1.1):
			// col 6 = bytes allocated (used), col 7 = bytes free.
			// Older MIB cols 3/4 exist but return 0 on WB.16+ firmware.
			switch col {
			case 6:
				ensureRow(idx).used = client.PDUUint64(pdu)
			case 7:
				ensureRow(idx).free = client.PDUUint64(pdu)
			}
		}

		for i, r := range rows {
			total := r.used + r.free
			if total == 0 {
				continue
			}
			samples = append(samples, model.MemorySample{
				Descr:      fmt.Sprintf("RAM%d", i),
				Type:       "ram",
				TotalBytes: total,
				UsedBytes:  r.used,
			})
		}
	}
	return samples, nil
}

func classifyStorageType(typeOID string) string {
	t := strings.TrimPrefix(typeOID, ".")
	switch t {
	case strings.TrimPrefix(oid.HrStorageTypeRam, "."):
		return "ram"
	case strings.TrimPrefix(oid.HrStorageTypeVirtualMemory, "."):
		return "virtual"
	case strings.TrimPrefix(oid.HrStorageTypeFlash, "."):
		return "flash"
	default:
		return "other"
	}
}

// ── Temperature ───────────────────────────────────────────────────────────────

func pollTemperature(s *client.Session, profile *vendor.Profile) ([]model.TempSample, error) {
	if profile == nil || profile.TempOIDs == nil {
		return pollTempEntitySensor(s)
	}
	switch profile.DBVendorType {
	case "cisco_ios", "cisco_iosxe":
		return pollTempCiscoEnvmon(s)
	case "fortios":
		return pollTempFortiGate(s)
	case "juniper":
		return pollTempJuniper(s)
	default:
		return pollTempEntitySensor(s)
	}
}

// pollTempEntitySensor reads ENTITY-SENSOR-MIB for celsius-type sensors.
// Works on: IOS-XR, Arista EOS, Aruba-CX, NX-OS, and most modern gear.
func pollTempEntitySensor(s *client.Session) ([]model.TempSample, error) {
	typePDUs, err := s.BulkWalkAll(oid.EntPhySensorType)
	if err != nil || len(typePDUs) == 0 {
		return nil, nil
	}

	celsiusIndexes := make(map[string]bool)
	for _, pdu := range typePDUs {
		if client.PDUInt(pdu) == oid.EntSensorTypeCelsius {
			idx := formatIndex(pdu.Name, oid.EntPhySensorType)
			if idx != "" {
				celsiusIndexes[idx] = true
			}
		}
	}
	if len(celsiusIndexes) == 0 {
		return nil, nil
	}

	valuePDUs, err := s.BulkWalkAll(oid.EntPhySensorValue)
	if err != nil {
		return nil, nil
	}
	valueByIdx := make(map[string]int)
	for _, pdu := range valuePDUs {
		idx := formatIndex(pdu.Name, oid.EntPhySensorValue)
		if celsiusIndexes[idx] {
			valueByIdx[idx] = client.PDUInt(pdu)
		}
	}

	// Read scale and precision so we can convert raw integer to °C correctly.
	// RFC 3433: actual = value * 10^(scale_exp) / 10^precision
	// scale=units(9) → 10^0; precision=1 → divide by 10 (most common for temp).
	scaleByIdx := make(map[string]int)
	if scalePDUs, err2 := s.BulkWalkAll(oid.EntPhySensorScale); err2 == nil {
		for _, pdu := range scalePDUs {
			idx := formatIndex(pdu.Name, oid.EntPhySensorScale)
			if celsiusIndexes[idx] {
				scaleByIdx[idx] = client.PDUInt(pdu)
			}
		}
	}
	precisionByIdx := make(map[string]int)
	if precPDUs, err2 := s.BulkWalkAll(oid.EntPhySensorPrecision); err2 == nil {
		for _, pdu := range precPDUs {
			idx := formatIndex(pdu.Name, oid.EntPhySensorPrecision)
			if celsiusIndexes[idx] {
				precisionByIdx[idx] = client.PDUInt(pdu)
			}
		}
	}

	// Try entPhysicalName first; fall back to entPhysicalDescr (Arista EOS returns
	// empty strings for Name but populates Descr with human-readable sensor labels).
	nameByIdx := make(map[string]string)
	if namePDUs, err2 := s.BulkWalkAll(oid.EntPhysicalName); err2 == nil {
		for _, pdu := range namePDUs {
			idx := formatIndex(pdu.Name, oid.EntPhysicalName)
			if v := client.PDUString(pdu); v != "" {
				nameByIdx[idx] = v
			}
		}
	}
	if descrPDUs, err2 := s.BulkWalkAll(oid.EntPhysicalDescr); err2 == nil {
		for _, pdu := range descrPDUs {
			idx := formatIndex(pdu.Name, oid.EntPhysicalDescr)
			if _, already := nameByIdx[idx]; !already {
				if v := client.PDUString(pdu); v != "" {
					nameByIdx[idx] = v
				}
			}
		}
	}

	var samples []model.TempSample
	for idx, rawVal := range valueByIdx {
		name := nameByIdx[idx]
		if name == "" {
			name = "Sensor " + idx
		}

		// RFC 3433 SensorDataScale: exponent = (enum - 9) * 3
		// milli(8)→-3, units(9)→0, kilo(10)→+3, mega(11)→+6, etc.
		scaleEnum := scaleByIdx[idx]
		if scaleEnum == 0 {
			scaleEnum = oid.EntSensorScaleUnits
		}
		scaleExp  := (scaleEnum - oid.EntSensorScaleUnits) * 3
		precision := precisionByIdx[idx]

		celsius := float64(rawVal) * math.Pow10(scaleExp) / math.Pow10(precision)

		samples = append(samples, model.TempSample{
			SensorName: name,
			Celsius:    math.Round(celsius*10) / 10, // round to 1 decimal
			StatusOK:   true,
		})
	}
	return samples, nil
}

// pollTempCiscoEnvmon reads CISCO-ENVMON-MIB temperature table.
func pollTempCiscoEnvmon(s *client.Session) ([]model.TempSample, error) {
	descrPDUs, err := s.BulkWalkAll(oid.CiscoEnvMonTempDescr)
	if err != nil || len(descrPDUs) == 0 {
		return pollTempEntitySensor(s)
	}

	valuePDUs, err := s.BulkWalkAll(oid.CiscoEnvMonTempValue)
	if err != nil {
		return nil, err
	}
	statePDUs, _ := s.BulkWalkAll(oid.CiscoEnvMonTempState)

	descrByIdx := indexPDUs(descrPDUs, oid.CiscoEnvMonTempDescr)
	valueByIdx := indexIntPDUs(valuePDUs, oid.CiscoEnvMonTempValue)
	stateByIdx := indexIntPDUs(statePDUs, oid.CiscoEnvMonTempState)

	var samples []model.TempSample
	for idx, descr := range descrByIdx {
		celsius, ok := valueByIdx[idx]
		if !ok {
			continue
		}
		state := stateByIdx[idx]
		samples = append(samples, model.TempSample{
			SensorName: client.PDUString(descr),
			Celsius:    float64(celsius),
			StatusOK:   state == 1 || state == 0,
		})
	}
	return samples, nil
}

// pollTempJuniper reads jnxOperating table and returns non-zero temperature rows.
func pollTempJuniper(s *client.Session) ([]model.TempSample, error) {
	descrPDUs, err := s.BulkWalkAll(oid.JnxOperatingDescr)
	if err != nil || len(descrPDUs) == 0 {
		return nil, nil
	}
	tempPDUs, err := s.BulkWalkAll(oid.JnxOperatingTemp)
	if err != nil {
		return nil, err
	}

	descrByIdx := indexPDUs(descrPDUs, oid.JnxOperatingDescr)
	tempByIdx := indexIntPDUs(tempPDUs, oid.JnxOperatingTemp)

	var samples []model.TempSample
	for idx, temp := range tempByIdx {
		if temp == 0 {
			continue
		}
		name := "Component"
		if d, ok := descrByIdx[idx]; ok {
			name = client.PDUString(d)
		}
		samples = append(samples, model.TempSample{
			SensorName: name,
			Celsius:    float64(temp),
			StatusOK:   true,
		})
	}
	return samples, nil
}

// pollTempFortiGate reads Fortinet hardware sensor table and returns
// entries whose names contain "temp" (case-insensitive).
func pollTempFortiGate(s *client.Session) ([]model.TempSample, error) {
	namePDUs, err := s.BulkWalkAll(oid.FgHwSensorEntName)
	if err != nil || len(namePDUs) == 0 {
		return nil, nil
	}
	valuePDUs, err := s.BulkWalkAll(oid.FgHwSensorEntValue)
	if err != nil {
		return nil, err
	}

	nameByIdx := indexPDUs(namePDUs, oid.FgHwSensorEntName)
	valueByIdx := indexIntPDUs(valuePDUs, oid.FgHwSensorEntValue)

	var samples []model.TempSample
	for idx, namePDU := range nameByIdx {
		name := client.PDUString(namePDU)
		if !strings.Contains(strings.ToLower(name), "temp") {
			continue
		}
		celsius, ok := valueByIdx[idx]
		if !ok {
			continue
		}
		samples = append(samples, model.TempSample{
			SensorName: name,
			Celsius:    float64(celsius),
			StatusOK:   true,
		})
	}
	return samples, nil
}

// ── PDU index helpers ─────────────────────────────────────────────────────────

// indexPDUs builds a map of trailing OID index → PDU for a walked subtree.
func indexPDUs(pdus []gosnmp.SnmpPDU, subtreeOID string) map[string]gosnmp.SnmpPDU {
	m := make(map[string]gosnmp.SnmpPDU, len(pdus))
	for _, pdu := range pdus {
		idx := formatIndex(pdu.Name, subtreeOID)
		if idx != "" {
			m[idx] = pdu
		}
	}
	return m
}

// indexIntPDUs builds a map of trailing OID index → integer value.
func indexIntPDUs(pdus []gosnmp.SnmpPDU, subtreeOID string) map[string]int {
	m := make(map[string]int, len(pdus))
	for _, pdu := range pdus {
		idx := formatIndex(pdu.Name, subtreeOID)
		if idx != "" {
			m[idx] = client.PDUInt(pdu)
		}
	}
	return m
}
