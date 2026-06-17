// Package oid centralises every OID used across all pollers.
// Adding support for a new MIB means adding constants here — no OID strings
// scattered elsewhere in the codebase.
package oid

// ── System MIB (RFC 1213 / SNMPv2-MIB) ──────────────────────────────────────

const (
	SysDescr    = "1.3.6.1.2.1.1.1.0"
	SysObjectID = "1.3.6.1.2.1.1.2.0"
	SysUpTime   = "1.3.6.1.2.1.1.3.0"
	SysContact  = "1.3.6.1.2.1.1.4.0"
	SysName     = "1.3.6.1.2.1.1.5.0"
	SysLocation = "1.3.6.1.2.1.1.6.0"
)

// ── SNMP Framework MIB (RFC 3411) ─────────────────────────────────────────────

const (
	// SnmpEngineID is the authoritative engine ID of the device.
	// Readable via v2c and v3; required for snmptrapd createUser -e localization.
	SnmpEngineID = "1.3.6.1.6.3.10.2.1.1.0"
)

// ── IF-MIB: ifTable (RFC 2863) ───────────────────────────────────────────────
// Subtree root for BulkWalk.

const IfTable = "1.3.6.1.2.1.2.2.1"

// Individual ifTable column subtrees (walk to get all rows).
const (
	IfDescr        = "1.3.6.1.2.1.2.2.1.2"
	IfType         = "1.3.6.1.2.1.2.2.1.3"
	IfMtu          = "1.3.6.1.2.1.2.2.1.4"
	IfSpeed        = "1.3.6.1.2.1.2.2.1.5"
	IfPhysAddr     = "1.3.6.1.2.1.2.2.1.6"
	IfAdminStatus  = "1.3.6.1.2.1.2.2.1.7"
	IfOperStatus   = "1.3.6.1.2.1.2.2.1.8"
	IfLastChange   = "1.3.6.1.2.1.2.2.1.9"
	IfInOctets     = "1.3.6.1.2.1.2.2.1.10"
	IfInUcastPkts  = "1.3.6.1.2.1.2.2.1.11"
	IfInDiscards   = "1.3.6.1.2.1.2.2.1.13"
	IfInErrors     = "1.3.6.1.2.1.2.2.1.14"
	IfOutOctets    = "1.3.6.1.2.1.2.2.1.16"
	IfOutUcastPkts = "1.3.6.1.2.1.2.2.1.17"
	IfOutDiscards  = "1.3.6.1.2.1.2.2.1.19"
	IfOutErrors    = "1.3.6.1.2.1.2.2.1.20"
)

// ── IF-MIB: ifXTable (RFC 2863) ─────────────────────────────────────────────
// 64-bit HC counters — always prefer these over 32-bit ifTable counters.

const IfXTable = "1.3.6.1.2.1.31.1.1.1"

const (
	IfName           = "1.3.6.1.2.1.31.1.1.1.1"
	IfHCInOctets     = "1.3.6.1.2.1.31.1.1.1.6"
	IfHCInUcastPkts  = "1.3.6.1.2.1.31.1.1.1.7"
	IfHCOutOctets    = "1.3.6.1.2.1.31.1.1.1.10"
	IfHCOutUcastPkts = "1.3.6.1.2.1.31.1.1.1.11"
	IfHighSpeed      = "1.3.6.1.2.1.31.1.1.1.15" // Mbps; multiply × 1e6 for bps
	IfAlias          = "1.3.6.1.2.1.31.1.1.1.18"
)

// ── HOST-RESOURCES-MIB (RFC 2790) ───────────────────────────────────────────

const (
	// System uptime from the OS (timeticks, same unit as sysUpTime).
	// Unlike sysUpTime, this tracks how long the host has been running —
	// SNMP agent restarts do not reset it.
	HrSystemUptime = "1.3.6.1.2.1.25.1.1.0"

	// CPU: walk returns one row per processor, value 0–100 (%)
	HrProcessorTable = "1.3.6.1.2.1.25.3.3.1"
	HrProcessorLoad  = "1.3.6.1.2.1.25.3.3.1.2"

	// Storage table
	HrStorageTable           = "1.3.6.1.2.1.25.2.3.1"
	HrStorageType            = "1.3.6.1.2.1.25.2.3.1.2"
	HrStorageDescr           = "1.3.6.1.2.1.25.2.3.1.3"
	HrStorageAllocationUnits = "1.3.6.1.2.1.25.2.3.1.4"
	HrStorageSize            = "1.3.6.1.2.1.25.2.3.1.5"
	HrStorageUsed            = "1.3.6.1.2.1.25.2.3.1.6"

	// Storage type OID values (hrStorageType column returns one of these)
	HrStorageTypeRam           = "1.3.6.1.2.1.25.2.1.2"
	HrStorageTypeVirtualMemory = "1.3.6.1.2.1.25.2.1.3"
	HrStorageTypeFlash         = "1.3.6.1.2.1.25.2.1.7"
)

// ── ENTITY-MIB (RFC 2737) ────────────────────────────────────────────────────

const (
	EntPhysicalDescr = "1.3.6.1.2.1.47.1.1.1.1.2" // populated on Arista/most vendors
	EntPhysicalName  = "1.3.6.1.2.1.47.1.1.1.1.7" // often empty on Arista EOS
)

// ── ENTITY-SENSOR-MIB (RFC 3433) ─────────────────────────────────────────────
// Walk entPhySensorType to find temperature sensors (type == 8 = celsius).
// Then read corresponding entPhySensorValue rows by matching index.

const (
	EntPhySensorType      = "1.3.6.1.2.1.99.1.1.1.1"
	EntPhySensorScale     = "1.3.6.1.2.1.99.1.1.1.2" // SensorDataScale enum (units=9)
	EntPhySensorPrecision = "1.3.6.1.2.1.99.1.1.1.3" // decimal places 0–9
	EntPhySensorValue     = "1.3.6.1.2.1.99.1.1.1.4"

	EntSensorTypeCelsius = 8  // entPhySensorType value indicating temperature
	EntSensorTypeWatts   = 6  // watts — used for optical power (TX/RX) on Arista and others
	EntSensorTypeDBm     = 14 // dBm — optical power reported directly on Cisco IOS-XE/XR/NX-OS
	EntSensorScaleUnits  = 9  // entPhySensorScale: units(9) = 10^0
	// RFC 3433 SensorDataScale: actual exponent = (enum - 9) * 3
	// e.g. milli(8) → (8-9)*3 = -3, units(9) → 0, kilo(10) → +3
)

// ── Juniper DOM MIB (JUNIPER-DOM-MIB, 1.3.6.1.4.1.2636.3.60) ─────────────────
// Values are integers in units of 0.001 mW (1 µW).  Convert: mW = value/1000.
// Indexed by ifIndex; resolve interface name via IF-MIB ifDescr.

const (
	JnxDomCurrentTxPower = "1.3.6.1.4.1.2636.3.60.1.1.1.1.4" // TX laser output power
	JnxDomCurrentRxPower = "1.3.6.1.4.1.2636.3.60.1.1.1.1.8" // RX laser power
)

// ── Cisco: CISCO-PROCESS-MIB ─────────────────────────────────────────────────

const (
	// 5-minute CPU average per processor (walk returns one row per CPU).
	// Preferred over hrProcessorLoad for IOS/IOS-XE/IOS-XR — more accurate.
	CpmCPUTotal5minRev = "1.3.6.1.4.1.9.9.109.1.1.1.1.8"
)

// ── Cisco: CISCO-ENVMON-MIB ──────────────────────────────────────────────────

const (
	CiscoEnvMonTempTable = "1.3.6.1.4.1.9.9.13.1.3.1"
	CiscoEnvMonTempDescr = "1.3.6.1.4.1.9.9.13.1.3.1.2"
	CiscoEnvMonTempValue = "1.3.6.1.4.1.9.9.13.1.3.1.3"
	// State: 1=normal, 2=warning, 3=critical, 4=shutdown, 5=notPresent
	CiscoEnvMonTempState = "1.3.6.1.4.1.9.9.13.1.3.1.6"
)

// ── Juniper: JUNIPER-MIB (jnxOperating table) ────────────────────────────────
// jnxOperating covers chassis components: FPCs, SCBs, REs, fans, etc.

const (
	JnxOperatingTable  = "1.3.6.1.4.1.2636.3.1.13.1"
	JnxOperatingDescr  = "1.3.6.1.4.1.2636.3.1.13.1.5"
	JnxOperatingTemp   = "1.3.6.1.4.1.2636.3.1.13.1.7"
	JnxOperatingCPU    = "1.3.6.1.4.1.2636.3.1.13.1.8"
	JnxOperatingMemory = "1.3.6.1.4.1.2636.3.1.13.1.11"
)

// ── HP ProCurve / Aruba (legacy): HP-ICF-CHASSIS-MIB ─────────────────────────

const (
	// hpicfChassisCpuUtil: 1-minute CPU utilisation % scalar.
	// WB.16 firmware (HP 2920) does NOT expose this OID; use HpicfSwitchCpuStatUtil instead.
	// Left here for completeness; procurve.go uses HpicfSwitchCpuStatUtil.
	HpicfChassisCpuUtil = "1.3.6.1.4.1.11.2.14.11.5.1.7.1.4.0"

	// hpicfSwitchCpuStatUtilization: instantaneous CPU % on HP 2920/2930/5400R (WA/WB firmware).
	// This scalar is at hpicfCpuStat.6.1.0 and returns an INTEGER 0-100.
	HpicfSwitchCpuStatUtil = "1.3.6.1.4.1.11.2.14.11.5.1.9.6.1.0"

	// hpicfMemEntryData: walk base for hpicfMemEntry on HP 2920/2930/5400R (WA/WB firmware).
	// Must walk from the deeper .1.1 path so splitTableOID (col.row) resolves correctly.
	// Column 6 = bytes allocated (used), column 7 = bytes free.
	// Total = col6 + col7.  Columns 3-4 exist but are always 0 on this firmware.
	HpicfMemEntryData = "1.3.6.1.4.1.11.2.14.11.5.1.1.2.1.1.1"

	// HpicfMemEntry is kept for reference; use HpicfMemEntryData in profiles.
	HpicfMemEntry = "1.3.6.1.4.1.11.2.14.11.5.1.1.2.1"
)

// ── FortiGate: FORTINET-FORTIGATE-MIB ────────────────────────────────────────

const (
	// Scalar system stats
	FgSysCpuUsage    = "1.3.6.1.4.1.12356.101.4.1.3.0"
	FgSysMemUsage    = "1.3.6.1.4.1.12356.101.4.1.4.0" // % used
	FgSysMemCapacity = "1.3.6.1.4.1.12356.101.4.1.5.0" // total KB

	// Hardware sensor table (temperature, fan, etc.)
	FgHwSensorTable          = "1.3.6.1.4.1.12356.101.4.4.2.1"
	FgHwSensorEntName        = "1.3.6.1.4.1.12356.101.4.4.2.1.2"
	FgHwSensorEntValue       = "1.3.6.1.4.1.12356.101.4.4.2.1.3"
	FgHwSensorEntAlarmStatus = "1.3.6.1.4.1.12356.101.4.4.2.1.4"
)

// ── IP-FORWARD-MIB: ipCidrRouteTable (RFC 2096) ──────────────────────────────
// One row per route entry.  Indexed by (dest, mask, tos, nextHop) — all IPs.
// We walk the whole table and filter by protocol column.
const IPCidrRouteTable = "1.3.6.1.2.1.4.24.4.1"

// ── IP-FORWARD-MIB: inetCidrRouteTable (RFC 4292) ────────────────────────────
// Successor to ipCidrRouteTable. Used by modern devices (Aruba CX, Juniper,
// newer IOS-XE). Indexed by (destType, dest, pfxLen, policy, nhType, nextHop).
// Protocol values use IANAipRouteProtocol TC — same numbering as RFC 2096:
// local=2, static=3, ospf=13, bgp=14.
const InetCidrRouteTable = "1.3.6.1.2.1.4.24.7.1"

// ── IP-MIB: ipAddrTable (RFC 1213) ───────────────────────────────────────────
// One row per IP address configured on the device.
// Indexed by the IP address itself (4 decimal octets).
const (
	IPAddrTable    = "1.3.6.1.2.1.4.20.1"   // ipAddrEntry subtree
	IPAdEntIfIndex = "1.3.6.1.2.1.4.20.1.2" // col 2: ifIndex
	IPAdEntNetMask = "1.3.6.1.2.1.4.20.1.3" // col 3: subnet mask
)

// ── Aruba: WLSX-SYSTEMEXT-MIB ────────────────────────────────────────────────
// Present on ArubaOS campus APs and controllers (not ArubaOS-CX switches).

const (
	ArubaAPCpuUsedPct = "1.3.6.1.4.1.14823.2.2.1.1.3.1.0" // wlsxSysstatCpuUsedPercent (0–100)
	ArubaAPMemTotalKB = "1.3.6.1.4.1.14823.2.2.1.1.3.2.0" // wlsxSysstatMemTotal (KB)
	ArubaAPMemUsedPct = "1.3.6.1.4.1.14823.2.2.1.1.3.3.0" // wlsxSysstatMemUsedPercent (0–100)
)

// ── UCD-SNMP-MIB (NET-SNMP Linux) ────────────────────────────────────────────
// Standard on NET-SNMP agents (Linux/embedded). Use when HOST-RESOURCES-MIB
// hrProcessorLoad returns empty (common on embedded platforms like UniFi).

const (
	UCDSsCpuIdle    = "1.3.6.1.4.1.2021.11.11.0" // ssCpuIdle — % idle time; CPU% = 100 - idle
	UCDMemTotalReal = "1.3.6.1.4.1.2021.4.5.0"   // memTotalReal — total physical RAM (KB)
	UCDMemAvailReal = "1.3.6.1.4.1.2021.4.6.0"   // memAvailReal — available physical RAM (KB)
)

// ── BGP4-MIB (RFC 1657) ──────────────────────────────────────────────────────
// bgpPeerTable: one row per BGP peer. Indexed by bgpPeerRemoteAddr (dotted IPv4).
const BGPPeerTable = "1.3.6.1.2.1.15.3.1"

// bgpPeerTable column subtrees (col.a.b.c.d).
const (
	BGPLocalAs                 = "1.3.6.1.2.1.15.2.0"    // scalar — local AS number
	BGPPeerState               = "1.3.6.1.2.1.15.3.1.2"  // 1=idle 2=connect 3=active 4=opensent 5=openconfirm 6=established
	BGPPeerAdminStatus         = "1.3.6.1.2.1.15.3.1.3"  // 1=stop 2=start
	BGPPeerRemoteAs            = "1.3.6.1.2.1.15.3.1.9"  // remote AS number
	BGPPeerInUpdates           = "1.3.6.1.2.1.15.3.1.7"  // total UPDATE messages received
	BGPPeerOutUpdates          = "1.3.6.1.2.1.15.3.1.8"  // total UPDATE messages sent
	BGPPeerEstablishedTime     = "1.3.6.1.2.1.15.3.1.16" // sysUpTime when session became established
	BGPPeerIdentifier          = "1.3.6.1.2.1.15.3.1.1"  // peer BGP router-ID
	BGPPeerHoldTime            = "1.3.6.1.2.1.15.3.1.19" // negotiated hold time
	BGPPeerKeepAlive           = "1.3.6.1.2.1.15.3.1.20" // negotiated keepalive
	BGPPeerInPrefixes          = "1.3.6.1.2.1.15.3.1.11" // prefixes received (RFC 1657 col 11)
	BGPPeerFsmEstablishedTrans = "1.3.6.1.2.1.15.3.1.15" // total times entered Established (flap counter)
)

// ── OSPF-MIB (RFC 1850) ───────────────────────────────────────────────────────
// ospfNbrTable: one row per OSPF neighbour relationship.
// Indexed by (ospfNbrIpAddr, ospfNbrAddressLessIndex).
const OSPFNbrTable = "1.3.6.1.2.1.14.10.1"

// ospfIfTable: OSPF interface config, used to resolve area IDs.
// Indexed by (ospfIfIpAddress, ospfIfAddressLessIf).
const OSPFIfTable = "1.3.6.1.2.1.14.7.1"

// ── IP-MIB: ARP table (RFC 1213 / RFC 4293) ──────────────────────────────────
// ipNetToMediaTable — maps IP addresses to MAC addresses per interface.
// Indexed by (ifIndex, ipAddress-as-4-octets).
const ARPTable = "1.3.6.1.2.1.4.22.1"

// ── BRIDGE-MIB (RFC 4188) ────────────────────────────────────────────────────
// dot1dTpFdbTable — MAC forwarding database: MAC → bridge port.
// Indexed by MAC address as 6 decimal octets.
const MACFdbTable = "1.3.6.1.2.1.17.4.3.1"

// dot1dBasePortTable — maps bridge port number → ifIndex.
// Indexed by bridge port number.
const MACPortTable = "1.3.6.1.2.1.17.1.4.1"

// ── Q-BRIDGE-MIB (IEEE 802.1Q) ───────────────────────────────────────────────

const (
	// dot1qVlanStaticName: VLAN name string, indexed by vlan_id.
	Dot1qVlanStaticName = "1.3.6.1.2.1.17.7.1.4.1.1.1"

	// dot1qVlanCurrentEgressPorts: tagged+untagged egress bitmap per VLAN (col 3).
	// Indexed by (TimeMark, VlanIndex); use TimeMark=0 for current data.
	Dot1qVlanCurrentEgressPorts = "1.3.6.1.2.1.17.7.1.4.2.1.3"

	// dot1qVlanCurrentUntaggedPorts: untagged egress bitmap per VLAN (col 4).
	// Indexed by (TimeMark, VlanIndex); use TimeMark=0 for current data.
	Dot1qVlanCurrentUntaggedPorts = "1.3.6.1.2.1.17.7.1.4.2.1.4"

	// dot1qPvid: access VLAN per bridge port, indexed by bridge port number.
	Dot1qPvid = "1.3.6.1.2.1.17.7.1.4.5.1.1"

	// dot1qTpFdbTable — per-VLAN MAC forwarding database: MAC → bridge port.
	// On VLAN-aware bridges, dot1dTpFdbTable (BRIDGE-MIB) typically only
	// reflects the default/native VLAN; entries for tagged VLANs live here
	// instead. Indexed by (dot1qFdbId, MAC address as 6 decimal octets).
	// Col 2 = dot1qTpFdbPort (dot1dBasePort number), col 3 = dot1qTpFdbStatus.
	Dot1qTpFdbTable = "1.3.6.1.2.1.17.7.1.2.2.1"
)

// ── HP-ICF-VLAN-MIB (HP ProCurve / Aruba ProVision) ─────────────────────────
// Used when Q-BRIDGE-MIB is not populated (ProCurve ProVision firmware).
// All OIDs under hpicfVlanMib = 1.3.6.1.4.1.11.2.14.11.5.1.7.1.15

const (
	// hpicfVlanInfoName: VLAN name string.  Index = VlanID (integer).
	HpicfVlanInfoName = "1.3.6.1.4.1.11.2.14.11.5.1.7.1.15.1.1.2"

	// hpicfVlanPortInfoVlanId: access (native/untagged) VLAN per port.
	// Index = ifIndex.  Value = VLAN ID integer.
	HpicfVlanPortInfoVlanId = "1.3.6.1.4.1.11.2.14.11.5.1.7.1.15.3.1.1"

	// hpicfVlanPortInfoTaggedVlans: bitmap of VLANs for which this port is a
	// tagged trunk member.  Index = ifIndex.  Value = OctetString bitmap where
	// bit N (1-indexed MSB-first) means the port trunks VLAN N.
	HpicfVlanPortInfoTaggedVlans = "1.3.6.1.4.1.11.2.14.11.5.1.7.1.15.3.1.3"
)

// ── ISIS-MIB (RFC 4444) ───────────────────────────────────────────────────────
// Indexed by (isisSysInstance[OctetString], isisCircIndex, isisISAdjIndex).
// isisSysInstance is length-prefixed in the OID: 0 = empty/default instance.

const (
	// isisCircTable: circuit (interface) config.
	// Index: instanceLen[.instanceChars*].circIndex
	// Col 2: isisCircIfIndex — maps circuit index to ifIndex.
	ISISCircTable   = "1.3.6.1.2.1.138.1.3.1"
	ISISCircIfIndex = "1.3.6.1.2.1.138.1.3.1.2"

	// isisISAdjTable: IS-IS adjacency table.
	// Index: instanceLen[.instanceChars*].circIndex.adjIndex
	// Col 2: isisISAdjState       — 1=down,2=initializing,3=up,4=failed
	// Col 5: isisISAdjNeighSysID  — 6-byte neighbour system ID
	// Col 7: isisISAdjUsage       — 1=undefined,2=level-1,3=level-2,4=level-1-2
	// Col 10: isisISAdjLastUpTime — TimeTicks when adjacency last entered Up
	ISISAdjTable = "1.3.6.1.2.1.138.1.6.1"

	// isisISAdjIPAddrTable: IP addresses for each adjacency.
	// Index: instanceLen[.instanceChars*].circIndex.adjIndex.ipAddrIndex
	// Col 2: isisISAdjIPAddrType    — 1=IPv4, 2=IPv6
	// Col 3: isisISAdjIPAddrAddress — InetAddress (4 or 16 bytes)
	ISISAdjIPTable = "1.3.6.1.2.1.138.1.6.2"

	// isisSysAreaAddrTable: area addresses configured on the device.
	// Index: instanceLen[.instanceChars*].areaAddrLen.areaAddrBytes*
	// Col 2: isisSysAreaAddrExistState — RowStatus
	// The area address itself is encoded in the index, not a column.
	ISISSysAreaAddrTable = "1.3.6.1.2.1.138.1.2.1"

	// isisCircLevelTable: per-circuit, per-level link parameters.
	// Index: instanceLen[.instanceChars*].circIndex.levelIndex (1=level-1, 2=level-2)
	// Col 2: isisCircLevelMetric         — narrow metric (IsisDefaultMetric)
	// Col 3: isisCircLevelWideMetric     — wide metric (IsisWideMetric)
	// Col 4: isisCircLevelISPriority     — DIS election priority
	// Col 7: isisCircLevelDesIS          — LAN-DIS ID for this circuit/level (7 bytes); all-zero = no DIS elected
	// Col 8: isisCircLevelHelloMultiplier
	// Col 9: isisCircLevelHelloTimer     — milliseconds
	ISISCircLevelTable = "1.3.6.1.2.1.138.1.4.1"

	// isisLSPSummaryTable: summary of each LSP in the device's link-state database.
	// Index: instanceLen[.instanceChars*].lspLevel.lspIDByte1..8 (8-byte LSP ID, fixed-size, no length prefix)
	// Col 3: isisLSPSeq            — sequence number
	// Col 4: isisLSPZeroLife       — TruthValue (1=true): LSP is being purged
	// Col 5: isisLSPChecksum       — 16-bit Fletcher checksum
	// Col 6: isisLSPLifetimeRemain — remaining lifetime in seconds
	// Col 7: isisLSPPDULength      — PDU length
	// Col 8: isisLSPAttributes     — flag byte: 0x04=overload (OL), 0x78=attached (ATT)
	ISISLSPTable = "1.3.6.1.2.1.138.1.9.1"
)

// ── BRIDGE-MIB STP (IEEE 802.1D) ─────────────────────────────────────────────

const (
	// dot1dStpPortTable: STP per-port state table.
	Dot1dStpPortTable = "1.3.6.1.2.1.17.2.15.1"

	// dot1dStpPortState: STP port state, indexed by bridge port number.
	// Values: 1=disabled 2=blocking 3=listening 4=learning 5=forwarding
	Dot1dStpPortState = "1.3.6.1.2.1.17.2.15.1.3"

	// dot1dStpPortRole: STP port role (RSTP extension), indexed by bridge port number.
	// Values: 0=unknown 1=root 2=designated 3=alternate 4=backup
	Dot1dStpPortRole = "1.3.6.1.2.1.17.2.15.1.10"
)

// ── LLDP-MIB (IEEE 802.1AB) ──────────────────────────────────────────────────
// Two OID namespaces exist: IEEE (1.0.8802) used by most enterprise gear,
// and IETF (1.3.6.1.2.1.111) used by some Linux/open-source agents.
// The poller tries the IEEE namespace first, then falls back to IETF.

const (
	// lldpRemTable: one row per discovered neighbour per local port.
	// Indexed by (lldpRemTimeMark, lldpRemLocalPortNum, lldpRemIndex).
	LLDPRemTableIEEE = "1.0.8802.1.1.2.1.4.1.1"
	LLDPRemTableIETF = "1.3.6.1.2.1.111.1.4.1.1"

	// lldpLocPortTable: maps lldpRemLocalPortNum → local port description (ifName).
	// Indexed by lldpLocPortNum (same integer as lldpRemLocalPortNum).
	LLDPLocPortIEEE = "1.0.8802.1.1.2.1.3.7.1"
	LLDPLocPortIETF = "1.3.6.1.2.1.111.1.3.7.1"

	// lldpRemManAddrTable: management addresses for each neighbour.
	// The IPv4 address is encoded in the OID index itself.
	// Indexed by (timeMark, portNum, remIndex, addrSubtype, addr...).
	LLDPRemManAddrIEEE = "1.0.8802.1.1.2.1.4.2.1"
	LLDPRemManAddrIETF = "1.3.6.1.2.1.111.1.4.2.1"
)

// ── CISCO-CDP-MIB ─────────────────────────────────────────────────────────────
// CDP is Cisco-proprietary; present on IOS, IOS-XE, IOS-XR, NX-OS.
// cdpCacheTable is indexed by (cdpCacheIfIndex, cdpCacheDeviceIndex).

const (
	CDPCacheTable = "1.3.6.1.4.1.9.9.23.1.2.1.1"
)

// ── IANA ifType values (most common) ─────────────────────────────────────────

var IfTypeNames = map[int]string{
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

// IfTypeName returns the IANA name for an ifType integer, or "other" if unrecognised.
func IfTypeName(t int) string {
	if name, ok := IfTypeNames[t]; ok {
		return name
	}
	return "other"
}
