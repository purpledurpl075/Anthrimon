package poller

import (
	"context"
	"fmt"
	"math/rand"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/client"
	"github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/config"
	"github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/crypto"
	"github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/model"
	"github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/vendor"
	"github.com/rs/zerolog"
)

// PollResult carries all results from one complete poll cycle for a device.
type PollResult struct {
	DeviceID          uuid.UUID
	SysInfo           *model.DeviceInfo // nil if not yet polled or failed
	Interfaces        []*model.InterfaceResult
	StateOnly         bool                         // true = Interfaces contains state fields only (no counters); use upsertInterfaceState
	Health            *model.HealthResult          // nil if health poll not run this cycle
	LLDPNeighbors     []*model.LLDPNeighbor        // nil if not polled this cycle
	CDPNeighbors      []*model.CDPNeighbor         // nil if not polled this cycle
	OSPFNeighbours    []*model.OSPFNeighbour       // nil = poll didn't run/errored; non-nil (even empty) = polled successfully
	ISISAdjacencies   []*model.ISISAdjacency       // nil = poll didn't run/errored; non-nil (even empty) = polled successfully
	ISISAreas         []*model.ISISArea            // nil if not polled this cycle
	ISISCircuitLevels []*model.ISISCircuitLevel    // nil if not polled this cycle
	ISISLSPs          []*model.ISISLSP             // nil if not polled this cycle
	BGPSessions       []*model.BGPSession          // nil = poll didn't run/errored; non-nil (even empty) = polled successfully
	RouteEntries      []*model.RouteEntry          // nil = poll didn't run/errored; non-nil (even empty) = polled successfully
	ARPEntries        []*model.ARPEntry            // nil if not polled this cycle
	MACEntries        []*model.MACEntry            // nil if not polled this cycle
	VLANs             []*model.VLANResult          // nil if not polled this cycle
	InterfaceVLANs    []*model.InterfaceVLANResult // nil if not polled this cycle
	STPPorts          []*model.STPPortResult       // nil if not polled this cycle
	ProbeResult       *model.ProbeResult           // nil if probe not run or unavailable
}

// ResultHandler is a callback invoked after each completed poll cycle.
// The writer package implements this interface for PostgreSQL and VictoriaMetrics.
type ResultHandler interface {
	Handle(ctx context.Context, result *PollResult) error
}

// Manager owns the set of device goroutines and keeps them aligned with the
// device list in PostgreSQL. Devices are added and removed dynamically.
type Manager struct {
	cfg     *config.Config
	codec   *crypto.AESCodec // nil when running without credential encryption
	handler ResultHandler
	log     zerolog.Logger
	prober  *Prober

	mu      sync.Mutex
	running map[uuid.UUID]context.CancelFunc // device_id → cancel func
}

// NewManager creates a Manager. codec may be nil (plaintext credential mode).
func NewManager(cfg *config.Config, codec *crypto.AESCodec, handler ResultHandler, log zerolog.Logger) *Manager {
	return &Manager{
		cfg:     cfg,
		codec:   codec,
		handler: handler,
		log:     log.With().Str("component", "poller_manager").Logger(),
		prober:  NewProber(log),
		running: make(map[uuid.UUID]context.CancelFunc),
	}
}

// Run starts the device-refresh loop and blocks until ctx is cancelled.
// It is the caller's responsibility to provide a cancellable context.
func (m *Manager) Run(ctx context.Context, deviceSource DeviceSource) error {
	m.log.Info().Msg("poller manager starting")

	// Initial load.
	if err := m.sync(ctx, deviceSource); err != nil {
		m.log.Error().Err(err).Msg("initial device load failed")
	}

	refreshTicker := time.NewTicker(time.Duration(m.cfg.Polling.DeviceRefreshS) * time.Second)
	defer refreshTicker.Stop()

	for {
		select {
		case <-ctx.Done():
			m.log.Info().Msg("poller manager stopping")
			m.stopAll()
			return ctx.Err()
		case <-refreshTicker.C:
			if err := m.sync(ctx, deviceSource); err != nil {
				m.log.Error().Err(err).Msg("device list refresh failed")
			}
		}
	}
}

// sync reconciles the running goroutine set against the current device list.
func (m *Manager) sync(ctx context.Context, ds DeviceSource) error {
	devices, err := ds.LoadDevices(ctx)
	if err != nil {
		return fmt.Errorf("loading devices: %w", err)
	}

	m.log.Info().Int("count", len(devices)).Msg("device list refreshed")

	m.mu.Lock()
	defer m.mu.Unlock()

	// Start goroutines for new/unknown devices.
	for _, dev := range devices {
		if _, ok := m.running[dev.ID]; ok {
			continue // already running
		}
		if len(m.running) >= m.cfg.Polling.MaxConcurrentDevices {
			m.log.Warn().Int("limit", m.cfg.Polling.MaxConcurrentDevices).
				Msg("max concurrent devices reached; skipping remaining devices until next refresh")
			break
		}
		devCtx, cancel := context.WithCancel(ctx)
		m.running[dev.ID] = cancel
		go m.runDevice(devCtx, dev, m.prober)
	}

	// Stop goroutines for devices no longer in the list.
	activeIDs := make(map[uuid.UUID]bool, len(devices))
	for _, d := range devices {
		activeIDs[d.ID] = true
	}
	for id, cancel := range m.running {
		if !activeIDs[id] {
			m.log.Info().Str("device_id", id.String()).Msg("device removed; stopping poller goroutine")
			cancel()
			delete(m.running, id)
		}
	}

	return nil
}

// stopAll cancels every running device goroutine. Called on shutdown.
func (m *Manager) stopAll() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, cancel := range m.running {
		cancel()
	}
}

// ── Per-device goroutine ──────────────────────────────────────────────────────

// runDevice is the long-running goroutine for a single device.
// It manages the SNMP session lifecycle, schedules polls at the device's
// configured interval, and dispatches results to the handler.
func (m *Manager) runDevice(ctx context.Context, dev model.DeviceRow, prober *Prober) {
	log := m.log.With().
		Str("device_id", dev.ID.String()).
		Str("target", dev.MgmtIP).
		Logger()

	defer func() {
		// Remove from running map when goroutine exits naturally.
		m.mu.Lock()
		delete(m.running, dev.ID)
		m.mu.Unlock()
		log.Debug().Msg("device goroutine exited")
	}()

	// Decode credential.
	cred, err := m.decodeCred(dev)
	if err != nil {
		log.Error().Err(err).Msg("cannot decode credential; skipping device")
		return
	}

	timeout := time.Duration(m.cfg.SNMP.TimeoutSeconds) * time.Second
	counterInterval := time.Duration(dev.PollingIntervalS) * time.Second
	if counterInterval <= 0 {
		counterInterval = time.Duration(m.cfg.Polling.DefaultIntervalS) * time.Second
	}
	stateInterval := time.Duration(m.cfg.Polling.StateIntervalS) * time.Second
	if stateInterval <= 0 || stateInterval >= counterInterval {
		stateInterval = counterInterval / 4
	}
	healthInterval := time.Duration(m.cfg.Polling.HealthIntervalS) * time.Second
	if healthInterval <= 0 {
		healthInterval = counterInterval
	}

	backoff := client.NewBackoff(60)
	var session *client.Session
	var currentProfile *vendor.Profile
	var lastSysUpTime uint32
	ifByIndex := make(map[int]string) // shared between stateTicker and counterTicker

	// Stagger startup across the counter poll interval to avoid thundering herd on launch.
	stagger := time.Duration(rand.Int63n(int64(counterInterval)))
	if client.SleepOrCancel(ctx, stagger) {
		return
	}

	// stateTicker: fast-path for state-change detection (BGP/OSPF/ISIS/interface oper).
	stateTicker := time.NewTicker(stateInterval)
	// counterTicker: full interface + topology + route polls at the slower interval.
	counterTicker := time.NewTicker(counterInterval)
	// Offset health ticker by half a counter interval so it never fires at the
	// same instant as the counter ticker (avoids select starvation).
	healthTicker := time.NewTicker(healthInterval + counterInterval/2)
	// Probe ticker runs independently of SNMP — fires even when SNMP is broken.
	probeTicker := time.NewTicker(ProbeInterval)
	defer stateTicker.Stop()
	defer counterTicker.Stop()
	defer healthTicker.Stop()
	defer probeTicker.Stop()

	connectAndSysInfo := func() bool {
		for {
			sess, err := client.NewSession(dev, cred, timeout,
				m.cfg.SNMP.Retries,
				m.cfg.SNMP.MaxOids,
				uint32(m.cfg.SNMP.MaxRepetitions),
				log)
			if err != nil {
				log.Error().Err(err).Msg("cannot build SNMP session")
				return false
			}
			if err := sess.Connect(); err != nil {
				delay := backoff.Next()
				log.Warn().Err(err).Dur("retry_in", delay).Msg("SNMP connect failed")
				if client.SleepOrCancel(ctx, delay) {
					return false
				}
				continue
			}

			// Identify the device before any metric polling.
			info, err := PollSysInfo(sess, dev.ID)
			if err != nil {
				sess.Close()
				delay := backoff.Next()
				log.Warn().Err(err).Dur("retry_in", delay).Msg("sysinfo poll failed")
				if client.SleepOrCancel(ctx, delay) {
					return false
				}
				continue
			}

			backoff.Reset()
			session = sess
			lastSysUpTime = info.SysUpTimeTicks
			currentProfile = vendor.Detect(info.SysObjectID, info.SysDescr)

			// Publish sysinfo result immediately.
			m.emit(ctx, log, &PollResult{DeviceID: dev.ID, SysInfo: info})

			log.Info().
				Str("vendor", info.VendorName).
				Str("sys_name", info.SysName).
				Msg("device identified; starting poll loop")
			return true
		}
	}

	if !connectAndSysInfo() {
		return
	}

	for {
		select {
		case <-ctx.Done():
			session.Close()
			return

		case <-stateTicker.C:
			// Fast-path: state-change polls only. Uses a lightweight walk of
			// per-column subtrees (not the full ifTable) to minimise SNMP traffic
			// at the higher 15 s cadence.
			stateResult := &PollResult{DeviceID: dev.ID, StateOnly: true}

			// sysUpTime acts as the canary — failure means SNMP is broken.
			if ticks, err := PollSysUpTime(session); err != nil {
				log.Warn().Err(err).Msg("sysuptime poll failed; reconnecting")
				session.Close()
				if !connectAndSysInfo() {
					return
				}
				continue
			} else {
				lastSysUpTime = ticks
			}

			if ifaces, err := PollInterfaceState(session, dev.ID); err != nil {
				log.Warn().Err(err).Msg("interface state poll failed (non-fatal)")
			} else {
				stateResult.Interfaces = ifaces
				for _, iface := range ifaces {
					name := iface.IfName
					if name == "" {
						name = iface.IfDescr
					}
					ifByIndex[iface.IfIndex] = name
				}
			}

			if currentProfile == nil || !currentProfile.SkipOSPF {
				if ospf, err := PollOSPFNeighbours(session, dev.ID, ifByIndex); err != nil {
					log.Warn().Err(err).Msg("ospf poll failed (non-fatal)")
				} else if ospf != nil {
					// nil means the MIB walk returned 0 PDUs (SNMP hiccup or no OSPF
					// configured). Skip the write entirely — the writer's orphan-mark
					// would otherwise set every existing neighbour to 'down' for a
					// full poll cycle, creating false-positive alerts.
					stateResult.OSPFNeighbours = ospf
				}
			}

			if currentProfile == nil || !currentProfile.SkipISIS {
				if isis, err := PollISISAdjacencies(session, dev.ID, ifByIndex, lastSysUpTime); err != nil {
					log.Warn().Err(err).Msg("isis poll failed (non-fatal)")
				} else {
					if isis == nil {
						isis = []*model.ISISAdjacency{}
					}
					stateResult.ISISAdjacencies = isis
				}

				if areas, err := PollISISAreas(session, dev.ID); err != nil {
					log.Warn().Err(err).Msg("isis areas poll failed (non-fatal)")
				} else if len(areas) > 0 {
					stateResult.ISISAreas = areas
				}

				if circLevels, err := PollISISCircuitLevels(session, dev.ID, ifByIndex); err != nil {
					log.Warn().Err(err).Msg("isis circuit level poll failed (non-fatal)")
				} else if len(circLevels) > 0 {
					stateResult.ISISCircuitLevels = circLevels
				}
			}

			if currentProfile == nil || !currentProfile.SkipBGP {
				if bgp, err := PollBGPSessions(session, dev.ID); err != nil {
					log.Warn().Err(err).Msg("bgp poll failed (non-fatal)")
				} else if bgp != nil {
					// nil means the MIB walk returned 0 PDUs (SNMP hiccup or BGP not
					// configured). Skip the write — the writer's orphan-mark would
					// otherwise idle every session for a full poll cycle.
					stateResult.BGPSessions = bgp
				}
			}

			m.emit(ctx, log, stateResult)

		case <-counterTicker.C:
			// Slow-path: full interface counters + topology + route tables.
			counterResult := &PollResult{DeviceID: dev.ID}

			ifaces, err := PollInterfaces(session, dev.ID, lastSysUpTime)
			if err != nil {
				log.Warn().Err(err).Msg("interface poll failed; reconnecting")
				session.Close()
				if !connectAndSysInfo() {
					return
				}
				continue
			}
			counterResult.Interfaces = ifaces

			// Refresh the shared ifIndex → ifName map (full poll is authoritative).
			ifByIndex = make(map[int]string, len(ifaces))
			for _, iface := range ifaces {
				name := iface.IfName
				if name == "" {
					name = iface.IfDescr
				}
				ifByIndex[iface.IfIndex] = name
			}

			if lldp, err := PollLLDPNeighbors(session, dev.ID); err != nil {
				log.Warn().Err(err).Msg("lldp poll failed (non-fatal)")
			} else {
				counterResult.LLDPNeighbors = lldp
			}

			if cdp, err := PollCDPNeighbors(session, dev.ID, ifByIndex); err != nil {
				log.Warn().Err(err).Msg("cdp poll failed (non-fatal)")
			} else {
				counterResult.CDPNeighbors = cdp
			}

			if routes, err := PollRouteTable(session, dev.ID, ifByIndex); err != nil {
				log.Warn().Err(err).Msg("route table poll failed (non-fatal)")
			} else {
				if routes == nil {
					routes = []*model.RouteEntry{}
				}
				counterResult.RouteEntries = routes
			}

			if arp, err := PollARPTable(session, dev.ID, ifByIndex); err != nil {
				log.Warn().Err(err).Msg("arp poll failed (non-fatal)")
			} else {
				counterResult.ARPEntries = arp
			}

			if macs, err := PollMACTable(session, dev.ID, ifByIndex); err != nil {
				log.Warn().Err(err).Msg("mac poll failed (non-fatal)")
			} else {
				counterResult.MACEntries = macs
			}

			if currentProfile != nil && currentProfile.HpicfVlan {
				if vlans, ifvlans, err := PollVLANsHPICF(session, dev.ID); err != nil {
					log.Warn().Err(err).Msg("hpicf vlan poll failed (non-fatal)")
				} else {
					counterResult.VLANs = vlans
					counterResult.InterfaceVLANs = ifvlans
				}
			} else if vlans, ifvlans, err := PollVLANs(session, dev.ID, ifByIndex); err != nil {
				log.Warn().Err(err).Msg("vlan poll failed (non-fatal)")
			} else {
				counterResult.VLANs = vlans
				counterResult.InterfaceVLANs = ifvlans
			}

			if stp, err := PollSTPPorts(session, dev.ID, ifByIndex); err != nil {
				log.Warn().Err(err).Msg("stp poll failed (non-fatal)")
			} else {
				counterResult.STPPorts = stp
			}

			if currentProfile == nil || !currentProfile.SkipISIS {
				if lsps, err := PollISISLSPDatabase(session, dev.ID); err != nil {
					log.Warn().Err(err).Msg("isis lsp database poll failed (non-fatal)")
				} else if len(lsps) > 0 {
					counterResult.ISISLSPs = lsps
				}
			}

			m.emit(ctx, log, counterResult)

		case <-healthTicker.C:
			health, err := PollHealth(session, dev.ID, currentProfile, lastSysUpTime)
			if err != nil {
				log.Warn().Err(err).Msg("health poll failed; reconnecting")
				session.Close()
				if !connectAndSysInfo() {
					return
				}
				continue
			}
			m.emit(ctx, log, &PollResult{DeviceID: dev.ID, Health: health})

		case <-probeTicker.C:
			if pr := prober.Probe(ctx, dev.ID, dev.MgmtIP); pr != nil {
				m.emit(ctx, log, &PollResult{DeviceID: dev.ID, ProbeResult: pr})
			}
		}
	}
}

// emit dispatches a PollResult to the handler and logs any error.
func (m *Manager) emit(ctx context.Context, log zerolog.Logger, result *PollResult) {
	if err := m.handler.Handle(ctx, result); err != nil {
		log.Error().Err(err).Msg("result handler error")
	}
}

// decodeCred decrypts and unmarshals the device credential into the right type.
func (m *Manager) decodeCred(dev model.DeviceRow) (interface{}, error) {
	raw, err := crypto.DecodeCredential(m.codec, dev.CredentialData)
	if err != nil {
		return nil, fmt.Errorf("decrypt credential: %w", err)
	}

	switch dev.CredentialType {
	case "snmp_v2c":
		return client.UnmarshalV2c(raw)
	case "snmp_v3":
		return client.UnmarshalV3(raw)
	default:
		return nil, fmt.Errorf("unsupported credential type %q", dev.CredentialType)
	}
}

// ── DeviceSource interface ────────────────────────────────────────────────────

// DeviceSource abstracts where device rows come from. The PostgreSQL writer
// package implements this so the poller never directly imports the writer.
type DeviceSource interface {
	LoadDevices(ctx context.Context) ([]model.DeviceRow, error)
}

// ── Helpers ───────────────────────────────────────────────────────────────────
