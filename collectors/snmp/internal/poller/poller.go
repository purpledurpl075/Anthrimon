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
	DeviceID      uuid.UUID
	SysInfo       *model.DeviceInfo        // nil if not yet polled or failed
	Interfaces    []*model.InterfaceResult
	Health        *model.HealthResult      // nil if health poll not run this cycle
	LLDPNeighbors  []*model.LLDPNeighbor   // nil if not polled this cycle
	CDPNeighbors   []*model.CDPNeighbor    // nil if not polled this cycle
	OSPFNeighbours []*model.OSPFNeighbour  // nil if not polled this cycle
	BGPSessions    []*model.BGPSession     // nil if not polled this cycle
	RouteEntries   []*model.RouteEntry    // nil if not polled this cycle
	ARPEntries     []*model.ARPEntry       // nil if not polled this cycle
	MACEntries     []*model.MACEntry       // nil if not polled this cycle
	VLANs          []*model.VLANResult          // nil if not polled this cycle
	InterfaceVLANs []*model.InterfaceVLANResult // nil if not polled this cycle
	STPPorts       []*model.STPPortResult       // nil if not polled this cycle
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
		go m.runDevice(devCtx, dev)
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
func (m *Manager) runDevice(ctx context.Context, dev model.DeviceRow) {
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
	pollInterval := time.Duration(dev.PollingIntervalS) * time.Second
	if pollInterval <= 0 {
		pollInterval = time.Duration(m.cfg.Polling.DefaultIntervalS) * time.Second
	}
	healthInterval := pollInterval * time.Duration(m.cfg.Polling.HealthMultiplier)

	backoff := client.NewBackoff(60)
	var session *client.Session
	var currentProfile *vendor.Profile
	var lastSysUpTime uint32
	ifByIndex := make(map[int]string) // shared between ifaceTicker and healthTicker

	// Stagger startup across the poll interval to avoid thundering herd on launch.
	stagger := time.Duration(rand.Int63n(int64(pollInterval)))
	if client.SleepOrCancel(ctx, stagger) {
		return
	}

	ifaceTicker := time.NewTicker(pollInterval)
	// Offset health ticker by half a poll interval so it never fires at the
	// same instant as the interface ticker (avoids select starvation when
	// healthInterval is an exact multiple of pollInterval).
	healthTicker := time.NewTicker(healthInterval + pollInterval/2)
	defer ifaceTicker.Stop()
	defer healthTicker.Stop()

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

		case <-ifaceTicker.C:
			result := &PollResult{DeviceID: dev.ID}

			// Only fetch sysUpTime — full PollSysInfo runs on connect/reconnect only.
			if ticks, err := PollSysUpTime(session); err == nil {
				lastSysUpTime = ticks
			}

			ifaces, err := PollInterfaces(session, dev.ID, lastSysUpTime)
			if err != nil {
				log.Warn().Err(err).Msg("interface poll failed; reconnecting")
				session.Close()
				if !connectAndSysInfo() {
					return
				}
				continue
			}
			result.Interfaces = ifaces

			// Refresh the shared ifIndex → ifName map used by address/CDP pollers.
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
				result.LLDPNeighbors = lldp
			}

			if cdp, err := PollCDPNeighbors(session, dev.ID, ifByIndex); err != nil {
				log.Warn().Err(err).Msg("cdp poll failed (non-fatal)")
			} else {
				result.CDPNeighbors = cdp
			}

			if ospf, err := PollOSPFNeighbours(session, dev.ID, ifByIndex); err != nil {
				log.Warn().Err(err).Msg("ospf poll failed (non-fatal)")
			} else if len(ospf) > 0 {
				result.OSPFNeighbours = ospf
			}

			if bgp, err := PollBGPSessions(session, dev.ID); err != nil {
				log.Warn().Err(err).Msg("bgp poll failed (non-fatal)")
			} else if len(bgp) > 0 {
				result.BGPSessions = bgp
			}

			if routes, err := PollRouteTable(session, dev.ID, ifByIndex); err != nil {
				log.Warn().Err(err).Msg("route table poll failed (non-fatal)")
			} else if len(routes) > 0 {
				result.RouteEntries = routes
			}

			if arp, err := PollARPTable(session, dev.ID, ifByIndex); err != nil {
				log.Warn().Err(err).Msg("arp poll failed (non-fatal)")
			} else {
				result.ARPEntries = arp
			}

			if macs, err := PollMACTable(session, dev.ID, ifByIndex); err != nil {
				log.Warn().Err(err).Msg("mac poll failed (non-fatal)")
			} else {
				result.MACEntries = macs
			}

			if currentProfile != nil && currentProfile.HpicfVlan {
				if vlans, ifvlans, err := PollVLANsHPICF(session, dev.ID); err != nil {
					log.Warn().Err(err).Msg("hpicf vlan poll failed (non-fatal)")
				} else {
					result.VLANs = vlans
					result.InterfaceVLANs = ifvlans
				}
			} else if vlans, ifvlans, err := PollVLANs(session, dev.ID, ifByIndex); err != nil {
				log.Warn().Err(err).Msg("vlan poll failed (non-fatal)")
			} else {
				result.VLANs = vlans
				result.InterfaceVLANs = ifvlans
			}

			if stp, err := PollSTPPorts(session, dev.ID, ifByIndex); err != nil {
				log.Warn().Err(err).Msg("stp poll failed (non-fatal)")
			} else {
				result.STPPorts = stp
			}

			m.emit(ctx, log, result)

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

