package vendor

import "github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/oid"

// Aruba-CX (ArubaOS-CX) switches.
// ArubaOS-CX is HPE's modern network OS — a clean-slate platform distinct
// from ProCurve/legacy ArubaOS (handled in procurve.go).
//
// SNMP behaviour notes:
//   - ipCidrRouteTable (RFC 2096) is not populated on ArubaOS-CX.
//     Routes are only in inetCidrRouteTable (RFC 4292). The route poller
//     falls back to RFC 4292 automatically when RFC 2096 is empty.
//   - CPU: hrProcessorLoad works on ArubaOS-CX (HOST-RESOURCES-MIB supported).
//   - Memory: hrStorageTable works.
//   - Temperature: ENTITY-SENSOR-MIB (entPhySensorType/Value) works.
//   - VLANs: Q-BRIDGE-MIB (dot1qVlanStaticTable) is populated.
//   - Uptime: use hrSystemUptime — the SNMP agent process restarts on config
//     commits, which would reset sysUpTime and trigger false reboot alerts.
func init() {
	Register(&Profile{
		Name:         "Aruba-CX",
		DBVendorType: "aruba_cx",
		DBDeviceType: "switch",
		SysObjectIDPrefixes: []string{
			"1.3.6.1.4.1.47196.", // Aruba Networks (current HPE assignment)
			"1.3.6.1.4.1.11.",    // HP/Agilent legacy prefix on some CX hardware
		},
		// Require "ArubaOS-CX" in sysDescr to avoid matching ProCurve devices
		// that also sit under the HP enterprise prefix.
		SysDescrPatterns: []string{
			`ArubaOS-CX`,
		},
		Priority: 10,

		UptimeOID: oid.HrSystemUptime,

		// Standard HOST-RESOURCES-MIB CPU (hrProcessorLoad) works on CX.
		// Leave CPUOIDs nil so pollCPUStandard is used.
		CPUOIDs: nil,

		// Standard hrStorageTable works on CX.
		// Leave MemoryOIDs nil so pollMemoryStandard is used.
		MemoryOIDs: nil,

		// ENTITY-SENSOR-MIB temperature works on CX.
		// Leave TempOIDs nil so pollTempEntitySensor is used.
		TempOIDs: nil,

		// CX uses Q-BRIDGE-MIB, not HP-ICF-VLAN-MIB.
		HpicfVlan: false,
	})
}
