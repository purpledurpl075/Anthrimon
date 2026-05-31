package vendor

import "github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/oid"

// ArubaOS campus APs (635, 515, 505, etc.) running ArubaOS (not ArubaOS-CX).
// OID prefix 1.3.6.1.4.1.14823 is the original Aruba Networks enterprise OID
// (pre-HPE acquisition). The .1.2.x sub-tree covers AP product models.
//
// hrProcessorLoad and hrStorageTable return empty on ArubaOS — use
// WLSX-SYSTEMEXT-MIB scalars instead.
//
// NOTE: DBVendorType is "unknown" until migration 016 is applied.
// Run: sudo -u postgres psql -d anthrimon < storage/migrations/postgres/016_aruba_ap_vendor.sql
// Then change DBVendorType to "aruba_ap" below.
func init() {
	Register(&Profile{
		Name:         "Aruba AP (ArubaOS)",
		DBVendorType: "aruba_ap",
		DBDeviceType: "access_point",
		SysObjectIDPrefixes: []string{
			"1.3.6.1.4.1.14823.1.", // Aruba AP product sub-tree
		},
		SysDescrPatterns: []string{
			`ArubaOS`,   // "ArubaOS (MODEL: 635)..."
			`Aruba AP`,
		},
		// Higher than the generic 14823 enterprise OID if any other profile uses it.
		Priority: 8,

		// wlsxSysstatCpuUsedPercent — direct CPU % scalar.
		CPUOIDs: &OIDSet{
			Scalar: []string{oid.ArubaAPCpuUsedPct},
		},

		// wlsxSysstatMemUsedPercent + wlsxSysstatMemTotal (KB).
		// FortiGate convention: [usedPct, totalKB].
		MemoryOIDs: &OIDSet{
			Scalar: []string{oid.ArubaAPMemUsedPct, oid.ArubaAPMemTotalKB},
		},

		SkipDOM: true, // access points have no optical transceivers
	})
}
