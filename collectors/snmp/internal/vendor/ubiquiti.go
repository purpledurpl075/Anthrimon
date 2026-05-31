package vendor

import "github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/oid"

// Ubiquiti UniFi and UBNT product line.
// UCG-Fiber, UDM, UDM-Pro, USG, EdgeRouter, EdgeSwitch, etc.
//
// These devices run Linux with a standard NET-SNMP agent.
// sysObjectID is typically 1.3.6.1.4.1.8072.3.2.10 (NET-SNMP Linux generic)
// rather than a Ubiquiti enterprise OID — matched by sysDescr instead.
//
// hrProcessorLoad returns empty on most UniFi firmware; use UCD-SNMP-MIB
// ssCpuIdle (100 - idle = load). Memory via memTotalReal / memAvailReal.
//
// NOTE: DBVendorType is "unknown" until migration 015 is applied by a
// superuser to add 'ubiquiti' to the vendor_type enum.
// Once applied, change this to "ubiquiti".
func init() {
	Register(&Profile{
		Name:         "Ubiquiti UniFi / UBNT",
		DBVendorType: "ubiquiti",
		DBDeviceType: "router",  // UCG/UDM/USG are gateway/routers
		SysObjectIDPrefixes: []string{
			"1.3.6.1.4.1.41112", // Ubiquiti enterprise OID (older devices)
			"1.3.6.1.4.1.8072.3.2", // NET-SNMP Linux (UCG-Fiber, UDM-Pro, etc.)
		},
		SysDescrPatterns: []string{
			`Ubiquiti`,
			`UniFi`,
			`UBNT`,
			`EdgeRouter`,
			`EdgeSwitch`,
		},
		// Higher priority than a hypothetical generic Linux profile.
		Priority: 8,

		// UCD-SNMP-MIB ssCpuIdle: CPU% = 100 - idle.
		CPUOIDs: &OIDSet{
			Scalar:         []string{oid.UCDSsCpuIdle},
			IdleComplement: true,
		},

		// UCD-SNMP-MIB memTotalReal / memAvailReal (both in KB).
		// used = total - avail
		MemoryOIDs: &OIDSet{
			Scalar:      []string{oid.UCDMemTotalReal, oid.UCDMemAvailReal},
			KBAvailable: true,
		},

		SkipDOM: true, // Ubiquiti devices do not expose DOM via ENTITY-SENSOR-MIB
	})
}
