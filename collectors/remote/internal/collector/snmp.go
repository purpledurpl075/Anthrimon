// Package collector contains the SNMP, flow, and syslog collectors that run
// inside the remote-collector process.
package collector

import (
	"context"
	"encoding/hex"
	"fmt"
	"math"
	"net"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/gosnmp/gosnmp"
	"github.com/rs/zerolog"

	"github.com/purpledurpl075/anthri-mon/collectors/remote/internal/config"
	"github.com/purpledurpl075/anthri-mon/collectors/remote/internal/hub"
)

// ─── OID constants ────────────────────────────────────────────────────────────

const (
	// System
	oidSysUpTime = "1.3.6.1.2.1.1.3.0"
	oidSysDescr     = "1.3.6.1.2.1.1.1.0"
	oidSysObjectID  = "1.3.6.1.2.1.1.2.0"
	oidSysName      = "1.3.6.1.2.1.1.5.0"
	oidSnmpEngineID = "1.3.6.1.6.3.10.2.1.1.0" // SNMP-FRAMEWORK-MIB

	// IF-MIB — ifTable (32-bit counters, admin/oper status, speed, descr)
	oidIfTable      = "1.3.6.1.2.1.2.2.1"
	// IF-MIB — ifXTable (64-bit HC counters, ifName, ifHighSpeed, ifAlias)
	oidIfXTable     = "1.3.6.1.2.1.31.1.1.1"

	// HOST-RESOURCES-MIB
	oidHrProcessorLoad = "1.3.6.1.2.1.25.3.3.1.2"
	oidHrStorageTable  = "1.3.6.1.2.1.25.2.3.1"
	oidHrStorageTypeRAMSuffix = ".2" // hrStorageRam OID ends in .2

	// ENTITY-MIB — physical entity names/descriptions (correlate with sensor index)
	oidEntPhysicalDescr = "1.3.6.1.2.1.47.1.1.1.1.2"
	oidEntPhysicalName  = "1.3.6.1.2.1.47.1.1.1.1.7"

	// ENTITY-SENSOR-MIB
	oidEntPhySensorType      = "1.3.6.1.2.1.99.1.1.1.1"
	oidEntPhySensorScale     = "1.3.6.1.2.1.99.1.1.1.2"
	oidEntPhySensorPrecision = "1.3.6.1.2.1.99.1.1.1.3"
	oidEntPhySensorValue     = "1.3.6.1.2.1.99.1.1.1.4"

	// BRIDGE-MIB (RFC 4188) — spanning tree
	oidDot1dBasePortIfIndex = "1.3.6.1.2.1.17.1.4.1.2"  // bridge port → ifIndex
	oidDot1dStpPortState    = "1.3.6.1.2.1.17.2.15.1.3"  // STP port state (1-5)
	oidDot1dStpPortRole     = "1.3.6.1.2.1.17.2.15.1.10" // RSTP port role (0-5)

	// IF-MIB
	oidIfDescr = "1.3.6.1.2.1.2.2.1.2" // ifDescr — interface description (indexed by ifIndex)

	// JUNIPER-DOM-MIB (jnxDomCurrentEntry, 1.3.6.1.4.1.2636.3.60.1.1.1.1)
	oidJnxDomCurrentTxPower = "1.3.6.1.4.1.2636.3.60.1.1.1.1.4" // laser output power, 0.001 mW units
	oidJnxDomCurrentRxPower = "1.3.6.1.4.1.2636.3.60.1.1.1.1.8" // laser rx power, 0.001 mW units

	// ARISTA-IF-MIB (1.3.6.1.4.1.30065.3.15) — additional per-interface counters
	oidAristaIfOperStatusChanges = "1.3.6.1.4.1.30065.3.15.1.1.1.8"  // flap count since boot
	oidAristaIfInAclDrops        = "1.3.6.1.4.1.30065.3.15.1.1.1.9"  // inbound ACL drops
	oidAristaIfErrDisabledReason = "1.3.6.1.4.1.30065.3.15.1.1.1.10" // non-empty = err-disabled, contains reason

	// ARISTA-HARDWARE-UTILIZATION-MIB (1.3.6.1.4.1.30065.3.22) — TCAM/resource utilization
	// Index: OctetString(resource) + OctetString(feature) + OctetString(chip)
	oidAristaHwUtilInUse = "1.3.6.1.4.1.30065.3.22.1.1.1.4" // in-use entries
	oidAristaHwUtilMax   = "1.3.6.1.4.1.30065.3.22.1.1.1.7" // max entries

	// ARISTA-FIB-STATS-MIB (1.3.6.1.4.1.30065.3.23) — total FIB routes per address family
	// aristaFIBStatsTotalRoutes indexed by InetVersion: ipv4=1, ipv6=2
	oidAristaFIBTotalRoutesIPv4 = "1.3.6.1.4.1.30065.3.23.1.1.1.2.1"
	oidAristaFIBTotalRoutesIPv6 = "1.3.6.1.4.1.30065.3.23.1.1.1.2.2"

	// IP-FORWARD-MIB — route tables. ipCidrRouteTable (RFC 2096) is tried
	// first; inetCidrRouteTable (RFC 4292) is the fallback for devices that
	// only implement the newer table (e.g. Aruba CX).
	oidIPCidrRouteTable   = "1.3.6.1.2.1.4.24.4.1"
	oidInetCidrRouteTable = "1.3.6.1.2.1.4.24.7.1"

	// CISCO-ENVMON-MIB (1.3.6.1.4.1.9.9.13) — fan and PSU status
	// Supported on IOS, IOS-XE, NX-OS; partially on IOS-XR.
	// Fan state: normal=1, warning=2, critical=3, shutdown=4, notPresent=5, notFunctioning=6
	oidCiscoEnvMonFanDescr = "1.3.6.1.4.1.9.9.13.1.4.1.2" // ciscoEnvMonFanStatusDescr
	oidCiscoEnvMonFanState = "1.3.6.1.4.1.9.9.13.1.4.1.3" // ciscoEnvMonFanState
	oidCiscoEnvMonPSUDescr = "1.3.6.1.4.1.9.9.13.1.5.1.2" // ciscoEnvMonSupplyStatusDescr
	oidCiscoEnvMonPSUState = "1.3.6.1.4.1.9.9.13.1.5.1.3" // ciscoEnvMonSupplyState

	// CISCO-IF-EXTENSION-MIB (1.3.6.1.4.1.9.9.276) — extended per-interface counters
	// cieIfPacketStatsTable — indexed by ifIndex
	oidCieIfInputQueueDrops  = "1.3.6.1.4.1.9.9.276.1.1.1.1.10" // input queue drops
	oidCieIfOutputQueueDrops = "1.3.6.1.4.1.9.9.276.1.1.1.1.11" // output queue drops
	// cieIfInterfaceTable — indexed by ifIndex
	oidCieIfResetCount = "1.3.6.1.4.1.9.9.276.1.2.3.1.8" // interface resets since boot

	// CISCO-MEMORY-POOL-MIB (1.3.6.1.4.1.9.9.48) — named memory pools
	// Indexed by pool-type integer; pool 1=Processor, 2=Reserve, 3=I/O, etc.
	oidCiscoMemPoolName = "1.3.6.1.4.1.9.9.48.1.1.1.2" // ciscoMemoryPoolName
	oidCiscoMemPoolUsed = "1.3.6.1.4.1.9.9.48.1.1.1.5" // ciscoMemoryPoolUsed (bytes)
	oidCiscoMemPoolFree = "1.3.6.1.4.1.9.9.48.1.1.1.6" // ciscoMemoryPoolFree (bytes)

	// CISCO-CEF-MIB (1.3.6.1.4.1.9.9.217) — CEF FIB prefix counts
	// cefFIBSummaryFwdPrefixes — indexed by entPhysicalIndex + cefFIBIpVersion (ipv4=1, ipv6=2)
	oidCiscoCEFFIBPrefixes = "1.3.6.1.4.1.9.9.217.1.2.1.1.3"

	// ARUBAWIRED-ENVIRONMENT-MIB (1.3.6.1.4.1.47196.4.1.1.3.12)
	// PSU table — indexed by INTEGER psu_index
	oidArubaCXPSUName       = "1.3.6.1.4.1.47196.4.1.1.3.12.1.1.1.2" // DisplayString
	oidArubaCXPSUStatus     = "1.3.6.1.4.1.47196.4.1.1.3.12.1.1.1.3" // ok=1, input-fault=2, output-fault=3, absent=4, unknown=5
	oidArubaCXPSUInputPower = "1.3.6.1.4.1.47196.4.1.1.3.12.1.1.1.4" // watts (INTEGER)
	oidArubaCXPSUMaxPower   = "1.3.6.1.4.1.47196.4.1.1.3.12.1.1.1.5" // watts (INTEGER)
	// Fan table — indexed by INTEGER fan_index
	oidArubaCXFanName      = "1.3.6.1.4.1.47196.4.1.1.3.12.1.2.1.2" // DisplayString
	oidArubaCXFanState     = "1.3.6.1.4.1.47196.4.1.1.3.12.1.2.1.3" // ok=1, fault=2
	oidArubaCXFanRPM       = "1.3.6.1.4.1.47196.4.1.1.3.12.1.2.1.4" // rpm (INTEGER)
	oidArubaCXFanSpeedPct  = "1.3.6.1.4.1.47196.4.1.1.3.12.1.2.1.5" // 0-100 %

	// ARUBAWIRED-VSX-MIB (1.3.6.1.4.1.47196.4.1.1.3.14) — Virtual Switching Extension
	// Scalars (.0 suffix)
	oidArubaCXVSXEnabled       = "1.3.6.1.4.1.47196.4.1.1.3.14.1.1.1.0" // TruthValue: 1=true
	oidArubaCXVSXOperState     = "1.3.6.1.4.1.47196.4.1.1.3.14.1.1.2.0" // in-sync=1, out-of-sync=2, standalone=3, not-active=4
	oidArubaCXVSXRole          = "1.3.6.1.4.1.47196.4.1.1.3.14.1.1.3.0" // primary=1, secondary=2, undefined=3
	oidArubaCXVSXConfigSyncing = "1.3.6.1.4.1.47196.4.1.1.3.14.1.1.4.0" // TruthValue: 1=syncing
	oidArubaCXVSXISLState      = "1.3.6.1.4.1.47196.4.1.1.3.14.1.1.5.0" // up=1, down=2

	// ARUBAWIRED-COPP-MIB (1.3.6.1.4.1.47196.4.1.1.3.11) — Control Plane Policing
	// Table indexed by INTEGER copp_index
	oidArubaCXCoPPClass     = "1.3.6.1.4.1.47196.4.1.1.3.11.1.1.1.1" // class/queue name
	oidArubaCXCoPPDropPkts  = "1.3.6.1.4.1.47196.4.1.1.3.11.1.1.1.4" // total dropped packets
	oidArubaCXCoPPDropBytes = "1.3.6.1.4.1.47196.4.1.1.3.11.1.1.1.5" // total dropped bytes

	// ARUBAWIRED-LOOP-PROTECT-MIB (1.3.6.1.4.1.47196.4.1.1.3.6)
	// Table indexed by ifIndex
	oidArubaCXLoopProtectPortState = "1.3.6.1.4.1.47196.4.1.1.3.6.1.1.1.2" // disabled=1, blocked=2, enabled=3
	oidArubaCXLoopProtectDetected  = "1.3.6.1.4.1.47196.4.1.1.3.6.1.1.1.3" // TruthValue: 1=loop detected

	// RFC 3433 SensorDataScale: actual = value * 10^((scale-9)*3) / 10^precision
	entSensorTypeCelsius = 8
	entSensorTypeWatts   = 6  // optical power on Arista EOS, Aruba CX
	entSensorTypeDBm     = 14 // optical power on Cisco IOS-XE/XR/NX-OS (dBm direct)
	entSensorScaleUnits  = 9  // units(9) → 10^0
)

// ─── SNMPCollector ────────────────────────────────────────────────────────────

// SNMPCollector polls assigned devices via SNMP and forwards Prometheus text
// metrics to the hub.
type SNMPCollector struct {
	hub     *hub.Client
	cfg     config.SNMPConfig
	log     zerolog.Logger

	mu      sync.RWMutex
	devices []hub.Device

	pollNowCh chan string // device ID to repoll immediately; "" = all devices
}

// NewSNMPCollector creates a new SNMPCollector.
func NewSNMPCollector(hubClient *hub.Client, cfg config.SNMPConfig, log zerolog.Logger) *SNMPCollector {
	return &SNMPCollector{
		hub:       hubClient,
		cfg:       cfg,
		log:       log.With().Str("component", "snmp_collector").Logger(),
		pollNowCh: make(chan string, 16),
	}
}

// TriggerPoll queues an immediate SNMP poll for one device (by ID) or all
// devices (empty string).  Non-blocking: if the channel is full the trigger
// is silently dropped since a poll is already queued.
func (c *SNMPCollector) TriggerPoll(deviceID string) {
	select {
	case c.pollNowCh <- deviceID:
	default:
	}
}

// SetDevices replaces the device list used by the poller.
func (c *SNMPCollector) SetDevices(devices []hub.Device) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.devices = devices
	c.log.Info().Int("count", len(devices)).Msg("device list updated")
}

// Run starts periodic SNMP polling.  It blocks until ctx is cancelled.
func (c *SNMPCollector) Run(ctx context.Context) {
	interval := time.Duration(c.cfg.PollingIntervalS) * time.Second
	if interval <= 0 {
		interval = 60 * time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	c.log.Info().Dur("interval", interval).Msg("snmp poller started")

	c.pollAll(ctx)

	for {
		select {
		case <-ctx.Done():
			c.log.Info().Msg("snmp poller stopped")
			return
		case <-ticker.C:
			c.pollAll(ctx)
		case deviceID := <-c.pollNowCh:
			go c.pollOneByID(ctx, deviceID)
		}
	}
}

// pollOneByID polls a single device by ID and posts its metrics immediately.
// Used for trap-triggered re-polls.
func (c *SNMPCollector) pollOneByID(ctx context.Context, deviceID string) {
	c.mu.RLock()
	var dev *hub.Device
	for i := range c.devices {
		if c.devices[i].ID == deviceID {
			d := c.devices[i]
			dev = &d
			break
		}
	}
	c.mu.RUnlock()

	if dev == nil {
		c.log.Warn().Str("device_id", deviceID).Msg("trap repoll: device not found")
		return
	}

	lines, _, err := c.pollDevice(*dev)
	ts := time.Now().UnixMilli()
	if err != nil || len(lines) == 0 {
		if err != nil {
			c.log.Warn().Err(err).Str("device_id", deviceID).Msg("trap repoll failed")
		}
		lines = []string{fmt.Sprintf(`anthrimon_device_unreachable{device_id=%q} 1 %d`, deviceID, ts)}
	}

	text := strings.Join(lines, "\n") + "\n"
	if err := c.hub.PostMetrics(ctx, text); err != nil {
		c.log.Error().Err(err).Str("device_id", deviceID).Msg("trap repoll: failed to post metrics")
	} else {
		c.log.Debug().Str("device_id", deviceID).Msg("trap repoll metrics posted")
	}
}

// pollAll polls every device using a bounded goroutine pool.
func (c *SNMPCollector) pollAll(ctx context.Context) {
	c.mu.RLock()
	devices := make([]hub.Device, len(c.devices))
	copy(devices, c.devices)
	c.mu.RUnlock()

	if len(devices) == 0 {
		return
	}

	sem := make(chan struct{}, c.cfg.MaxConcurrent)
	var wg sync.WaitGroup
	var mu sync.Mutex
	var lines []string

outer:
	for _, dev := range devices {
		dev := dev
		select {
		case sem <- struct{}{}:
		case <-ctx.Done():
			break outer
		}
		wg.Add(1)

		go func() {
			defer wg.Done()
			defer func() { <-sem }()

			devLines, devRoutes, err := c.pollDevice(dev)

			mu.Lock()
			defer mu.Unlock()

			if err != nil || len(devLines) == 0 {
				// Active failure report: hub sets status='unreachable' immediately,
				// bypassing ARP cache / management-plane survivability gaps.
				if err != nil {
					c.log.Warn().Err(err).Str("device_id", dev.ID).
						Str("ip", dev.MgmtIP).Msg("snmp poll failed")
				} else {
					c.log.Warn().Str("device_id", dev.ID).
						Str("ip", dev.MgmtIP).Msg("snmp poll returned no metrics")
				}
				lines = append(lines,
					fmt.Sprintf(`anthrimon_device_unreachable{device_id=%q} 1 %d`,
						dev.ID, time.Now().UnixMilli()))
				return
			}

			lines = append(lines, devLines...)

			// Routes: SNMP is not the source of truth for Arista-eAPI or
			// Aruba-CX-REST devices (their routes come from those
			// collectors' own per-device PostRoutes calls) -- skip posting
			// here so we don't tell the hub "zero routes, purge" for a
			// device whose routes are maintained elsewhere. For all other
			// devices, post unconditionally (even when devRoutes is empty)
			// so the hub can purge a now-empty table.
			routeSourceIsSNMP := !((dev.Vendor == "arista" && dev.EapiEnabled) ||
				(dev.Vendor == "aruba_cx" && dev.RestCollectionEnabled))
			if routeSourceIsSNMP {
				if err := c.hub.PostRoutes(ctx, dev.ID, devRoutes); err != nil {
					c.log.Error().Err(err).Str("device_id", dev.ID).Msg("failed to post routes to hub")
				} else {
					c.log.Debug().Str("device_id", dev.ID).Int("routes", len(devRoutes)).Msg("routes posted")
				}
			}
		}()
	}

	wg.Wait()

	if len(lines) == 0 {
		return
	}

	text := strings.Join(lines, "\n") + "\n"
	if err := c.hub.PostMetrics(ctx, text); err != nil {
		c.log.Error().Err(err).Msg("failed to post metrics to hub")
	} else {
		c.log.Debug().Int("lines", len(lines)).Msg("metrics posted")
	}
}

// pollDevice connects to one device and returns Prometheus-format metric
// lines plus route_entries-shaped route records.
func (c *SNMPCollector) pollDevice(dev hub.Device) ([]string, []map[string]any, error) {
	cred := pickSNMPCredential(dev.Credentials)
	if cred == nil {
		return nil, nil, fmt.Errorf("no usable snmp credential for %s", dev.ID)
	}

	g, err := buildSNMPClient(dev, cred, c.cfg)
	if err != nil {
		return nil, nil, fmt.Errorf("build snmp client: %w", err)
	}
	if err := g.Connect(); err != nil {
		return nil, nil, fmt.Errorf("snmp connect %s: %w", dev.MgmtIP, err)
	}
	defer g.Conn.Close()

	ts := time.Now().UnixMilli()

	var lines []string

	// sysUpTime — first SNMP exchange; for v3 this triggers engine discovery,
	// populating AuthoritativeEngineID in the security parameters.
	uptime, err := getSysUpTime(g)
	if err == nil {
		// Match the hub's metric name and label set exactly.
		lines = append(lines,
			fmt.Sprintf(`anthrimon_device_uptime_seconds{device_id=%q} %d %d`,
				dev.ID, uptime/100, ts))
	}

	// sysName + sysDescr + sysObjectID + snmpEngineID — emitted once per cycle.
	// snmpEngineID is included here so v2c devices get it via OID; for v3 devices
	// the USM handshake (triggered by getSysUpTime above) has already populated
	// AuthoritativeEngineID in the security parameters.
	sysInfoResult, sysErr := g.Get([]string{oidSysName, oidSysDescr, oidSysObjectID, oidSnmpEngineID})
	if sysErr == nil && len(sysInfoResult.Variables) >= 2 {
		sysName  := strings.TrimSpace(pduString(sysInfoResult.Variables[0]))
		sysDescr := strings.TrimSpace(pduString(sysInfoResult.Variables[1]))
		sysOID   := ""
		if len(sysInfoResult.Variables) >= 3 {
			sysOID = strings.TrimPrefix(pduString(sysInfoResult.Variables[2]), ".")
		}
		if sysName != "" {
			lines = append(lines,
				fmt.Sprintf(`anthrimon_device_info{device_id=%q,sysname=%q,sysdescr=%q,sysobjectid=%q} 1 %d`,
					dev.ID, sysName, sysDescr, sysOID, ts))
		}
	}

	// Extract SNMP engine ID now that at least one SNMP exchange has completed.
	// For v3: AuthoritativeEngineID is populated after the first Get above.
	// For v2c: the snmpEngineID OID was included in the sysInfo Get.
	var engineHex string
	if g.Version == gosnmp.Version3 {
		if params, ok := g.SecurityParameters.(*gosnmp.UsmSecurityParameters); ok {
			if eid := params.AuthoritativeEngineID; len(eid) > 0 {
				engineHex = hex.EncodeToString([]byte(eid))
			}
		}
	} else if sysErr == nil && len(sysInfoResult.Variables) >= 4 {
		if b, ok := sysInfoResult.Variables[3].Value.([]byte); ok && len(b) > 0 {
			engineHex = hex.EncodeToString(b)
		}
	}
	if engineHex != "" {
		go func() {
			_ = c.hub.PostEngineIDs(context.Background(), []map[string]any{
				{"device_id": dev.ID, "engine_id": engineHex},
			})
		}()
	}

	// Interface counters, speed, oper-status — HC 64-bit preferred over 32-bit.
	ifLines := pollInterfaces(g, dev, ts, c.log)
	lines = append(lines, ifLines...)

	// CPU via hrProcessorLoad
	cpuLines, err := pollCPU(g, dev, ts)
	if err == nil {
		lines = append(lines, cpuLines...)
	}

	// Memory via hrStorageTable
	memLines := pollMemory(g, dev, ts, c.log)
	lines = append(lines, memLines...)

	// BRIDGE-MIB — STP per-port state and role (non-fatal; many devices won't support it)
	lines = append(lines, pollSTP(g, dev, ts)...)

	// ENTITY-SENSOR-MIB — use a short timeout so devices that don't support it
	// (e.g. ProCurve) don't stall the poll.  Restore afterwards is unnecessary
	// since nothing follows, but kept for clarity.
	origTimeout, origRetries := g.Timeout, g.Retries
	g.Timeout = 2 * time.Second
	g.Retries = 1
	typeByIdx, scaleByIdx, precByIdx, valByIdx, nameByIdx := collectEntitySensorMIB(g, c.log)
	g.Timeout, g.Retries = origTimeout, origRetries
	lines = append(lines, buildTemperatureLines(dev, ts, typeByIdx, scaleByIdx, precByIdx, valByIdx, nameByIdx)...)
	// Juniper optical power lives in JUNIPER-DOM-MIB; all other vendors use ENTITY-SENSOR-MIB.
	if dev.Vendor == "juniper" {
		lines = append(lines, pollOpticalPowerJuniper(g, dev, ts)...)
	} else {
		lines = append(lines, buildOpticalPowerLines(dev, ts, typeByIdx, scaleByIdx, precByIdx, valByIdx, nameByIdx)...)
	}

	// Arista-specific extended metrics: interface stats, TCAM utilization, FIB route counts.
	if dev.Vendor == "arista" {
		lines = append(lines, pollAristaExtended(g, dev, ts)...)
	}
	// Aruba CX extended metrics: fan/PSU health, VSX state, CoPP drops, loop protect.
	if dev.Vendor == "aruba_cx" {
		lines = append(lines, pollArubaCXExtended(g, dev, ts)...)
	}
	// Cisco extended metrics: env health, queue drops, memory pools, CEF FIB counts.
	if strings.HasPrefix(dev.Vendor, "cisco_") {
		lines = append(lines, pollCiscoExtended(g, dev, ts)...)
	}

	// Route table — ipCidrRouteTable/inetCidrRouteTable, skipped for devices
	// where eAPI/REST route collection is authoritative (see pollRoutes).
	routes := pollRoutes(g, dev, resolveIfNames(g))

	return lines, routes, nil
}

// ─── Interface collection ─────────────────────────────────────────────────────

// pollInterfaces walks ifTable and ifXTable, merges by ifIndex, and returns
// Prometheus lines for all interface metrics.  HC 64-bit counters from ifXTable
// take precedence over 32-bit ifTable counters when both are present.
func pollInterfaces(g *gosnmp.GoSNMP, dev hub.Device, ts int64, log zerolog.Logger) []string {
	type ifRow struct {
		descr        string
		ifName       string // ifXTable col 1 — preferred display name
		adminStatus  int
		operStatus   int
		speed        uint64 // ifSpeed bps (32-bit)
		highSpeed    uint64 // ifHighSpeed Mbps (ifXTable col 15)
		inOctets     uint64
		inDiscards   uint64
		inErrors     uint64
		outOctets    uint64
		outDiscards  uint64
		outErrors    uint64
		hcInOctets   uint64 // 64-bit HC counters (ifXTable)
		hcOutOctets  uint64
	}

	rows := make(map[int]*ifRow)
	ensure := func(idx int) *ifRow {
		if r, ok := rows[idx]; ok {
			return r
		}
		r := &ifRow{}
		rows[idx] = r
		return r
	}

	// Walk the full ifTable — one walk gets all columns.
	if err := g.BulkWalk(oidIfTable, func(pdu gosnmp.SnmpPDU) error {
		col, idx := splitColIdx(pdu.Name, oidIfTable)
		if idx < 0 {
			return nil
		}
		r := ensure(idx)
		switch col {
		case 2:  r.descr = pduString(pdu)
		case 5:  r.speed = pduUint64(pdu)
		case 7:  r.adminStatus = pduInt(pdu)
		case 8:  r.operStatus = pduInt(pdu)
		case 10: r.inOctets = pduUint64(pdu)
		case 13: r.inDiscards = pduUint64(pdu)
		case 14: r.inErrors = pduUint64(pdu)
		case 16: r.outOctets = pduUint64(pdu)
		case 19: r.outDiscards = pduUint64(pdu)
		case 20: r.outErrors = pduUint64(pdu)
		}
		return nil
	}); err != nil {
		log.Debug().Err(err).Str("device_id", dev.ID).Msg("ifTable walk error")
	}

	// Walk ifXTable for HC counters, ifName, and ifHighSpeed.
	if err := g.BulkWalk(oidIfXTable, func(pdu gosnmp.SnmpPDU) error {
		col, idx := splitColIdx(pdu.Name, oidIfXTable)
		if idx < 0 {
			return nil
		}
		r := ensure(idx)
		switch col {
		case 1:  r.ifName = pduString(pdu)
		case 6:  r.hcInOctets = pduUint64(pdu)
		case 10: r.hcOutOctets = pduUint64(pdu)
		case 15: r.highSpeed = pduUint64(pdu)
		}
		return nil
	}); err != nil {
		log.Debug().Err(err).Str("device_id", dev.ID).Msg("ifXTable walk error")
	}

	var lines []string
	for ifIdx, r := range rows {
		// Use ifName (ifXTable) when available; fall back to ifDescr.
		name := r.ifName
		if name == "" {
			name = r.descr
		}
		if name == "" {
			name = fmt.Sprintf("if%d", ifIdx)
		}

		// Speed: prefer ifHighSpeed (Mbps → bps); fall back to 32-bit ifSpeed.
		speedBPS := r.speed
		if r.highSpeed > 0 {
			speedBPS = r.highSpeed * 1_000_000
		}

		// Counters: prefer HC 64-bit; fall back to 32-bit when HC is zero.
		inOctets  := pickCounter(r.hcInOctets, r.inOctets)
		outOctets := pickCounter(r.hcOutOctets, r.outOctets)

		// oper/admin status: normalise to 1=up / 0=down (SNMP: 1=up, 2=down).
		operBit := 0
		if r.operStatus == 1 {
			operBit = 1
		}
		adminBit := 0
		if r.adminStatus == 1 {
			adminBit = 1
		}

		labels := fmt.Sprintf(`device_id=%q,if_index="%d",if_name=%q,vendor=%q`,
			dev.ID, ifIdx, name, dev.Vendor)

		lines = append(lines,
			fmt.Sprintf("anthrimon_if_in_octets_total{%s} %d %d", labels, inOctets, ts),
			fmt.Sprintf("anthrimon_if_out_octets_total{%s} %d %d", labels, outOctets, ts),
			fmt.Sprintf("anthrimon_if_in_errors_total{%s} %d %d", labels, r.inErrors, ts),
			fmt.Sprintf("anthrimon_if_out_errors_total{%s} %d %d", labels, r.outErrors, ts),
			fmt.Sprintf("anthrimon_if_in_discards_total{%s} %d %d", labels, r.inDiscards, ts),
			fmt.Sprintf("anthrimon_if_out_discards_total{%s} %d %d", labels, r.outDiscards, ts),
			fmt.Sprintf("anthrimon_if_speed_bps{%s} %d %d", labels, speedBPS, ts),
			fmt.Sprintf("anthrimon_if_oper_status{%s} %d %d", labels, operBit, ts),
			fmt.Sprintf("anthrimon_if_admin_status{%s} %d %d", labels, adminBit, ts),
		)
	}
	return lines
}

// pickCounter returns hc if it is non-zero, otherwise falls back to fallback.
// Some devices populate the HC counters only after the 32-bit counter wraps,
// so a zero HC value with a non-zero 32-bit value means use the 32-bit one.
func pickCounter(hc, fallback uint64) uint64 {
	if hc > 0 {
		return hc
	}
	return fallback
}

// ─── CPU ──────────────────────────────────────────────────────────────────────

func pollCPU(g *gosnmp.GoSNMP, dev hub.Device, ts int64) ([]string, error) {
	var lines []string
	idx := 0
	err := g.BulkWalk(oidHrProcessorLoad, func(pdu gosnmp.SnmpPDU) error {
		load := pduUint64(pdu)
		lines = append(lines,
			fmt.Sprintf(`anthrimon_device_cpu_util_pct{device_id=%q,cpu_index="%d"} %d %d`,
				dev.ID, idx, load, ts))
		idx++
		return nil
	})
	return lines, err
}

// ─── Memory ───────────────────────────────────────────────────────────────────

func pollMemory(g *gosnmp.GoSNMP, dev hub.Device, ts int64, log zerolog.Logger) []string {
	type storageRow struct {
		storageType string
		allocUnits  uint64
		size        uint64
		used        uint64
	}

	rows := make(map[int]*storageRow)
	ensure := func(i int) *storageRow {
		if r, ok := rows[i]; ok {
			return r
		}
		r := &storageRow{}
		rows[i] = r
		return r
	}

	if err := g.BulkWalk(oidHrStorageTable, func(pdu gosnmp.SnmpPDU) error {
		col, idx := splitColIdx(pdu.Name, oidHrStorageTable)
		if idx < 0 {
			return nil
		}
		r := ensure(idx)
		switch col {
		case 2: r.storageType = pduString(pdu)
		case 4: r.allocUnits = pduUint64(pdu)
		case 5: r.size = pduUint64(pdu)
		case 6: r.used = pduUint64(pdu)
		}
		return nil
	}); err != nil {
		log.Debug().Err(err).Str("device_id", dev.ID).Msg("hrStorageTable walk error")
	}

	var lines []string
	for _, r := range rows {
		if !strings.HasSuffix(r.storageType, oidHrStorageTypeRAMSuffix) {
			continue
		}
		if r.size == 0 {
			continue
		}
		totalBytes := r.size * r.allocUnits
		usedBytes  := r.used * r.allocUnits
		lines = append(lines,
			fmt.Sprintf(`anthrimon_device_mem_total_bytes{device_id=%q,mem_type="ram"} %d %d`,
				dev.ID, totalBytes, ts),
			fmt.Sprintf(`anthrimon_device_mem_used_bytes{device_id=%q,mem_type="ram"} %d %d`,
				dev.ID, usedBytes, ts),
		)
	}
	return lines
}

// ─── STP ──────────────────────────────────────────────────────────────────────

// pollSTP walks dot1dStpPortState and dot1dStpPortRole from BRIDGE-MIB and emits
// one anthrimon_if_stp_state and one anthrimon_if_stp_role line per interface.
// Returns nil if the device doesn't support the BRIDGE-MIB.
func pollSTP(g *gosnmp.GoSNMP, dev hub.Device, ts int64) []string {
	// Build bridge port → ifIndex mapping from dot1dBasePortIfIndex.
	bridgeToIf := make(map[int]int)
	_ = g.BulkWalk(oidDot1dBasePortIfIndex, func(pdu gosnmp.SnmpPDU) error {
		portNum := lastOIDIndex(pdu.Name)
		if portNum > 0 {
			bridgeToIf[portNum] = pduInt(pdu)
		}
		return nil
	})

	type stpRow struct{ state, role int }
	ports := make(map[int]*stpRow)
	ensure := func(p int) *stpRow {
		if r, ok := ports[p]; ok {
			return r
		}
		r := &stpRow{}
		ports[p] = r
		return r
	}

	// Walk dot1dStpPortState — if empty, device doesn't participate in STP.
	if err := g.BulkWalk(oidDot1dStpPortState, func(pdu gosnmp.SnmpPDU) error {
		portNum := lastOIDIndex(pdu.Name)
		if portNum > 0 {
			ensure(portNum).state = pduInt(pdu)
		}
		return nil
	}); err != nil || len(ports) == 0 {
		return nil
	}

	// Walk dot1dStpPortRole (RSTP extension — non-fatal).
	_ = g.BulkWalk(oidDot1dStpPortRole, func(pdu gosnmp.SnmpPDU) error {
		portNum := lastOIDIndex(pdu.Name)
		if portNum > 0 {
			ensure(portNum).role = pduInt(pdu)
		}
		return nil
	})

	var lines []string
	for portNum, r := range ports {
		if r.state == 0 {
			continue
		}
		ifIdx := portNum
		if len(bridgeToIf) > 0 {
			mapped, ok := bridgeToIf[portNum]
			if !ok {
				continue
			}
			ifIdx = mapped
		}
		labels := fmt.Sprintf(`device_id=%q,if_index="%d"`, dev.ID, ifIdx)
		lines = append(lines,
			fmt.Sprintf("anthrimon_if_stp_state{%s} %d %d", labels, r.state, ts),
			fmt.Sprintf("anthrimon_if_stp_role{%s} %d %d", labels, r.role, ts),
		)
	}
	return lines
}

// lastOIDIndex returns the final integer component of an OID name string.
func lastOIDIndex(pduName string) int {
	s := strings.TrimPrefix(pduName, ".")
	dot := strings.LastIndex(s, ".")
	if dot < 0 {
		return -1
	}
	n := 0
	for _, c := range s[dot+1:] {
		if c < '0' || c > '9' {
			return -1
		}
		n = n*10 + int(c-'0')
	}
	return n
}

// ─── Temperature ──────────────────────────────────────────────────────────────

// buildTemperatureLines extracts celsius-type sensor readings from pre-collected
// ENTITY-SENSOR-MIB data and returns anthrimon_device_temp_celsius metric lines.
func buildTemperatureLines(
	dev hub.Device, ts int64,
	typeByIdx map[string]int, scaleByIdx map[string]int, precByIdx map[string]int,
	valByIdx map[string]int, nameByIdx map[string]string,
) []string {
	var lines []string
	for idx, rawVal := range valByIdx {
		if typeByIdx[idx] != entSensorTypeCelsius {
			continue
		}
		name := nameByIdx[idx]
		if name == "" {
			name = "Sensor " + idx
		}

		scaleEnum := scaleByIdx[idx]
		if scaleEnum == 0 {
			scaleEnum = entSensorScaleUnits
		}
		scaleExp  := (scaleEnum - entSensorScaleUnits) * 3
		precision := precByIdx[idx]

		celsius := float64(rawVal) * math.Pow10(scaleExp) / math.Pow10(precision)
		celsius  = math.Round(celsius*10) / 10

		lines = append(lines,
			fmt.Sprintf(`anthrimon_device_temp_celsius{device_id=%q,sensor=%q} %.1f %d`,
				dev.ID, escapeLabelValue(name), celsius, ts))
	}
	return lines
}

// ─── DOM optical power ────────────────────────────────────────────────────────

// buildOpticalPowerLines extracts DOM sensor readings from pre-collected
// ENTITY-SENSOR-MIB data and returns TX/RX optical power lines.
// Handles type 6 (watts, used by Arista EOS and Aruba CX) and
// type 14 (dBm direct, used by Cisco IOS-XE/XR/NX-OS).
func buildOpticalPowerLines(
	dev hub.Device, ts int64,
	typeByIdx map[string]int, scaleByIdx map[string]int, precByIdx map[string]int,
	valByIdx map[string]int, nameByIdx map[string]string,
) []string {
	var lines []string
	for idx, rawVal := range valByIdx {
		sensorType := typeByIdx[idx]
		if sensorType != entSensorTypeWatts && sensorType != entSensorTypeDBm {
			continue
		}
		name := nameByIdx[idx]
		if name == "" {
			continue
		}

		lower := strings.ToLower(name)
		if !isOpticalPowerSensor(lower) {
			continue
		}

		scaleEnum := scaleByIdx[idx]
		if scaleEnum == 0 {
			scaleEnum = entSensorScaleUnits
		}
		scaleExp  := (scaleEnum - entSensorScaleUnits) * 3
		precision := precByIdx[idx]

		var dbm float64
		if sensorType == entSensorTypeDBm {
			dbm = float64(rawVal) * math.Pow10(scaleExp) / math.Pow10(precision)
		} else {
			watts := float64(rawVal) * math.Pow10(scaleExp) / math.Pow10(precision)
			mw    := watts * 1000.0
			if mw > 0 {
				dbm = 10.0 * math.Log10(mw)
			} else {
				dbm = -40.0
			}
		}
		dbm = math.Round(dbm*1000) / 1000

		metric := "anthrimon_if_dom_rx_power_dbm"
		if isOpticalTX(lower) {
			metric = "anthrimon_if_dom_tx_power_dbm"
		}

		ifaceName := extractIfaceName(name)
		lines = append(lines,
			fmt.Sprintf(`%s{device_id=%q,iface=%q} %.4f %d`,
				metric, dev.ID, escapeLabelValue(ifaceName), dbm, ts))
	}
	return lines
}

// resolveIfNames walks ifDescr and returns a map of ifIndex → interface name.
func resolveIfNames(g *gosnmp.GoSNMP) map[string]string {
	names := make(map[string]string)
	_ = g.BulkWalk(oidIfDescr, func(pdu gosnmp.SnmpPDU) error {
		parts := strings.Split(pdu.Name, ".")
		if len(parts) < 1 {
			return nil
		}
		idx := parts[len(parts)-1]
		if v := pduString(pdu); v != "" {
			names[idx] = v
		}
		return nil
	})
	return names
}

// ─── Route table collection ───────────────────────────────────────────────────

// pollRoutes walks ipCidrRouteTable (RFC 2096), falling back to
// inetCidrRouteTable (RFC 4292), and returns route_entries-shaped records for
// the hub's POST /api/v1/collectors/routes endpoint.
//
// Skipped for devices where eAPI/REST route collection is enabled and
// authoritative for routes (Arista eAPI, Aruba CX REST), so the SNMP and API
// paths don't fight over route_entries' per-device mark-and-sweep deletes.
func pollRoutes(g *gosnmp.GoSNMP, dev hub.Device, ifByIdx map[string]string) []map[string]any {
	if (dev.Vendor == "arista" && dev.EapiEnabled) ||
		(dev.Vendor == "aruba_cx" && dev.RestCollectionEnabled) {
		return nil
	}

	if routes := pollRouteTableCidr(g, dev.ID, ifByIdx); len(routes) > 0 {
		return routes
	}
	return pollRouteTableInet(g, dev.ID, ifByIdx)
}

// ── RFC 2096: ipCidrRouteTable ────────────────────────────────────────────────

func pollRouteTableCidr(g *gosnmp.GoSNMP, deviceID string, ifByIdx map[string]string) []map[string]any {
	var pdus []gosnmp.SnmpPDU
	if err := g.BulkWalk(oidIPCidrRouteTable, func(pdu gosnmp.SnmpPDU) error {
		pdus = append(pdus, pdu)
		return nil
	}); err != nil || len(pdus) == 0 {
		return nil
	}

	type rowKey struct{ dest, mask, nexthop string }
	type row struct {
		ifIndex   int
		proto     int
		routeType int
		metric    int
	}
	rows := make(map[rowKey]*row)
	ensure := func(k rowKey) *row {
		if r, ok := rows[k]; ok {
			return r
		}
		r := &row{}
		rows[k] = r
		return r
	}

	for _, pdu := range pdus {
		col, dest, mask, nexthop, ok := splitCidrRouteIndex(pdu.Name)
		if !ok {
			continue
		}
		k := rowKey{dest, mask, nexthop}
		r := ensure(k)
		switch col {
		case 5:
			r.ifIndex = pduInt(pdu)
		case 6:
			r.routeType = pduInt(pdu)
		case 7:
			r.proto = pduInt(pdu)
		case 11:
			r.metric = pduInt(pdu)
		}
	}

	results := make([]map[string]any, 0, len(rows))
	for k, r := range rows {
		proto := cidrProtoName(r.proto)
		if proto == "" || r.routeType == 2 {
			continue
		}
		nextHop := k.nexthop
		if nextHop == "0.0.0.0" || proto == "connected" {
			nextHop = ""
		}
		results = append(results, map[string]any{
			"device_id":      deviceID,
			"destination":    fmt.Sprintf("%s/%d", k.dest, maskToPrefixLen(k.mask)),
			"next_hop":       nextHop,
			"protocol":       proto,
			"metric":         r.metric,
			"interface_name": ifByIdx[strconv.Itoa(r.ifIndex)],
		})
	}
	return results
}

// splitCidrRouteIndex parses the ipCidrRouteTable OID index.
// Format: col.a.b.c.d.ma.mb.mc.md.tos.na.nb.nc.nd
func splitCidrRouteIndex(pduName string) (col int, dest, mask, nexthop string, ok bool) {
	full := strings.TrimPrefix(pduName, ".")
	base := strings.TrimPrefix(oidIPCidrRouteTable, ".")
	if !strings.HasPrefix(full, base+".") {
		return 0, "", "", "", false
	}
	parts := strings.Split(full[len(base)+1:], ".")
	if len(parts) < 14 {
		return 0, "", "", "", false
	}
	c, err := strconv.Atoi(parts[0])
	if err != nil {
		return 0, "", "", "", false
	}
	dest = strings.Join(parts[1:5], ".")
	mask = strings.Join(parts[5:9], ".")
	nexthop = strings.Join(parts[10:14], ".")
	return c, dest, mask, nexthop, true
}

// cidrProtoName maps IANAipRouteProtocol values (shared by RFC 2096 and
// RFC 4292) to protocol strings.
func cidrProtoName(v int) string {
	switch v {
	case 2:
		return "connected"
	case 3:
		return "static"
	case 8:
		return "rip"
	case 9:
		return "isis"
	case 13:
		return "ospf"
	case 14:
		return "bgp"
	case 16:
		return "eigrp"
	case 1:
		return "other"
	default:
		return ""
	}
}

// maskToPrefixLen converts a dotted-decimal subnet mask to a CIDR prefix length.
func maskToPrefixLen(mask string) int {
	parts := strings.Split(mask, ".")
	if len(parts) != 4 {
		return 0
	}
	bits := 0
	for _, p := range parts {
		v, err := strconv.Atoi(p)
		if err != nil {
			break
		}
		b := uint8(v)
		for b != 0 {
			bits += int(b & 1)
			b >>= 1
		}
	}
	return bits
}

// ── RFC 4292: inetCidrRouteTable ─────────────────────────────────────────────
// Used by Aruba CX, modern Juniper, newer IOS-XE, etc.
// Index: destType.destLen.a.b.c.d.pfxLen.policyOID.nhType.nhLen.n.m.o.p
// Protocol uses the IANAipRouteProtocol TC — same numbering as RFC 2096.

func pollRouteTableInet(g *gosnmp.GoSNMP, deviceID string, ifByIdx map[string]string) []map[string]any {
	var pdus []gosnmp.SnmpPDU
	if err := g.BulkWalk(oidInetCidrRouteTable, func(pdu gosnmp.SnmpPDU) error {
		pdus = append(pdus, pdu)
		return nil
	}); err != nil || len(pdus) == 0 {
		return nil
	}

	type row struct {
		ifIndex int
		proto   int
		metric  int
	}
	rows := make(map[string]*row)
	ensure := func(idx string) *row {
		if r, ok := rows[idx]; ok {
			return r
		}
		r := &row{}
		rows[idx] = r
		return r
	}

	for _, pdu := range pdus {
		col, idx, ok := inetCidrParseCol(pdu.Name)
		if !ok {
			continue
		}
		r := ensure(idx)
		// Cols 1-6 are INDEX fields (not accessible):
		// 7=inetCidrRouteIfIndex, 9=Proto, 12=Metric1
		switch col {
		case 7:
			r.ifIndex = pduInt(pdu)
		case 9:
			r.proto = pduInt(pdu)
		case 12:
			r.metric = pduInt(pdu)
		}
	}

	results := make([]map[string]any, 0, len(rows))
	for idx, r := range rows {
		proto := cidrProtoName(r.proto)
		if proto == "" {
			continue
		}

		dest, nexthop, ok := inetCidrParseIndex(idx)
		if !ok {
			continue
		}

		results = append(results, map[string]any{
			"device_id":      deviceID,
			"destination":    dest,
			"next_hop":       nexthop,
			"protocol":       proto,
			"metric":         r.metric,
			"interface_name": ifByIdx[strconv.Itoa(r.ifIndex)],
		})
	}
	return results
}

// inetCidrParseCol extracts column number and raw index string.
// OID: base.col.{index}
func inetCidrParseCol(pduName string) (col int, idx string, ok bool) {
	base := strings.TrimPrefix(oidInetCidrRouteTable, ".")
	full := strings.TrimPrefix(pduName, ".")
	if !strings.HasPrefix(full, base+".") {
		return 0, "", false
	}
	rest := full[len(base)+1:]
	dot := strings.IndexByte(rest, '.')
	if dot < 0 {
		return 0, "", false
	}
	c, err := strconv.Atoi(rest[:dot])
	if err != nil {
		return 0, "", false
	}
	return c, rest[dot+1:], true
}

// inetCidrParseIndex decodes the inetCidrRouteTable OID index for IPv4 and IPv6.
// Index format: destType.destLen.destAddr[destLen].pfxLen.[policy...].nhType.nhLen.nhAddr[nhLen]
// destType 1 = IPv4 (addrLen 4), destType 2 = IPv6 (addrLen 16).
func inetCidrParseIndex(idx string) (dest, nexthop string, ok bool) {
	parts := strings.Split(idx, ".")
	if len(parts) < 4 {
		return "", "", false
	}

	destType, _ := strconv.Atoi(parts[0])
	destLen, _ := strconv.Atoi(parts[1])

	switch destType {
	case 1: // IPv4
		if destLen != 4 || len(parts) < 14 {
			return "", "", false
		}
		destIP := strings.Join(parts[2:6], ".")
		pfxLen := parts[6]
		dest = fmt.Sprintf("%s/%s", destIP, pfxLen)

		for i := 7; i < len(parts)-5; i++ {
			if parts[i] != "1" || parts[i+1] != "4" {
				continue
			}
			if len(parts) < i+6 {
				break
			}
			nh := strings.Join(parts[i+2:i+6], ".")
			if isValidIPOctets(parts[i+2 : i+6]) {
				if nh == "0.0.0.0" {
					nh = ""
				}
				return dest, nh, true
			}
		}
		return dest, "", true

	case 2: // IPv6
		if destLen != 16 || len(parts) < 38 {
			return "", "", false
		}
		destIP := octetsToIPv6(parts[2:18])
		if destIP == "" {
			return "", "", false
		}
		pfxLen := parts[18]
		dest = fmt.Sprintf("%s/%s", destIP, pfxLen)

		// Scan for nexthop: find "2.16" followed by 16 valid octets after the policy field.
		for i := 19; i < len(parts)-17; i++ {
			if parts[i] != "2" || parts[i+1] != "16" {
				continue
			}
			if len(parts) < i+18 {
				break
			}
			nh := octetsToIPv6(parts[i+2 : i+18])
			if nh == "" {
				continue
			}
			if nh == "::" {
				nh = ""
			}
			return dest, nh, true
		}
		return dest, "", true

	default:
		return "", "", false
	}
}

// octetsToIPv6 converts 16 decimal-string octets into a normalised IPv6 address.
func octetsToIPv6(parts []string) string {
	if len(parts) != 16 {
		return ""
	}
	raw := make(net.IP, 16)
	for i, p := range parts {
		v, err := strconv.Atoi(p)
		if err != nil || v < 0 || v > 255 {
			return ""
		}
		raw[i] = byte(v)
	}
	return raw.String()
}

func isValidIPOctets(parts []string) bool {
	if len(parts) != 4 {
		return false
	}
	for _, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 || n > 255 {
			return false
		}
	}
	return true
}

// pollOpticalPowerJuniper collects DOM TX/RX optical power from JUNIPER-DOM-MIB.
// Values are in units of 0.001 mW; converted to dBm.
func pollOpticalPowerJuniper(g *gosnmp.GoSNMP, dev hub.Device, ts int64) []string {
	ifName := resolveIfNames(g)

	toDBm := func(val int) float64 {
		mw := float64(val) * 0.001
		if mw <= 0 {
			return -40.0
		}
		return math.Round(10.0*math.Log10(mw)*1000) / 1000
	}

	var lines []string
	for _, pair := range []struct{ tableOID, metric string }{
		{oidJnxDomCurrentTxPower, "anthrimon_if_dom_tx_power_dbm"},
		{oidJnxDomCurrentRxPower, "anthrimon_if_dom_rx_power_dbm"},
	} {
		_ = g.BulkWalk(pair.tableOID, func(pdu gosnmp.SnmpPDU) error {
			parts := strings.Split(pdu.Name, ".")
			ifIdx := parts[len(parts)-1]
			iface := ifName[ifIdx]
			if iface == "" {
				return nil
			}
			lines = append(lines,
				fmt.Sprintf(`%s{device_id=%q,iface=%q} %.4f %d`,
					pair.metric, dev.ID, escapeLabelValue(iface), toDBm(pduInt(pdu)), ts))
			return nil
		})
	}
	return lines
}

// isOpticalPowerSensor returns true when the lowercase sensor description indicates
// a DOM optical TX or RX power reading.
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

// ─── Arista extended polling ──────────────────────────────────────────────────

// pollAristaExtended collects Arista-specific metrics not available in
// standard MIBs: per-interface extended counters, TCAM utilization,
// and FIB route counts.
func pollAristaExtended(g *gosnmp.GoSNMP, dev hub.Device, ts int64) []string {
	var lines []string
	lines = append(lines, pollAristaIfStats(g, dev, ts)...)
	lines = append(lines, pollAristaHWUtil(g, dev, ts)...)
	lines = append(lines, pollAristaFIB(g, dev, ts)...)
	return lines
}

// pollAristaIfStats collects ARISTA-IF-MIB per-interface counters:
//   - aristaIfOperStatusChanges → anthrimon_if_flap_count_total
//   - aristaIfInAclDrops        → anthrimon_if_acl_drops_total
//   - aristaIfErrDisabledReason → anthrimon_if_err_disabled (1 if non-empty, with reason label)
func pollAristaIfStats(g *gosnmp.GoSNMP, dev hub.Device, ts int64) []string {
	ifNames := resolveIfNames(g)

	type ifRow struct {
		flaps      int
		aclDrops   int
		errReason  string
	}
	rows := make(map[string]*ifRow)
	ensure := func(idx string) *ifRow {
		if r, ok := rows[idx]; ok {
			return r
		}
		r := &ifRow{}
		rows[idx] = r
		return r
	}

	_ = g.BulkWalk(oidAristaIfOperStatusChanges, func(pdu gosnmp.SnmpPDU) error {
		idx := trailingIndex(pdu.Name, oidAristaIfOperStatusChanges)
		if idx != "" {
			ensure(idx).flaps = pduInt(pdu)
		}
		return nil
	})
	_ = g.BulkWalk(oidAristaIfInAclDrops, func(pdu gosnmp.SnmpPDU) error {
		idx := trailingIndex(pdu.Name, oidAristaIfInAclDrops)
		if idx != "" {
			ensure(idx).aclDrops = pduInt(pdu)
		}
		return nil
	})
	_ = g.BulkWalk(oidAristaIfErrDisabledReason, func(pdu gosnmp.SnmpPDU) error {
		idx := trailingIndex(pdu.Name, oidAristaIfErrDisabledReason)
		if idx != "" {
			if v := pduString(pdu); v != "" {
				ensure(idx).errReason = v
			}
		}
		return nil
	})

	var lines []string
	for idx, row := range rows {
		ifName := ifNames[idx]
		if ifName == "" {
			ifName = "if" + idx
		}
		name := escapeLabelValue(ifName)
		base := fmt.Sprintf(`device_id=%q,if_name=%q`, dev.ID, name)
		lines = append(lines,
			fmt.Sprintf(`anthrimon_if_flap_count_total{%s} %d %d`, base, row.flaps, ts),
		)
		if row.aclDrops > 0 {
			lines = append(lines,
				fmt.Sprintf(`anthrimon_if_acl_drops_total{%s} %d %d`, base, row.aclDrops, ts),
			)
		}
		if row.errReason != "" {
			lines = append(lines,
				fmt.Sprintf(`anthrimon_if_err_disabled{%s,reason=%q} 1 %d`,
					base, escapeLabelValue(row.errReason), ts),
			)
		}
	}
	return lines
}

// pollAristaHWUtil walks ARISTA-HARDWARE-UTILIZATION-MIB and emits
// per-resource/feature/chip in-use and max entry counts.
// The index is three length-prefixed OctetString components (resource, feature, chip).
func pollAristaHWUtil(g *gosnmp.GoSNMP, dev hub.Device, ts int64) []string {
	inUse := make(map[string]int)
	maxE  := make(map[string]int)

	_ = g.BulkWalk(oidAristaHwUtilInUse, func(pdu gosnmp.SnmpPDU) error {
		if sfx := oidSuffix(pdu.Name, oidAristaHwUtilInUse); sfx != "" {
			inUse[sfx] = pduInt(pdu)
		}
		return nil
	})
	_ = g.BulkWalk(oidAristaHwUtilMax, func(pdu gosnmp.SnmpPDU) error {
		if sfx := oidSuffix(pdu.Name, oidAristaHwUtilMax); sfx != "" {
			maxE[sfx] = pduInt(pdu)
		}
		return nil
	})

	var lines []string
	for sfx, used := range inUse {
		parts := decodeOctetStrings(sfx)
		if len(parts) < 3 {
			continue
		}
		resource, feature, chip := parts[0], parts[1], parts[2]
		if resource == "" {
			continue
		}
		labels := fmt.Sprintf(`device_id=%q,resource=%q,feature=%q,chip=%q`,
			dev.ID,
			escapeLabelValue(resource),
			escapeLabelValue(feature),
			escapeLabelValue(chip),
		)
		lines = append(lines,
			fmt.Sprintf(`anthrimon_arista_hw_util_used{%s} %d %d`, labels, used, ts),
		)
		if max, ok := maxE[sfx]; ok && max > 0 {
			lines = append(lines,
				fmt.Sprintf(`anthrimon_arista_hw_util_max{%s} %d %d`, labels, max, ts),
			)
		}
	}
	return lines
}

// pollAristaFIB fetches ARISTA-FIB-STATS-MIB total route counts for IPv4 and IPv6.
func pollAristaFIB(g *gosnmp.GoSNMP, dev hub.Device, ts int64) []string {
	result, err := g.Get([]string{oidAristaFIBTotalRoutesIPv4, oidAristaFIBTotalRoutesIPv6})
	if err != nil || len(result.Variables) < 2 {
		return nil
	}
	base := fmt.Sprintf(`device_id=%q`, dev.ID)
	return []string{
		fmt.Sprintf(`anthrimon_fib_routes_total{%s,af="ipv4"} %d %d`, base, pduUint64(result.Variables[0]), ts),
		fmt.Sprintf(`anthrimon_fib_routes_total{%s,af="ipv6"} %d %d`, base, pduUint64(result.Variables[1]), ts),
	}
}

// ─── Cisco extended polling ───────────────────────────────────────────────────

func pollCiscoExtended(g *gosnmp.GoSNMP, dev hub.Device, ts int64) []string {
	var lines []string
	lines = append(lines, pollCiscoEnvMon(g, dev, ts)...)
	lines = append(lines, pollCiscoIfExtension(g, dev, ts)...)
	lines = append(lines, pollCiscoMemPools(g, dev, ts)...)
	lines = append(lines, pollCiscoCEFFIB(g, dev, ts)...)
	return lines
}

// pollCiscoEnvMon walks CISCO-ENVMON-MIB for fan and PSU status.
//
// Emits:
//
//	anthrimon_cisco_fan_ok{device_id, fan_name}  — 1 if normal
//	anthrimon_cisco_psu_ok{device_id, psu_name}  — 1 if normal
func pollCiscoEnvMon(g *gosnmp.GoSNMP, dev hub.Device, ts int64) []string {
	did := fmt.Sprintf(`device_id=%q`, dev.ID)

	fanDescr := make(map[string]string)
	fanState := make(map[string]int)
	psuDescr := make(map[string]string)
	psuState := make(map[string]int)

	_ = g.BulkWalk(oidCiscoEnvMonFanDescr, func(pdu gosnmp.SnmpPDU) error {
		if idx := trailingIndex(pdu.Name, oidCiscoEnvMonFanDescr); idx != "" {
			fanDescr[idx] = pduString(pdu)
		}
		return nil
	})
	_ = g.BulkWalk(oidCiscoEnvMonFanState, func(pdu gosnmp.SnmpPDU) error {
		if idx := trailingIndex(pdu.Name, oidCiscoEnvMonFanState); idx != "" {
			fanState[idx] = pduInt(pdu)
		}
		return nil
	})
	_ = g.BulkWalk(oidCiscoEnvMonPSUDescr, func(pdu gosnmp.SnmpPDU) error {
		if idx := trailingIndex(pdu.Name, oidCiscoEnvMonPSUDescr); idx != "" {
			psuDescr[idx] = pduString(pdu)
		}
		return nil
	})
	_ = g.BulkWalk(oidCiscoEnvMonPSUState, func(pdu gosnmp.SnmpPDU) error {
		if idx := trailingIndex(pdu.Name, oidCiscoEnvMonPSUState); idx != "" {
			psuState[idx] = pduInt(pdu)
		}
		return nil
	})

	var lines []string
	for idx, state := range fanState {
		if state == 5 { continue } // notPresent — don't emit
		name := fanDescr[idx]
		if name == "" { name = "fan" + idx }
		ok := 0
		if state == 1 { ok = 1 }
		lines = append(lines,
			fmt.Sprintf(`anthrimon_cisco_fan_ok{%s,fan_name=%q} %d %d`, did, name, ok, ts),
		)
	}
	for idx, state := range psuState {
		if state == 5 { continue } // notPresent
		name := psuDescr[idx]
		if name == "" { name = "psu" + idx }
		ok := 0
		if state == 1 { ok = 1 }
		lines = append(lines,
			fmt.Sprintf(`anthrimon_cisco_psu_ok{%s,psu_name=%q} %d %d`, did, name, ok, ts),
		)
	}
	return lines
}

// pollCiscoIfExtension walks CISCO-IF-EXTENSION-MIB for per-interface queue
// drops and reset counters.
//
// Emits (only non-zero values):
//
//	anthrimon_cisco_if_in_queue_drops{device_id, if_name}
//	anthrimon_cisco_if_out_queue_drops{device_id, if_name}
//	anthrimon_cisco_if_resets{device_id, if_name}
func pollCiscoIfExtension(g *gosnmp.GoSNMP, dev hub.Device, ts int64) []string {
	ifNames := resolveIfNames(g)
	did := fmt.Sprintf(`device_id=%q`, dev.ID)

	inDrops  := make(map[string]uint64)
	outDrops := make(map[string]uint64)
	resets   := make(map[string]uint64)

	_ = g.BulkWalk(oidCieIfInputQueueDrops, func(pdu gosnmp.SnmpPDU) error {
		if idx := trailingIndex(pdu.Name, oidCieIfInputQueueDrops); idx != "" {
			inDrops[idx] = pduUint64(pdu)
		}
		return nil
	})
	_ = g.BulkWalk(oidCieIfOutputQueueDrops, func(pdu gosnmp.SnmpPDU) error {
		if idx := trailingIndex(pdu.Name, oidCieIfOutputQueueDrops); idx != "" {
			outDrops[idx] = pduUint64(pdu)
		}
		return nil
	})
	_ = g.BulkWalk(oidCieIfResetCount, func(pdu gosnmp.SnmpPDU) error {
		if idx := trailingIndex(pdu.Name, oidCieIfResetCount); idx != "" {
			resets[idx] = pduUint64(pdu)
		}
		return nil
	})

	ifName := func(idx string) string {
		if n := ifNames[idx]; n != "" { return n }
		return "if" + idx
	}

	var lines []string
	for idx, v := range inDrops {
		if v > 0 {
			lines = append(lines, fmt.Sprintf(`anthrimon_cisco_if_in_queue_drops{%s,if_name=%q} %d %d`, did, ifName(idx), v, ts))
		}
	}
	for idx, v := range outDrops {
		if v > 0 {
			lines = append(lines, fmt.Sprintf(`anthrimon_cisco_if_out_queue_drops{%s,if_name=%q} %d %d`, did, ifName(idx), v, ts))
		}
	}
	for idx, v := range resets {
		lines = append(lines, fmt.Sprintf(`anthrimon_cisco_if_resets{%s,if_name=%q} %d %d`, did, ifName(idx), v, ts))
	}
	return lines
}

// pollCiscoMemPools walks CISCO-MEMORY-POOL-MIB for named memory pool utilisation.
//
// Emits:
//
//	anthrimon_cisco_mem_used_bytes{device_id, pool}
//	anthrimon_cisco_mem_free_bytes{device_id, pool}
func pollCiscoMemPools(g *gosnmp.GoSNMP, dev hub.Device, ts int64) []string {
	did := fmt.Sprintf(`device_id=%q`, dev.ID)

	poolName := make(map[string]string)
	poolUsed := make(map[string]uint64)
	poolFree := make(map[string]uint64)

	_ = g.BulkWalk(oidCiscoMemPoolName, func(pdu gosnmp.SnmpPDU) error {
		if idx := trailingIndex(pdu.Name, oidCiscoMemPoolName); idx != "" {
			poolName[idx] = pduString(pdu)
		}
		return nil
	})
	_ = g.BulkWalk(oidCiscoMemPoolUsed, func(pdu gosnmp.SnmpPDU) error {
		if idx := trailingIndex(pdu.Name, oidCiscoMemPoolUsed); idx != "" {
			poolUsed[idx] = pduUint64(pdu)
		}
		return nil
	})
	_ = g.BulkWalk(oidCiscoMemPoolFree, func(pdu gosnmp.SnmpPDU) error {
		if idx := trailingIndex(pdu.Name, oidCiscoMemPoolFree); idx != "" {
			poolFree[idx] = pduUint64(pdu)
		}
		return nil
	})

	var lines []string
	for idx := range poolUsed {
		name := poolName[idx]
		if name == "" { name = "pool" + idx }
		labels := fmt.Sprintf(`%s,pool=%q`, did, name)
		lines = append(lines,
			fmt.Sprintf(`anthrimon_cisco_mem_used_bytes{%s} %d %d`, labels, poolUsed[idx], ts),
			fmt.Sprintf(`anthrimon_cisco_mem_free_bytes{%s} %d %d`, labels, poolFree[idx], ts),
		)
	}
	return lines
}

// pollCiscoCEFFIB walks CISCO-CEF-MIB cefFIBSummaryFwdPrefixes to get total
// FIB route counts by address family. Aggregates across all route-processor
// entities (entPhysicalIndex) — sums if more than one.
// Emits the same metric name as pollAristaFIB so the frontend FIB panel reuses
// automatically.
//
//	anthrimon_fib_routes_total{device_id, af="ipv4|ipv6"}
func pollCiscoCEFFIB(g *gosnmp.GoSNMP, dev hub.Device, ts int64) []string {
	totals := make(map[string]uint64) // af → sum

	_ = g.BulkWalk(oidCiscoCEFFIBPrefixes, func(pdu gosnmp.SnmpPDU) error {
		sfx := oidSuffix(pdu.Name, oidCiscoCEFFIBPrefixes)
		if sfx == "" { return nil }
		// sfx = "<entPhysIndex>.<afi>"
		parts := strings.Split(sfx, ".")
		afi := parts[len(parts)-1]
		af := ""
		switch afi {
		case "1": af = "ipv4"
		case "2": af = "ipv6"
		default: return nil
		}
		totals[af] += pduUint64(pdu)
		return nil
	})

	if len(totals) == 0 { return nil }

	base := fmt.Sprintf(`device_id=%q`, dev.ID)
	var lines []string
	for af, n := range totals {
		lines = append(lines, fmt.Sprintf(`anthrimon_fib_routes_total{%s,af=%q} %d %d`, base, af, n, ts))
	}
	return lines
}

// ─── Aruba CX extended polling ────────────────────────────────────────────────

func pollArubaCXExtended(g *gosnmp.GoSNMP, dev hub.Device, ts int64) []string {
	var lines []string
	lines = append(lines, pollArubaCXEnvironment(g, dev, ts)...)
	lines = append(lines, pollArubaCXVSX(g, dev, ts)...)
	lines = append(lines, pollArubaCXCoPP(g, dev, ts)...)
	lines = append(lines, pollArubaCXLoopProtect(g, dev, ts)...)
	return lines
}

// pollArubaCXEnvironment walks the ARUBAWIRED-ENVIRONMENT-MIB to collect fan and
// PSU health.
//
// Emits:
//
//	anthrimon_cx_psu_ok{device_id, psu_name}          — 1 if ok, 0 if fault/absent
//	anthrimon_cx_psu_power_watts{device_id, psu_name} — current draw (W)
//	anthrimon_cx_psu_max_watts{device_id, psu_name}   — rated capacity (W)
//	anthrimon_cx_fan_ok{device_id, fan_name}           — 1 if ok, 0 if fault
//	anthrimon_cx_fan_rpm{device_id, fan_name}          — RPM
//	anthrimon_cx_fan_speed_pct{device_id, fan_name}   — 0-100%
func pollArubaCXEnvironment(g *gosnmp.GoSNMP, dev hub.Device, ts int64) []string {
	did := fmt.Sprintf(`device_id=%q`, dev.ID)

	type psuRow struct {
		name       string
		status     int
		inputPower int
		maxPower   int
	}
	type fanRow struct {
		name     string
		state    int
		rpm      int
		speedPct int
	}

	psus := make(map[string]*psuRow)
	fans := make(map[string]*fanRow)
	ensurePSU := func(idx string) *psuRow {
		if r, ok := psus[idx]; ok { return r }
		r := &psuRow{}; psus[idx] = r; return r
	}
	ensureFan := func(idx string) *fanRow {
		if r, ok := fans[idx]; ok { return r }
		r := &fanRow{}; fans[idx] = r; return r
	}

	// PSU table
	_ = g.BulkWalk(oidArubaCXPSUName, func(pdu gosnmp.SnmpPDU) error {
		if idx := trailingIndex(pdu.Name, oidArubaCXPSUName); idx != "" {
			ensurePSU(idx).name = pduString(pdu)
		}
		return nil
	})
	_ = g.BulkWalk(oidArubaCXPSUStatus, func(pdu gosnmp.SnmpPDU) error {
		if idx := trailingIndex(pdu.Name, oidArubaCXPSUStatus); idx != "" {
			ensurePSU(idx).status = pduInt(pdu)
		}
		return nil
	})
	_ = g.BulkWalk(oidArubaCXPSUInputPower, func(pdu gosnmp.SnmpPDU) error {
		if idx := trailingIndex(pdu.Name, oidArubaCXPSUInputPower); idx != "" {
			ensurePSU(idx).inputPower = pduInt(pdu)
		}
		return nil
	})
	_ = g.BulkWalk(oidArubaCXPSUMaxPower, func(pdu gosnmp.SnmpPDU) error {
		if idx := trailingIndex(pdu.Name, oidArubaCXPSUMaxPower); idx != "" {
			ensurePSU(idx).maxPower = pduInt(pdu)
		}
		return nil
	})

	// Fan table
	_ = g.BulkWalk(oidArubaCXFanName, func(pdu gosnmp.SnmpPDU) error {
		if idx := trailingIndex(pdu.Name, oidArubaCXFanName); idx != "" {
			ensureFan(idx).name = pduString(pdu)
		}
		return nil
	})
	_ = g.BulkWalk(oidArubaCXFanState, func(pdu gosnmp.SnmpPDU) error {
		if idx := trailingIndex(pdu.Name, oidArubaCXFanState); idx != "" {
			ensureFan(idx).state = pduInt(pdu)
		}
		return nil
	})
	_ = g.BulkWalk(oidArubaCXFanRPM, func(pdu gosnmp.SnmpPDU) error {
		if idx := trailingIndex(pdu.Name, oidArubaCXFanRPM); idx != "" {
			ensureFan(idx).rpm = pduInt(pdu)
		}
		return nil
	})
	_ = g.BulkWalk(oidArubaCXFanSpeedPct, func(pdu gosnmp.SnmpPDU) error {
		if idx := trailingIndex(pdu.Name, oidArubaCXFanSpeedPct); idx != "" {
			ensureFan(idx).speedPct = pduInt(pdu)
		}
		return nil
	})

	var lines []string
	for idx, r := range psus {
		name := r.name
		if name == "" {
			name = "psu" + idx
		}
		labels := fmt.Sprintf(`%s,psu_name=%q`, did, name)
		ok := 0
		if r.status == 1 { ok = 1 }
		lines = append(lines,
			fmt.Sprintf(`anthrimon_cx_psu_ok{%s} %d %d`, labels, ok, ts),
		)
		if r.inputPower > 0 {
			lines = append(lines, fmt.Sprintf(`anthrimon_cx_psu_power_watts{%s} %d %d`, labels, r.inputPower, ts))
		}
		if r.maxPower > 0 {
			lines = append(lines, fmt.Sprintf(`anthrimon_cx_psu_max_watts{%s} %d %d`, labels, r.maxPower, ts))
		}
	}
	for idx, r := range fans {
		name := r.name
		if name == "" {
			name = "fan" + idx
		}
		labels := fmt.Sprintf(`%s,fan_name=%q`, did, name)
		ok := 0
		if r.state == 1 { ok = 1 }
		lines = append(lines,
			fmt.Sprintf(`anthrimon_cx_fan_ok{%s} %d %d`, labels, ok, ts),
		)
		if r.rpm > 0 {
			lines = append(lines, fmt.Sprintf(`anthrimon_cx_fan_rpm{%s} %d %d`, labels, r.rpm, ts))
		}
		if r.speedPct > 0 {
			lines = append(lines, fmt.Sprintf(`anthrimon_cx_fan_speed_pct{%s} %d %d`, labels, r.speedPct, ts))
		}
	}
	return lines
}

// pollArubaCXVSX reads ARUBAWIRED-VSX-MIB scalars.
//
// Emits:
//
//	anthrimon_cx_vsx_enabled{device_id}                    — 1 if VSX is enabled
//	anthrimon_cx_vsx_oper_state{device_id, state}          — 1 (one active series)
//	anthrimon_cx_vsx_isl_up{device_id}                     — 1 if ISL is up
//	anthrimon_cx_vsx_config_syncing{device_id}             — 1 if config sync in progress
func pollArubaCXVSX(g *gosnmp.GoSNMP, dev hub.Device, ts int64) []string {
	result, err := g.Get([]string{
		oidArubaCXVSXEnabled, oidArubaCXVSXOperState, oidArubaCXVSXRole,
		oidArubaCXVSXConfigSyncing, oidArubaCXVSXISLState,
	})
	if err != nil || len(result.Variables) < 5 {
		return nil
	}

	enabled := pduInt(result.Variables[0])
	if enabled != 1 {
		return nil // VSX not enabled on this device
	}

	operState := pduInt(result.Variables[1])
	role       := pduInt(result.Variables[2])
	syncing    := pduInt(result.Variables[3])
	islState   := pduInt(result.Variables[4])

	did := fmt.Sprintf(`device_id=%q`, dev.ID)

	stateNames := map[int]string{1: "in-sync", 2: "out-of-sync", 3: "standalone", 4: "not-active"}
	roleNames  := map[int]string{1: "primary", 2: "secondary", 3: "undefined"}

	stateName := stateNames[operState]
	if stateName == "" { stateName = "unknown" }
	roleName := roleNames[role]
	if roleName == "" { roleName = "undefined" }

	islUp := 0
	if islState == 1 { islUp = 1 }
	configSyncing := 0
	if syncing == 1 { configSyncing = 1 }

	return []string{
		fmt.Sprintf(`anthrimon_cx_vsx_enabled{%s} 1 %d`, did, ts),
		fmt.Sprintf(`anthrimon_cx_vsx_oper_state{%s,state=%q,role=%q} 1 %d`, did, stateName, roleName, ts),
		fmt.Sprintf(`anthrimon_cx_vsx_isl_up{%s} %d %d`, did, islUp, ts),
		fmt.Sprintf(`anthrimon_cx_vsx_config_syncing{%s} %d %d`, did, configSyncing, ts),
	}
}

// pollArubaCXCoPP walks the ARUBAWIRED-COPP-MIB to collect control-plane drop counters.
//
// Emits (only classes with non-zero drops):
//
//	anthrimon_cx_copp_drop_pkts_total{device_id, class}
//	anthrimon_cx_copp_drop_bytes_total{device_id, class}
func pollArubaCXCoPP(g *gosnmp.GoSNMP, dev hub.Device, ts int64) []string {
	did := fmt.Sprintf(`device_id=%q`, dev.ID)

	classNames  := make(map[string]string)
	dropPkts    := make(map[string]uint64)
	dropBytes   := make(map[string]uint64)

	_ = g.BulkWalk(oidArubaCXCoPPClass, func(pdu gosnmp.SnmpPDU) error {
		if idx := trailingIndex(pdu.Name, oidArubaCXCoPPClass); idx != "" {
			classNames[idx] = pduString(pdu)
		}
		return nil
	})
	_ = g.BulkWalk(oidArubaCXCoPPDropPkts, func(pdu gosnmp.SnmpPDU) error {
		if idx := trailingIndex(pdu.Name, oidArubaCXCoPPDropPkts); idx != "" {
			dropPkts[idx] = pduUint64(pdu)
		}
		return nil
	})
	_ = g.BulkWalk(oidArubaCXCoPPDropBytes, func(pdu gosnmp.SnmpPDU) error {
		if idx := trailingIndex(pdu.Name, oidArubaCXCoPPDropBytes); idx != "" {
			dropBytes[idx] = pduUint64(pdu)
		}
		return nil
	})

	var lines []string
	for idx, pkts := range dropPkts {
		if pkts == 0 {
			continue
		}
		class := classNames[idx]
		if class == "" {
			class = "class" + idx
		}
		labels := fmt.Sprintf(`%s,class=%q`, did, class)
		lines = append(lines,
			fmt.Sprintf(`anthrimon_cx_copp_drop_pkts_total{%s} %d %d`, labels, pkts, ts),
		)
		if b := dropBytes[idx]; b > 0 {
			lines = append(lines, fmt.Sprintf(`anthrimon_cx_copp_drop_bytes_total{%s} %d %d`, labels, b, ts))
		}
	}
	return lines
}

// pollArubaCXLoopProtect walks the ARUBAWIRED-LOOP-PROTECT-MIB.
// Only emits metrics for ports where a loop has been detected (value = 1).
//
// Emits:
//
//	anthrimon_cx_loop_protect_detected{device_id, if_name} — 1 if loop detected on port
func pollArubaCXLoopProtect(g *gosnmp.GoSNMP, dev hub.Device, ts int64) []string {
	ifNames := resolveIfNames(g)
	did := fmt.Sprintf(`device_id=%q`, dev.ID)

	var lines []string
	_ = g.BulkWalk(oidArubaCXLoopProtectDetected, func(pdu gosnmp.SnmpPDU) error {
		if pduInt(pdu) != 1 {
			return nil // not detected
		}
		idx := trailingIndex(pdu.Name, oidArubaCXLoopProtectDetected)
		ifName := ifNames[idx]
		if ifName == "" {
			ifName = "if" + idx
		}
		lines = append(lines,
			fmt.Sprintf(`anthrimon_cx_loop_protect_detected{%s,if_name=%q} 1 %d`, did, ifName, ts),
		)
		return nil
	})
	return lines
}

// oidSuffix returns the OID components after baseOID as a dot-separated string,
// or "" if pduName doesn't start with baseOID.
func oidSuffix(pduName, baseOID string) string {
	full := strings.TrimPrefix(pduName, ".")
	base := strings.TrimPrefix(baseOID, ".")
	if !strings.HasPrefix(full, base+".") {
		return ""
	}
	return full[len(base)+1:]
}

// decodeOctetStrings parses a dot-notation OID suffix that encodes one or more
// length-prefixed OctetString index components (standard SNMP IMPLIED OctetString
// indexing: <len>.<byte0>.<byte1>...<byteN> per string).
// Returns nil if the suffix is empty or malformed.
func decodeOctetStrings(suffix string) []string {
	if suffix == "" {
		return nil
	}
	parts := strings.Split(suffix, ".")
	var result []string
	i := 0
	for i < len(parts) {
		if parts[i] == "" {
			i++
			continue
		}
		n, err := strconv.Atoi(parts[i])
		if err != nil || n < 0 {
			return nil
		}
		i++
		if i+n > len(parts) {
			return nil
		}
		var sb strings.Builder
		for j := 0; j < n; j++ {
			b, err := strconv.Atoi(parts[i+j])
			if err != nil || b < 0 || b > 255 {
				return nil
			}
			sb.WriteByte(byte(b))
		}
		result = append(result, sb.String())
		i += n
	}
	return result
}

// ─── ENTITY-SENSOR-MIB helpers ───────────────────────────────────────────────

// collectEntitySensorMIB walks the ENTITY-SENSOR-MIB tables and ENTITY-MIB
// name/description tables, returning maps keyed by sensor index.
func collectEntitySensorMIB(g *gosnmp.GoSNMP, log zerolog.Logger) (
	typeByIdx map[string]int,
	scaleByIdx map[string]int,
	precByIdx map[string]int,
	valByIdx map[string]int,
	nameByIdx map[string]string,
) {
	typeByIdx  = make(map[string]int)
	scaleByIdx = make(map[string]int)
	precByIdx  = make(map[string]int)
	valByIdx   = make(map[string]int)
	nameByIdx  = make(map[string]string)

	// Sensor type — collect all, filter later.  If empty the device has no
	// entity sensors; skip the remaining five walks entirely.
	_ = g.BulkWalk(oidEntPhySensorType, func(pdu gosnmp.SnmpPDU) error {
		if idx := trailingIndex(pdu.Name, oidEntPhySensorType); idx != "" {
			typeByIdx[idx] = pduInt(pdu)
		}
		return nil
	})
	if len(typeByIdx) == 0 {
		return
	}

	// Narrow walks to sensor type we care about.
	_ = g.BulkWalk(oidEntPhySensorScale, func(pdu gosnmp.SnmpPDU) error {
		if idx := trailingIndex(pdu.Name, oidEntPhySensorScale); idx != "" {
			scaleByIdx[idx] = pduInt(pdu)
		}
		return nil
	})
	_ = g.BulkWalk(oidEntPhySensorPrecision, func(pdu gosnmp.SnmpPDU) error {
		if idx := trailingIndex(pdu.Name, oidEntPhySensorPrecision); idx != "" {
			precByIdx[idx] = pduInt(pdu)
		}
		return nil
	})
	_ = g.BulkWalk(oidEntPhySensorValue, func(pdu gosnmp.SnmpPDU) error {
		if idx := trailingIndex(pdu.Name, oidEntPhySensorValue); idx != "" {
			valByIdx[idx] = pduInt(pdu)
		}
		return nil
	})

	// Resolve physical names — try entPhysicalName first (often blank on Arista),
	// fall back to entPhysicalDescr (populated on Arista EOS).
	_ = g.BulkWalk(oidEntPhysicalName, func(pdu gosnmp.SnmpPDU) error {
		if v := pduString(pdu); v != "" {
			if idx := trailingIndex(pdu.Name, oidEntPhysicalName); idx != "" {
				nameByIdx[idx] = v
			}
		}
		return nil
	})
	_ = g.BulkWalk(oidEntPhysicalDescr, func(pdu gosnmp.SnmpPDU) error {
		idx := trailingIndex(pdu.Name, oidEntPhysicalDescr)
		if idx == "" {
			return nil
		}
		if _, already := nameByIdx[idx]; !already {
			if v := pduString(pdu); v != "" {
				nameByIdx[idx] = v
			}
		}
		return nil
	})

	return
}

// extractIfaceName extracts the interface name from a sensor description.
//
// Handles two patterns:
//   - "... for <iface>" (Arista EOS): "DOM TX Power Sensor for Ethernet2" → "Ethernet2"
//   - "<iface> <keyword> ..." (Cisco IOS-XE/XR, Aruba CX, Arista alt):
//     "GigabitEthernet0/0/1 Tx Power Sensor" → "GigabitEthernet0/0/1"
//     "Ethernet15/1 DOM TX Power"            → "Ethernet15/1"
func extractIfaceName(sensorName string) string {
	lower := strings.ToLower(sensorName)

	// Pattern 1: "... for <iface>"
	const sep = " for "
	if idx := strings.LastIndex(lower, sep); idx >= 0 {
		iface := strings.TrimSpace(sensorName[idx+len(sep):])
		return strings.TrimRightFunc(iface, func(r rune) bool {
			return !unicode.IsPrint(r) || r > 127
		})
	}

	// Pattern 2: "<iface> <optical-keyword> ..."
	for _, kw := range []string{" tx power", " rx power", " tx-power", " rx-power",
		" txpower", " rxpower", " dom", " transceiver", " optical", " laser"} {
		if i := strings.Index(lower, kw); i > 0 {
			return strings.TrimSpace(sensorName[:i])
		}
	}

	return sensorName
}

// isOpticalTX returns true when the sensor name indicates a TX direction.
func isOpticalTX(lower string) bool {
	return strings.Contains(lower, "tx") || strings.Contains(lower, "transmit")
}

// ─── SNMP client helpers ──────────────────────────────────────────────────────

func getSysUpTime(g *gosnmp.GoSNMP) (uint32, error) {
	result, err := g.Get([]string{oidSysUpTime})
	if err != nil || result == nil || len(result.Variables) == 0 {
		return 0, fmt.Errorf("get sysUpTime: %w", err)
	}
	v := result.Variables[0]
	if v.Type == gosnmp.TimeTicks {
		return v.Value.(uint32), nil
	}
	return 0, fmt.Errorf("unexpected type for sysUpTime: %v", v.Type)
}

// ─── Credential + SNMP client builders ───────────────────────────────────────

func normSNMPType(t string) string {
	return strings.ReplaceAll(strings.ToLower(t), "_", "")
}

func pickSNMPCredential(creds []hub.Credential) *hub.Credential {
	var best *hub.Credential
	for i := range creds {
		c := &creds[i]
		t := normSNMPType(c.Type)
		if t != "snmpv2" && t != "snmpv2c" && t != "snmpv3" {
			continue
		}
		if best == nil || c.Priority < best.Priority {
			best = c
		}
	}
	return best
}

// credStr extracts a string field from credential data, logging a warning if
// the value exists but has the wrong type.
func credStr(data map[string]interface{}, field string) string {
	v, ok := data[field]
	if !ok || v == nil {
		return ""
	}
	s, ok := v.(string)
	if !ok {
		fmt.Fprintf(os.Stderr, "WARN credential field %q: expected string, got %T\n", field, v)
		return ""
	}
	return s
}

func buildSNMPClient(dev hub.Device, cred *hub.Credential, cfg config.SNMPConfig) (*gosnmp.GoSNMP, error) {
	port := 161
	if dev.SNMPPort > 0 {
		port = dev.SNMPPort
	}

	g := &gosnmp.GoSNMP{
		Target:  dev.MgmtIP,
		Port:    uint16(port),
		Timeout: time.Duration(cfg.TimeoutSeconds) * time.Second,
		Retries: cfg.Retries,
		MaxOids: 60,
	}

	switch normSNMPType(cred.Type) {
	case "snmpv3":
		g.Version = gosnmp.Version3
		username  := credStr(cred.Data, "username")
		authProto := credStr(cred.Data, "auth_protocol")
		authPass  := credStr(cred.Data, "auth_key")
		privProto := credStr(cred.Data, "priv_protocol")
		privPass  := credStr(cred.Data, "priv_key")

		msgFlags := gosnmp.NoAuthNoPriv
		if authPass != "" {
			msgFlags = gosnmp.AuthNoPriv
		}
		if privPass != "" {
			msgFlags = gosnmp.AuthPriv
		}

		ap := gosnmp.NoAuth
		switch strings.ToUpper(authProto) {
		case "MD5":    ap = gosnmp.MD5
		case "SHA":    ap = gosnmp.SHA
		case "SHA224": ap = gosnmp.SHA224
		case "SHA256": ap = gosnmp.SHA256
		case "SHA384": ap = gosnmp.SHA384
		case "SHA512": ap = gosnmp.SHA512
		}

		pp := gosnmp.NoPriv
		switch strings.ToUpper(privProto) {
		case "DES":    pp = gosnmp.DES
		case "AES":    pp = gosnmp.AES
		case "AES192": pp = gosnmp.AES192
		case "AES256": pp = gosnmp.AES256
		}

		g.SecurityModel = gosnmp.UserSecurityModel
		g.MsgFlags      = msgFlags
		g.SecurityParameters = &gosnmp.UsmSecurityParameters{
			UserName:                 username,
			AuthenticationProtocol:  ap,
			AuthenticationPassphrase: authPass,
			PrivacyProtocol:         pp,
			PrivacyPassphrase:       privPass,
		}
	default: // snmpv2c
		g.Version = gosnmp.Version2c
		community, _ := cred.Data["community"].(string)
		if community == "" {
			community = "public"
		}
		g.Community = community
	}

	return g, nil
}

// ─── PDU value helpers ────────────────────────────────────────────────────────

func pduString(pdu gosnmp.SnmpPDU) string {
	switch v := pdu.Value.(type) {
	case string:
		return v
	case []byte:
		return string(v)
	}
	return ""
}

func pduInt(pdu gosnmp.SnmpPDU) int {
	return int(pduUint64(pdu))
}

func pduUint64(pdu gosnmp.SnmpPDU) uint64 {
	switch v := pdu.Value.(type) {
	case int:    return uint64(v)
	case int32:  return uint64(v)
	case int64:  return uint64(v)
	case uint:   return uint64(v)
	case uint32: return uint64(v)
	case uint64: return v
	}
	return 0
}

// ─── OID index helpers ────────────────────────────────────────────────────────

// splitColIdx parses a table PDU name into (column, rowIndex).
// For a table OID like "1.3.6.1.2.1.2.2.1", PDU names have the form
// "<tableOID>.<col>.<idx>".  Returns (-1, -1) if the PDU is not under the table.
func splitColIdx(pduName, tableOID string) (col, idx int) {
	full := strings.TrimPrefix(pduName, ".")
	base := strings.TrimPrefix(tableOID, ".")
	if !strings.HasPrefix(full, base+".") {
		return -1, -1
	}
	tail := full[len(base)+1:]
	dot := strings.Index(tail, ".")
	if dot < 0 {
		return -1, -1
	}
	if _, err := fmt.Sscanf(tail[:dot], "%d", &col); err != nil {
		return -1, -1
	}
	rest := tail[dot+1:]
	// Accept only simple single-component row indexes.
	if strings.Contains(rest, ".") {
		return col, -1
	}
	if _, err := fmt.Sscanf(rest, "%d", &idx); err != nil {
		return col, -1
	}
	return col, idx
}

// trailingIndex returns the single trailing integer component of pduName after
// stripping baseOID.  Returns "" if the name doesn't match or the tail is not
// a simple integer.  Used for ENTITY-MIB and ENTITY-SENSOR-MIB where the row
// index is a single physical entity index.
func trailingIndex(pduName, baseOID string) string {
	full := strings.TrimPrefix(pduName, ".")
	base := strings.TrimPrefix(baseOID, ".")
	if !strings.HasPrefix(full, base+".") {
		return ""
	}
	tail := full[len(base)+1:]
	if strings.Contains(tail, ".") {
		return "" // multi-component index — not a simple entity index
	}
	return tail
}

// escapeLabelValue escapes backslashes and double-quotes in a Prometheus label value.
func escapeLabelValue(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `"`, `\"`)
	return s
}

// ─── Live interface sampling ──────────────────────────────────────────────────

// LiveSample is a raw SNMP counter snapshot for one interface at one instant.
type LiveSample struct {
	TS          int64  `json:"ts"`           // Unix milliseconds
	InOctets    uint64 `json:"in_octets"`
	OutOctets   uint64 `json:"out_octets"`
	InErrors    uint64 `json:"in_errors"`
	OutErrors   uint64 `json:"out_errors"`
	InPkts      uint64 `json:"in_pkts"`
	OutPkts     uint64 `json:"out_pkts"`
	InDiscards  uint64 `json:"in_discards"`
	OutDiscards uint64 `json:"out_discards"`
}

// LiveInterface streams raw SNMP counter snapshots for one interface every 3 s.
// The returned channel is closed when ctx is cancelled, max samples (100) are
// reached, or an SNMP error occurs.  Callers compute rates from successive samples.
func (c *SNMPCollector) LiveInterface(ctx context.Context, deviceID string, ifIndex int) (<-chan LiveSample, error) {
	c.mu.RLock()
	var found hub.Device
	var ok bool
	for _, d := range c.devices {
		if d.ID == deviceID {
			found = d
			ok = true
			break
		}
	}
	c.mu.RUnlock()

	if !ok {
		return nil, fmt.Errorf("device %s not known to snmp collector", deviceID)
	}

	cred := pickSNMPCredential(found.Credentials)
	if cred == nil {
		return nil, fmt.Errorf("no usable snmp credential for device %s", deviceID)
	}

	g, err := buildSNMPClient(found, cred, c.cfg)
	if err != nil {
		return nil, fmt.Errorf("build snmp client: %w", err)
	}
	if err := g.Connect(); err != nil {
		return nil, fmt.Errorf("snmp connect %s: %w", found.MgmtIP, err)
	}

	oids := []string{
		fmt.Sprintf("1.3.6.1.2.1.31.1.1.1.6.%d", ifIndex),  // ifHCInOctets
		fmt.Sprintf("1.3.6.1.2.1.31.1.1.1.10.%d", ifIndex), // ifHCOutOctets
		fmt.Sprintf("1.3.6.1.2.1.2.2.1.14.%d", ifIndex),    // ifInErrors
		fmt.Sprintf("1.3.6.1.2.1.2.2.1.20.%d", ifIndex),    // ifOutErrors
		fmt.Sprintf("1.3.6.1.2.1.31.1.1.1.7.%d", ifIndex),  // ifHCInUcastPkts
		fmt.Sprintf("1.3.6.1.2.1.31.1.1.1.11.%d", ifIndex), // ifHCOutUcastPkts
		fmt.Sprintf("1.3.6.1.2.1.2.2.1.13.%d", ifIndex),    // ifInDiscards
		fmt.Sprintf("1.3.6.1.2.1.2.2.1.19.%d", ifIndex),    // ifOutDiscards
	}

	ch := make(chan LiveSample, 1)

	go func() {
		defer close(ch)
		defer g.Conn.Close()

		poll := func() (LiveSample, bool) {
			result, err := g.Get(oids)
			if err != nil || result == nil {
				return LiveSample{}, false
			}
			s := LiveSample{TS: time.Now().UnixMilli()}
			for i, v := range result.Variables {
				val := pduUint64(v)
				switch i {
				case 0: s.InOctets = val
				case 1: s.OutOctets = val
				case 2: s.InErrors = val
				case 3: s.OutErrors = val
				case 4: s.InPkts = val
				case 5: s.OutPkts = val
				case 6: s.InDiscards = val
				case 7: s.OutDiscards = val
				}
			}
			return s, true
		}

		send := func(s LiveSample) bool {
			select {
			case <-ctx.Done():
				return false
			case ch <- s:
				return true
			}
		}

		// First sample immediately.
		if s, ok := poll(); ok {
			if !send(s) {
				return
			}
		} else {
			return
		}

		ticker := time.NewTicker(3 * time.Second)
		defer ticker.Stop()

		for i := 1; i < 100; i++ {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
			s, ok := poll()
			if !ok {
				return
			}
			if !send(s) {
				return
			}
		}
	}()

	return ch, nil
}
