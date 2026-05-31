// Package vendor defines the VendorProfile data structure and helpers.
//
// Adding support for a new vendor requires only one new file in this package:
//
//  1. Declare a VendorProfile struct literal.
//  2. Call Register(&profile) in an init() function.
//
// No other files need to change. The auto-detection logic in registry.go
// handles everything else.
package vendor

// OIDSet describes a set of SNMP OIDs used to collect a specific metric class.
// Walk OIDs are passed to BulkWalkAll; Scalar OIDs are fetched with a single GET.
type OIDSet struct {
	Walk   []string // table/subtree OIDs — use BulkWalkAll
	Scalar []string // scalar OIDs — use a single GET

	// IdleComplement: scalar returns CPU idle %; actual load = 100 - value.
	// Used for UCD-SNMP-MIB ssCpuIdle on Linux/NET-SNMP devices.
	IdleComplement bool

	// KBAvailable: scalars are [totalKB, availKB]; used = total - avail.
	// Used for UCD-SNMP-MIB memTotalReal/memAvailReal on Linux/NET-SNMP devices.
	KBAvailable bool
}

// Profile describes one vendor's SNMP characteristics.
// Only fill in the fields that differ from standard MIB behaviour.
// Nil OIDSet fields tell the poller to use the standard MIBs instead.
type Profile struct {
	// Human-readable vendor name for logging.
	Name string

	// PostgreSQL vendor_type enum value (e.g. "cisco_iosxr").
	// Must match a value in the vendor_type enum from 001_init.sql.
	// New vendors not yet in the DB enum should use "unknown" here until
	// the enum is extended with ALTER TYPE vendor_type ADD VALUE '...'.
	DBVendorType string

	// PostgreSQL device_type enum value inferred from the vendor profile.
	// One of: router, switch, firewall, load_balancer, wireless_controller, unknown.
	// Leave empty to keep the current value in the DB (no overwrite).
	DBDeviceType string

	// SysObjectID OID prefix(es) for this vendor.
	// Detection: if the device's sysObjectID starts with ANY of these prefixes,
	// this profile is a candidate match.
	// Use the most specific prefix possible to avoid false positives.
	SysObjectIDPrefixes []string

	// SysDescrPatterns are Go regexp strings applied to the sysDescr OID
	// value to disambiguate between vendors that share a sysObjectID prefix
	// (e.g. Cisco IOS vs IOS-XR vs NX-OS all share 1.3.6.1.4.1.9.).
	// If any pattern matches, this profile wins the tiebreak.
	SysDescrPatterns []string

	// Priority breaks ties when multiple profiles match the same device.
	// Higher number = higher priority. Defaults to 0.
	Priority int

	// Optional vendor-specific OID overrides. Nil = use standard MIBs.

	// HpicfVlan: when true, use HP-ICF-VLAN-MIB instead of Q-BRIDGE-MIB for
	// VLAN collection.  Set on HP ProCurve / Aruba ProVision switches, which do
	// not populate the standard dot1qVlanStaticTable.
	HpicfVlan bool

	// UptimeOID overrides sysUpTime for the health uptime metric.
	// Use when the vendor's SNMP agent uptime diverges from actual system uptime
	// (e.g. Aruba CX resets sysUpTime on agent restart; hrSystemUptime is stable).
	// The OID must return a TimeTicks value (hundredths of a second).
	UptimeOID string

	// CPUOIDS overrides hrProcessorLoad for CPU collection.
	CPUOIDs *OIDSet

	// MemoryOIDs overrides hrStorageTable for memory collection.
	MemoryOIDs *OIDSet

	// TempOIDs overrides ENTITY-SENSOR-MIB for temperature collection.
	TempOIDs *OIDSet

	// SkipOSPF: when true, skip ospfNbrTable polling.
	// Set when the vendor does not implement OSPF-MIB (RFC 1850).
	SkipOSPF bool

	// SkipBGP: when true, skip bgpPeerTable polling.
	// Set when the vendor does not implement BGP4-MIB (RFC 1657).
	SkipBGP bool

	// SkipISIS: when true, skip ISIS-MIB (RFC 4444) polling.
	// Set when the vendor does not implement ISIS-MIB or IS-IS is not deployed.
	SkipISIS bool

	// SkipDOM: when true, skip ENTITY-SENSOR-MIB optical power collection.
	// Set on devices that have no optical transceivers or do not expose DOM
	// data via standard SNMP (e.g. ProCurve switches, access points, firewalls).
	SkipDOM bool
}
