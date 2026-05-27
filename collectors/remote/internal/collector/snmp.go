// Package collector contains the SNMP, flow, and syslog collectors that run
// inside the remote-collector process.
package collector

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/gosnmp/gosnmp"
	"github.com/rs/zerolog"

	"github.com/purpledurpl075/anthri-mon/collectors/remote/internal/config"
	"github.com/purpledurpl075/anthri-mon/collectors/remote/internal/hub"
)

// ─── OID constants ────────────────────────────────────────────────────────────

const (
	oidSysUpTime      = "1.3.6.1.2.1.1.3.0"
	oidIfTable        = "1.3.6.1.2.1.2.2.1"
	oidIfDescr        = "1.3.6.1.2.1.2.2.1.2"
	oidIfOperStatus   = "1.3.6.1.2.1.2.2.1.8"
	oidIfInOctets     = "1.3.6.1.2.1.2.2.1.10"
	oidIfOutOctets    = "1.3.6.1.2.1.2.2.1.16"
	oidHrProcessorLoad = "1.3.6.1.2.1.25.3.3.1.2"
	oidHrStorageTable  = "1.3.6.1.2.1.25.2.3.1"
	oidHrStorageUsed   = "1.3.6.1.2.1.25.2.3.1.6"
	oidHrStorageSize   = "1.3.6.1.2.1.25.2.3.1.5"
	oidHrStorageType   = "1.3.6.1.2.1.25.2.3.1.2"
	oidHrStorageTypeRAM = "1.3.6.1.2.1.25.2.1.2"
)

// SNMPCollector polls assigned devices via SNMP and forwards Prometheus text
// metrics to the hub.
type SNMPCollector struct {
	hub     *hub.Client
	cfg     config.SNMPConfig
	log     zerolog.Logger

	mu      sync.RWMutex
	devices []hub.Device
}

// NewSNMPCollector creates a new SNMPCollector.
func NewSNMPCollector(hubClient *hub.Client, cfg config.SNMPConfig, log zerolog.Logger) *SNMPCollector {
	return &SNMPCollector{
		hub: hubClient,
		cfg: cfg,
		log: log.With().Str("component", "snmp_collector").Logger(),
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
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	c.log.Info().Dur("interval", interval).Msg("snmp poller started")

	// Poll once immediately then follow the ticker.
	c.pollAll(ctx)

	for {
		select {
		case <-ctx.Done():
			c.log.Info().Msg("snmp poller stopped")
			return
		case <-ticker.C:
			c.pollAll(ctx)
		}
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

	for _, dev := range devices {
		dev := dev
		wg.Add(1)
		sem <- struct{}{}

		go func() {
			defer wg.Done()
			defer func() { <-sem }()

			devLines, err := c.pollDevice(ctx, dev)
			if err != nil {
				c.log.Warn().Err(err).Str("device_id", dev.ID).
					Str("ip", dev.MgmtIP).Msg("snmp poll failed")
				return
			}

			mu.Lock()
			lines = append(lines, devLines...)
			mu.Unlock()
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
func (c *SNMPCollector) pollDevice(ctx context.Context, dev hub.Device) ([]string, error) {
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
		lines = append(lines,
			fmt.Sprintf(`anthrimon_uptime_seconds{device_id=%q,hostname=%q,vendor=%q} %d %d`,
				dev.ID, dev.Hostname, dev.Vendor, uptime/100, ts))
	}

	// Interface counters + oper status
	ifLines, err := pollInterfaces(g, dev, ts, c.log)
	if err == nil {
		lines = append(lines, ifLines...)
	}

	// CPU via hrProcessorLoad
	cpuLines, err := pollCPU(g, dev, ts)
	if err == nil {
		lines = append(lines, cpuLines...)
	}

	// Memory via hrStorageTable
	memLines, err := pollMemory(g, dev, ts)
	if err == nil {
		lines = append(lines, memLines...)
	}

	return lines, nil
}

// ─── SNMP helpers ─────────────────────────────────────────────────────────────

func getSysUpTime(g *gosnmp.GoSNMP) (uint32, error) {
	result, err := g.Get([]string{oidSysUpTime})
	if err != nil || len(result.Variables) == 0 {
		return 0, fmt.Errorf("get sysUpTime: %w", err)
	}
	v := result.Variables[0]
	switch v.Type {
	case gosnmp.TimeTicks:
		return v.Value.(uint32), nil
	default:
		return 0, fmt.Errorf("unexpected type for sysUpTime: %v", v.Type)
	}
}

func pollInterfaces(g *gosnmp.GoSNMP, dev hub.Device, ts int64, log zerolog.Logger) ([]string, error) {
	// Walk ifDescr, ifOperStatus, ifInOctets, ifOutOctets.
	type ifData struct {
		descr      string
		operStatus int
		inOctets   uint64
		outOctets  uint64
	}
	rows := make(map[int]*ifData)
	ensure := func(idx int) *ifData {
		if r, ok := rows[idx]; ok {
			return r
		}
		r := &ifData{}
		rows[idx] = r
		return r
	}

	walkAndApply := func(oidBase string, apply func(idx int, pdu gosnmp.SnmpPDU)) error {
		return g.BulkWalk(oidBase, func(pdu gosnmp.SnmpPDU) error {
			idx := trailingIndex(pdu.Name, oidBase)
			if idx >= 0 {
				apply(idx, pdu)
			}
			return nil
		})
	}

	// Non-critical walks: log on failure but continue — interface names and
	// oper-status are useful but missing them doesn't corrupt counter data.
	if err := walkAndApply(oidIfDescr, func(idx int, pdu gosnmp.SnmpPDU) {
		ensure(idx).descr = pduString(pdu)
	}); err != nil {
		log.Warn().Err(err).Str("device", dev.Hostname).Msg("ifDescr walk failed")
	}
	if err := walkAndApply(oidIfOperStatus, func(idx int, pdu gosnmp.SnmpPDU) {
		ensure(idx).operStatus = pduInt(pdu)
	}); err != nil {
		log.Warn().Err(err).Str("device", dev.Hostname).Msg("ifOperStatus walk failed")
	}

	// Critical counter walks: return error on failure so the caller skips
	// metric emission entirely — emitting zeros would look like traffic stopped
	// and can trigger false bandwidth alerts.
	if err := walkAndApply(oidIfInOctets, func(idx int, pdu gosnmp.SnmpPDU) {
		ensure(idx).inOctets = pduUint64(pdu)
	}); err != nil {
		return nil, fmt.Errorf("ifInOctets walk: %w", err)
	}
	if err := walkAndApply(oidIfOutOctets, func(idx int, pdu gosnmp.SnmpPDU) {
		ensure(idx).outOctets = pduUint64(pdu)
	}); err != nil {
		return nil, fmt.Errorf("ifOutOctets walk: %w", err)
	}

	var lines []string
	for ifIdx, r := range rows {
		name := r.descr
		if name == "" {
			name = fmt.Sprintf("if%d", ifIdx)
		}
		labels := fmt.Sprintf(`device_id=%q,if_index="%d",if_name=%q,vendor=%q`,
			dev.ID, ifIdx, name, dev.Vendor)
		lines = append(lines,
			fmt.Sprintf("anthrimon_if_in_octets_total{%s} %d %d", labels, r.inOctets, ts),
			fmt.Sprintf("anthrimon_if_out_octets_total{%s} %d %d", labels, r.outOctets, ts),
			fmt.Sprintf("anthrimon_if_oper_status{%s} %d %d", labels, r.operStatus, ts),
		)
	}
	return lines, nil
}

func pollCPU(g *gosnmp.GoSNMP, dev hub.Device, ts int64) ([]string, error) {
	var lines []string
	idx := 0
	err := g.BulkWalk(oidHrProcessorLoad, func(pdu gosnmp.SnmpPDU) error {
		load := pduUint64(pdu)
		lines = append(lines,
			fmt.Sprintf(`anthrimon_cpu_load_pct{device_id=%q,cpu_index="%d",vendor=%q} %d %d`,
				dev.ID, idx, dev.Vendor, load, ts))
		idx++
		return nil
	})
	return lines, err
}

func pollMemory(g *gosnmp.GoSNMP, dev hub.Device, ts int64) ([]string, error) {
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

	_ = g.BulkWalk(oidHrStorageType, func(pdu gosnmp.SnmpPDU) error {
		idx := trailingIndex(pdu.Name, oidHrStorageType)
		if idx >= 0 {
			ensure(idx).storageType = pduString(pdu)
		}
		return nil
	})

	_ = g.BulkWalk("1.3.6.1.2.1.25.2.3.1.4", func(pdu gosnmp.SnmpPDU) error {
		idx := trailingIndex(pdu.Name, "1.3.6.1.2.1.25.2.3.1.4")
		if idx >= 0 {
			ensure(idx).allocUnits = pduUint64(pdu)
		}
		return nil
	})
	_ = g.BulkWalk(oidHrStorageSize, func(pdu gosnmp.SnmpPDU) error {
		idx := trailingIndex(pdu.Name, oidHrStorageSize)
		if idx >= 0 {
			ensure(idx).size = pduUint64(pdu)
		}
		return nil
	})
	_ = g.BulkWalk(oidHrStorageUsed, func(pdu gosnmp.SnmpPDU) error {
		idx := trailingIndex(pdu.Name, oidHrStorageUsed)
		if idx >= 0 {
			ensure(idx).used = pduUint64(pdu)
		}
		return nil
	})

	var lines []string
	for _, r := range rows {
		if !strings.HasSuffix(r.storageType, "2") { // .2 = hrStorageRam
			continue
		}
		if r.size == 0 {
			continue
		}
		totalBytes := r.size * r.allocUnits
		usedBytes := r.used * r.allocUnits
		ts2 := time.Now().UnixMilli()
		lines = append(lines,
			fmt.Sprintf(`anthrimon_memory_total_bytes{device_id=%q,vendor=%q} %d %d`,
				dev.ID, dev.Vendor, totalBytes, ts2),
			fmt.Sprintf(`anthrimon_memory_used_bytes{device_id=%q,vendor=%q} %d %d`,
				dev.ID, dev.Vendor, usedBytes, ts2),
		)
	}
	return lines, nil
}

// ─── Credential + SNMP client helpers ────────────────────────────────────────

// pickSNMPCredential returns the highest-priority SNMP credential (type "snmpv2"
// or "snmpv3") from the device's credential list, or nil if none.
// normSNMPType normalises credential type strings so that both "snmpv2c" and
// "snmp_v2c" (and similar) map to a canonical form for comparison.
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
		Target:    dev.MgmtIP,
		Port:      uint16(port),
		Timeout:   time.Duration(cfg.TimeoutSeconds) * time.Second,
		Retries:   cfg.Retries,
		MaxOids:   60,
	}

	switch normSNMPType(cred.Type) {
	case "snmpv3":
		g.Version = gosnmp.Version3
		username, _ := cred.Data["username"].(string)
		authProto, _ := cred.Data["auth_protocol"].(string)
		authPass, _ := cred.Data["auth_key"].(string)
		privProto, _ := cred.Data["priv_protocol"].(string)
		privPass, _ := cred.Data["priv_key"].(string)

		msgFlags := gosnmp.NoAuthNoPriv
		if authPass != "" {
			msgFlags = gosnmp.AuthNoPriv
		}
		if privPass != "" {
			msgFlags = gosnmp.AuthPriv
		}

		ap := gosnmp.NoAuth
		switch strings.ToUpper(authProto) {
		case "MD5":
			ap = gosnmp.MD5
		case "SHA":
			ap = gosnmp.SHA
		case "SHA224":
			ap = gosnmp.SHA224
		case "SHA256":
			ap = gosnmp.SHA256
		case "SHA384":
			ap = gosnmp.SHA384
		case "SHA512":
			ap = gosnmp.SHA512
		}

		pp := gosnmp.NoPriv
		switch strings.ToUpper(privProto) {
		case "DES":
			pp = gosnmp.DES
		case "AES":
			pp = gosnmp.AES
		case "AES192":
			pp = gosnmp.AES192
		case "AES256":
			pp = gosnmp.AES256
		}

		g.SecurityModel = gosnmp.UserSecurityModel
		g.MsgFlags = msgFlags
		g.SecurityParameters = &gosnmp.UsmSecurityParameters{
			UserName:                 username,
			AuthenticationProtocol:  ap,
			AuthenticationPassphrase: authPass,
			PrivacyProtocol:          pp,
			PrivacyPassphrase:        privPass,
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
	case int:
		return uint64(v)
	case int32:
		return uint64(v)
	case int64:
		return uint64(v)
	case uint:
		return uint64(v)
	case uint32:
		return uint64(v)
	case uint64:
		return v
	}
	return 0
}

// trailingIndex returns the integer at the end of pduName after oidBase.
// E.g. trailingIndex("1.3.6.1.2.1.2.2.1.2.5", "1.3.6.1.2.1.2.2.1.2") == 5.
// Returns -1 if the OID does not match or the trailing part is not a single integer.
func trailingIndex(pduName, oidBase string) int {
	full := strings.TrimPrefix(pduName, ".")
	base := strings.TrimPrefix(oidBase, ".")
	if !strings.HasPrefix(full, base+".") {
		return -1
	}
	tail := full[len(base)+1:]
	// Accept only simple single-component indexes.
	if strings.Contains(tail, ".") {
		return -1
	}
	var idx int
	_, err := fmt.Sscanf(tail, "%d", &idx)
	if err != nil {
		return -1
	}
	return idx
}
