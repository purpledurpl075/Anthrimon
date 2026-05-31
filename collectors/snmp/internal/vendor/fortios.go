package vendor

import "github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/oid"

// FortiGate / FortiOS does not support gNMI and uses SNMP as its primary
// collection method. CPU and memory are exposed as scalar OIDs rather than
// tables, and the hardware sensor table is Fortinet-proprietary.
func init() {
	Register(&Profile{
		Name:         "FortiGate / FortiOS",
		DBVendorType: "fortios",
		DBDeviceType: "firewall",
		SysObjectIDPrefixes: []string{
			"1.3.6.1.4.1.12356.", // Fortinet enterprise OID
		},
		Priority: 10,

		// FortiOS exposes a single scalar CPU % rather than a per-CPU table.
		// The health poller reads this as a single-entry "table" at index 0.
		CPUOIDs: &OIDSet{
			Scalar: []string{oid.FgSysCpuUsage},
		},

		// FortiOS memory: scalar % used + scalar total KB.
		MemoryOIDs: &OIDSet{
			Scalar: []string{oid.FgSysMemUsage, oid.FgSysMemCapacity},
		},

		// Fortinet hardware sensor table — contains temperature, fan RPM, etc.
		// The health poller filters to temperature-class sensors.
		TempOIDs: &OIDSet{
			Walk: []string{oid.FgHwSensorTable},
		},

		SkipDOM: true, // FortiGate firewalls do not expose DOM via ENTITY-SENSOR-MIB
	})
}
