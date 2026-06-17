// Package model defines the unified data types produced by all pollers.
// Every vendor-specific quirk is normalised here before it reaches the writer.
package model

import (
	"time"

	"github.com/google/uuid"
)

// DeviceInfo holds the system identity gathered from a sysinfo poll.
// Used to update the devices table and drive vendor auto-detection.
type DeviceInfo struct {
	DeviceID    uuid.UUID
	SysDescr    string
	SysObjectID string
	SysName     string
	SysLocation string
	SysContact  string
	// Hundredths of a second — use with PollTime to derive boot time.
	SysUpTimeTicks uint32
	VendorName     string // matched profile name, "" if unknown
	DBVendorType   string // postgres vendor_type enum value
	DBDeviceType   string // postgres device_type enum value, "" = don't update
	OSVersion      string // parsed from sysDescr, "" if unknown
	Platform       string // parsed from sysDescr, "" if unknown
	SysLocationStr string // sysLocation value
	SysContactStr  string // sysContact value
	// SnmpEngineID is the hex-encoded engine ID from snmpEngineID.0 (RFC 3411).
	// Empty string means the OID was not returned (device doesn't support it).
	SnmpEngineID string
	PollTime     time.Time
}

// InterfaceResult is a complete snapshot of one interface at a point in time.
// HC (64-bit) counters are always populated when available; the 32-bit fallbacks
// are used only for devices that don't support ifXTable.
type InterfaceResult struct {
	DeviceID    uuid.UUID
	IfIndex     int
	IfDescr     string // ifDescr (raw port name from device)
	IfName      string // ifName (canonical name, from ifXTable)
	IfAlias     string // ifAlias (operator description)
	IfType      string // IANA type name, e.g. "ethernetCsmacd"
	SpeedBPS    uint64 // ifHighSpeed*1e6 when available, else ifSpeed
	MTU         int
	MACAddress  string // "aa:bb:cc:dd:ee:ff" or ""
	AdminStatus string // "up" | "down" | "testing"
	OperStatus  string // "up" | "down" | "testing" | "unknown" | "dormant" | …

	// Prefer HC (64-bit) counters when non-zero; the poller always fills these.
	InOctets     uint64
	InUcastPkts  uint64
	InDiscards   uint64
	InErrors     uint64
	OutOctets    uint64
	OutUcastPkts uint64
	OutDiscards  uint64
	OutErrors    uint64

	// ifLastChange as an absolute UTC timestamp (best-effort, derived from
	// sysUpTime + ifLastChange timeticks). May be zero if unavailable.
	LastChange  time.Time
	PollTime    time.Time
	IPAddresses []InterfaceIP // populated from ipAddrTable
}

// InterfaceIP is one IP address entry from ipAddrTable.
type InterfaceIP struct {
	Address   string // dotted-decimal IPv4
	PrefixLen int    // derived from subnet mask
	Version   int    // 4 or 6
}

// CPUSample holds a single CPU utilisation reading.
// Multi-CPU devices emit one sample per processor.
type CPUSample struct {
	CPUIndex int
	LoadPct  float64 // 0.0 – 100.0
}

// MemorySample holds a single memory segment reading.
type MemorySample struct {
	Descr      string // "Physical memory", "RAM", etc.
	Type       string // "ram" | "virtual" | "flash" | "other"
	TotalBytes uint64
	UsedBytes  uint64
}

// TempSample holds a single temperature sensor reading.
type TempSample struct {
	SensorName string // human-readable sensor label
	Celsius    float64
	StatusOK   bool // false = warning or critical threshold exceeded
}

// OpticalSample holds a DOM optical power reading for one interface.
// Direction is "tx" or "rx". Value is in dBm.
type OpticalSample struct {
	IfaceName  string // "Ethernet2"
	SensorName string // full ENTITY-SENSOR-MIB description
	Direction  string // "tx" | "rx" | "unknown"
	PowerDBm   float64
}

// HealthResult is the complete health snapshot for one device from one poll.
type HealthResult struct {
	DeviceID       uuid.UUID
	CPUSamples     []CPUSample
	MemSamples     []MemorySample
	TempSamples    []TempSample
	OpticalSamples []OpticalSample
	UptimeSecs     uint64
	PollTime       time.Time
}

// RouteEntry is one row from ipCidrRouteTable for a device.
type RouteEntry struct {
	DeviceID      uuid.UUID
	Destination   string // "10.0.2.0/24"
	NextHop       string // "" for connected routes
	Protocol      string // "connected" | "static" | "ospf" | "other"
	Metric        int
	InterfaceName string // resolved from ifIndex, "" if unknown
}

// OSPFNeighbour is one row from ospfNbrTable for a device.
type OSPFNeighbour struct {
	DeviceID      uuid.UUID
	NeighbourIP   string // ospfNbrIpAddr (dotted decimal)
	RouterID      string // ospfNbrRtrId
	State         string // "full" | "loading" | "exchange" | "init" | "down" etc.
	Priority      int    // ospfNbrPriority
	Events        int64  // ospfNbrEvents (state-change counter)
	Area          string // from ospfIfTable, "" if unavailable
	InterfaceName string // resolved from ospfIfTable → ifIndex → ifName
}

// BGPSession is one row from bgpPeerTable (RFC 1657) for a device.
type BGPSession struct {
	DeviceID         uuid.UUID
	PollTime         time.Time // wall-clock time this row was collected
	PeerIP           string    // bgpPeerRemoteAddr (index, dotted-decimal)
	PeerRouterID     string    // bgpPeerIdentifier
	LocalASN         int64
	RemoteASN        int64
	State            string // "established" | "active" | "idle" | "connect" | "opensent" | "openconfirm" | "unknown"
	AdminStatus      string // "start" | "stop"
	UptimeSeconds    int64  // seconds since session established (0 if not established)
	InUpdates        int64
	OutUpdates       int64
	FlapCount        int64 // bgpPeerFsmEstablishedTransitions — total times entered Established
	PrefixesReceived int
}

// ARPEntry is one row from the device's ARP table (ipNetToMediaTable).
type ARPEntry struct {
	DeviceID      uuid.UUID
	IPAddress     string // dotted-decimal IPv4
	MACAddress    string // "aa:bb:cc:dd:ee:ff"
	InterfaceName string // resolved from ifIndex, "" if unknown
	EntryType     string // "dynamic" | "static" | "other"
}

// MACEntry is one row from the device's MAC forwarding table (dot1dTpFdbTable).
type MACEntry struct {
	DeviceID   uuid.UUID
	MACAddress string // "aa:bb:cc:dd:ee:ff"
	PortName   string // resolved from bridge port → ifIndex → ifName
	EntryType  string // "learned" | "self" | "static" | "other"
}

// LLDPNeighbor is a single entry from the lldpRemTable for one device.
type LLDPNeighbor struct {
	DeviceID  uuid.UUID
	LocalPort string // lldpLocPortDesc (ifName of the local interface)
	// Remote
	ChassisIDSubtype string // "macAddress" | "networkAddress" | "local" | …
	ChassisID        string // formatted chassis ID (MAC or string)
	PortIDSubtype    string // "interfaceName" | "macAddress" | …
	PortID           string
	PortDesc         string
	SystemName       string
	MgmtIP           string // first IPv4 management address, "" if unavailable
	Capabilities     []string
}

// CDPNeighbor is a single entry from cdpCacheTable for one device.
type CDPNeighbor struct {
	DeviceID     uuid.UUID
	LocalPort    string // ifName of the local interface
	RemoteDevice string // cdpCacheDeviceId (usually the hostname)
	RemotePort   string // cdpCacheDevicePort
	MgmtIP       string // first IPv4 from cdpCacheAddresses
	Platform     string // cdpCachePlatform
	Capabilities []string
	NativeVLAN   int
	Duplex       string // "full" | "half" | ""
}

// VLANResult is one row from the device's VLAN table (dot1qVlanStaticName).
type VLANResult struct {
	DeviceID uuid.UUID
	VlanID   int
	Name     string
}

// InterfaceVLANResult describes VLAN membership for one interface.
// IfIndex is resolved to interface_id by the writer.
type InterfaceVLANResult struct {
	DeviceID uuid.UUID
	IfIndex  int // resolved to interface_id by writer
	VlanID   int
	Tagged   bool // true = tagged (trunk), false = untagged (access/native)
}

// ISISArea is one configured area address from isisSysAreaAddrTable for a device.
type ISISArea struct {
	DeviceID uuid.UUID
	Instance string // IS-IS instance name, "" = default
	AreaAddr string // ISO area address, e.g. "49.0001"
}

// ISISCircuitLevel is one row from isisCircLevelTable: per-circuit, per-level
// IS-IS link parameters (metric, hello/hold timers, DIS election).
type ISISCircuitLevel struct {
	DeviceID      uuid.UUID
	Instance      string // IS-IS instance name, "" = default
	InterfaceName string // local interface name, resolved from isisCircIfIndex
	Level         string // "level-1" | "level-2"
	Metric        int    // wide metric if set, else narrow metric
	HelloInterval int    // seconds
	HoldTimer     int    // seconds (hello_interval * hello_multiplier)
	Priority      int    // DIS election priority
	DISID         string // formatted LAN-DIS system ID, "" if no DIS elected
}

// ISISLSP is one row from isisLSPSummaryTable: a single LSP in a device's
// link-state database.
type ISISLSP struct {
	DeviceID          uuid.UUID
	Instance          string // IS-IS instance name, "" = default
	Level             string // "level-1" | "level-2"
	LSPID             string // formatted 8-byte LSP ID, e.g. "0100.1001.0001.00-00"
	SequenceNumber    int64
	Checksum          int
	RemainingLifetime int // seconds
	PDULength         int
	OverloadBit       bool
	AttachedBit       bool
}

// ISISAdjacency is one row from isisISAdjTable for a device.
type ISISAdjacency struct {
	DeviceID      uuid.UUID
	Instance      string // IS-IS instance name, "" = default
	SysID         string // neighbour system-id, dotted notation "0100.1001.0001"
	InterfaceName string // local interface name, resolved from isisCircIfIndex
	CircuitType   string // "level-1" | "level-2" | "level-1-2"
	AdjState      string // "down" | "initializing" | "up" | "failed" | "unknown"
	IPv4Address   string // neighbour IPv4, "" if unavailable
	IPv6Address   string // neighbour IPv6, "" if unavailable
	UptimeSeconds int64  // seconds since adjacency last entered Up, 0 if down
}

// ProbeResult holds ICMP RTT and packet-loss statistics for one device.
// RttMin == -1 signals all packets were lost (or ICMP is filtered).
// This data feeds latency/loss alerting only — it does NOT imply device_down.
type ProbeResult struct {
	DeviceID uuid.UUID
	PollTime time.Time
	RttMin   float64 // ms; -1 when all probes lost
	RttAvg   float64 // ms
	RttMax   float64 // ms
	LossPct  float64 // 0.0 – 100.0
}

// STPPortResult is the STP state for one bridge port.
// IfIndex is resolved to interface_id by the writer.
type STPPortResult struct {
	DeviceID uuid.UUID
	IfIndex  int    // resolved to interface_id by writer
	State    string // "disabled"|"blocking"|"listening"|"learning"|"forwarding"
	Role     string // "unknown"|"root"|"designated"|"alternate"|"backup"
}

// SNMPV2cCredential is the unmarshalled form of a snmp_v2c credentials record.
type SNMPV2cCredential struct {
	Community string `json:"community"`
}

// SNMPV3Credential is the unmarshalled form of a snmp_v3 credentials record.
type SNMPV3Credential struct {
	Username     string `json:"username"`
	AuthProtocol string `json:"auth_protocol"` // "SHA" | "MD5" | "SHA224" | "SHA256" | "SHA384" | "SHA512"
	AuthKey      string `json:"auth_key"`
	PrivProtocol string `json:"priv_protocol"` // "AES" | "AES192" | "AES256" | "DES"
	PrivKey      string `json:"priv_key"`
}

// DeviceRow is a minimal database record describing a device to be polled.
// Populated by the writer package when refreshing the device list.
type DeviceRow struct {
	ID               uuid.UUID
	MgmtIP           string
	SNMPVersion      string // "v2c" | "v3"
	SNMPPort         int
	PollingIntervalS int
	CredentialType   string // "snmp_v2c" | "snmp_v3"
	CredentialData   []byte // raw (possibly encrypted) JSONB bytes
}
