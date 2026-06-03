// Package collector contains the SNMP, flow, and syslog collectors that run
// inside the remote-collector process.
package collector

import (
	"context"
	"fmt"
	"math"
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

	// RFC 3433 SensorDataScale: actual = value * 10^((scale-9)*3) / 10^precision
	entSensorTypeCelsius = 8
	entSensorTypeWatts   = 6
	entSensorScaleUnits  = 9 // units(9) → 10^0
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

	lines, err := c.pollDevice(*dev)
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

			devLines, err := c.pollDevice(dev)

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

// pollDevice connects to one device and returns Prometheus-format metric lines.
func (c *SNMPCollector) pollDevice(dev hub.Device) ([]string, error) {
	cred := pickSNMPCredential(dev.Credentials)
	if cred == nil {
		return nil, fmt.Errorf("no usable snmp credential for %s", dev.ID)
	}

	g, err := buildSNMPClient(dev, cred, c.cfg)
	if err != nil {
		return nil, fmt.Errorf("build snmp client: %w", err)
	}
	if err := g.Connect(); err != nil {
		return nil, fmt.Errorf("snmp connect %s: %w", dev.MgmtIP, err)
	}
	defer g.Conn.Close()

	ts := time.Now().UnixMilli()

	var lines []string

	// sysUpTime
	uptime, err := getSysUpTime(g)
	if err == nil {
		// Match the hub's metric name and label set exactly.
		lines = append(lines,
			fmt.Sprintf(`anthrimon_device_uptime_seconds{device_id=%q} %d %d`,
				dev.ID, uptime/100, ts))
	}

	// sysName + sysDescr + sysObjectID — emitted once per cycle so the hub
	// can backfill hostname, vendor, and device_type for newly-added devices.
	sysInfoResult, sysErr := g.Get([]string{oidSysName, oidSysDescr, oidSysObjectID})
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
	lines = append(lines, buildOpticalPowerLines(dev, ts, typeByIdx, scaleByIdx, precByIdx, valByIdx, nameByIdx)...)

	return lines, nil
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

// buildOpticalPowerLines extracts watts-type DOM sensor readings from pre-collected
// ENTITY-SENSOR-MIB data, converts mW→dBm, and returns TX/RX optical power lines.
func buildOpticalPowerLines(
	dev hub.Device, ts int64,
	typeByIdx map[string]int, scaleByIdx map[string]int, precByIdx map[string]int,
	valByIdx map[string]int, nameByIdx map[string]string,
) []string {
	var lines []string
	for idx, rawVal := range valByIdx {
		if typeByIdx[idx] != entSensorTypeWatts {
			continue
		}
		name := nameByIdx[idx]
		if name == "" {
			continue
		}

		lower := strings.ToLower(name)
		if !strings.Contains(lower, "dom") &&
			!strings.Contains(lower, "tx power") &&
			!strings.Contains(lower, "rx power") {
			continue
		}

		scaleEnum := scaleByIdx[idx]
		if scaleEnum == 0 {
			scaleEnum = entSensorScaleUnits
		}
		scaleExp  := (scaleEnum - entSensorScaleUnits) * 3
		precision := precByIdx[idx]

		watts := float64(rawVal) * math.Pow10(scaleExp) / math.Pow10(precision)
		mw    := watts * 1000.0
		var dbm float64
		if mw > 0 {
			dbm = 10.0 * math.Log10(mw)
		} else {
			dbm = -40.0 // clamp to -40 dBm for zero / negative readings
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

// extractIfaceName extracts the interface name from sensor descriptions of the
// form "... for <IfaceName>" (Arista EOS convention).
// Falls back to the full sensor name if the pattern is not found.
func extractIfaceName(sensorName string) string {
	const sep = " for "
	idx := strings.LastIndex(strings.ToLower(sensorName), sep)
	if idx < 0 {
		return sensorName
	}
	iface := strings.TrimSpace(sensorName[idx+len(sep):])
	return strings.TrimRightFunc(iface, func(r rune) bool {
		return !unicode.IsPrint(r) || r > 127
	})
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
		username,  _ := cred.Data["username"].(string)
		authProto, _ := cred.Data["auth_protocol"].(string)
		authPass,  _ := cred.Data["auth_key"].(string)
		privProto, _ := cred.Data["priv_protocol"].(string)
		privPass,  _ := cred.Data["priv_key"].(string)

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
