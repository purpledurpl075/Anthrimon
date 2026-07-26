package vendor

import "github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/oid"

// Juniper JunOS devices have their own enterprise OID space (2636) and expose
// CPU, memory, and temperature through the jnxOperating table rather than
// HOST-RESOURCES-MIB.
func init() {
	Register(&Profile{
		Name:         "Juniper JunOS",
		DBVendorType: "juniper",
		DBDeviceType: "router",
		SysObjectIDPrefixes: []string{
			"1.3.6.1.4.1.2636.", // Juniper Networks enterprise OID
		},
		// No sysDescr patterns needed — Juniper has its own unique OID space.
		Priority: 10,

		// jnxOperatingCPU gives per-FPC/RE CPU utilisation — more granular
		// than hrProcessorLoad which may not be populated on all JunOS versions.
		CPUOIDs: &OIDSet{
			Walk: []string{oid.JnxOperatingCPU},
		},

		// jnxOperatingMemory gives memory buffer utilisation per component.
		MemoryOIDs: &OIDSet{
			Walk: []string{oid.JnxOperatingMemory},
		},

		// jnxOperatingTemp gives temperature per chassis component.
		TempOIDs: &OIDSet{
			Walk: []string{oid.JnxOperatingTemp},
		},

		// Junos doesn't populate the standard Q-BRIDGE-MIB VLAN tables on at
		// least EX3300 15.1R6/R7 — fall back to JUNIPER-VLAN-MIB.
		JuniperVlan: true,
	})
}
