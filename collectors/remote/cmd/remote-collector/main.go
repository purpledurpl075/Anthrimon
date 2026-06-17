// remote-collector is the Anthrimon distributed polling agent.
//
// It bootstraps a WireGuard VPN tunnel to the central hub, then polls local
// network devices via SNMP, receives NetFlow/sFlow, and collects syslog — all
// forwarded to the hub over the encrypted tunnel.
//
// Usage:
//
//	remote-collector [--config /path/to/remote-collector.yaml]
package main

import (
	"context"
	"crypto/sha256"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"

	"github.com/purpledurpl075/anthri-mon/collectors/remote/internal/bootstrap"
	"github.com/purpledurpl075/anthri-mon/collectors/remote/internal/collector"
	"github.com/purpledurpl075/anthri-mon/collectors/remote/internal/config"
	"github.com/purpledurpl075/anthri-mon/collectors/remote/internal/hub"
	"github.com/purpledurpl075/anthri-mon/collectors/remote/internal/logfwd"
	"github.com/purpledurpl075/anthri-mon/collectors/remote/internal/server"
	"github.com/purpledurpl075/anthri-mon/collectors/remote/internal/state"
	"github.com/purpledurpl075/anthri-mon/collectors/remote/internal/tunnel"
)

const version = "0.3.40"

// capabilities lists every feature this binary supports.  Sent on bootstrap
// and on every heartbeat so the hub always reflects the running binary.
var capabilities = []string{
	"snmp",
	"flow",
	"syslog",
	"config_backup",
	"arista_eapi",
	"aruba_rest",
	"config_exec",
	"api_probe",
}

func main() {
	cfgPath := flag.String("config", "", "path to config file (default: /etc/anthrimon/remote-collector.yaml)")
	showVer := flag.Bool("version", false, "print version and exit")
	flag.Parse()

	if *showVer {
		fmt.Printf("remote-collector %s\n", version)
		os.Exit(0)
	}

	zerolog.TimeFieldFormat = time.RFC3339
	log.Logger = log.Output(zerolog.ConsoleWriter{Out: os.Stderr, TimeFormat: time.RFC3339})

	if err := run(*cfgPath); err != nil && !errors.Is(err, context.Canceled) {
		log.Fatal().Err(err).Msg("remote-collector exited with error")
	}
}

func run(cfgPath string) error {
	// ── Config ────────────────────────────────────────────────────────────────

	cfg, err := config.Load(cfgPath)
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}

	level, err := zerolog.ParseLevel(cfg.Log.Level)
	if err != nil {
		level = zerolog.InfoLevel
	}
	zerolog.SetGlobalLevel(level)
	logger := zerolog.New(os.Stderr).With().
		Timestamp().
		Str("service", "remote-collector").
		Str("version", version).
		Logger()

	logger.Info().Str("log_level", level.String()).Msg("starting")

	startTime := time.Now()

	// ── Signal context ────────────────────────────────────────────────────────

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	// ── Bootstrap / state ─────────────────────────────────────────────────────

	hostname, err := os.Hostname()
	if err != nil {
		hostname = "unknown"
	}

	st, err := loadOrBootstrap(ctx, cfg, hostname, logger)
	if err != nil {
		return fmt.Errorf("bootstrap: %w", err)
	}

	// ── WireGuard tunnel ──────────────────────────────────────────────────────

	if !tunnel.IsUp() {
		logger.Info().Msg("bringing up WireGuard tunnel")
		if err := tunnel.Setup(st); err != nil {
			return fmt.Errorf("tunnel setup: %w", err)
		}
	} else {
		logger.Info().Msg("WireGuard tunnel already up")
	}

	defer func() {
		logger.Info().Msg("tearing down WireGuard tunnel")
		_ = tunnel.Teardown()
	}()

	// ── Hub client ────────────────────────────────────────────────────────────
	//
	// Derive the hub's WireGuard IP from our assigned IP (same /24, host .1).
	hubURL := "https://" + wgHubIP(st.WGAssignedIP)
	hubClient := hub.NewClient(hubURL, st.APIKey, cfg.CACert)

	// ── Log forwarder ─────────────────────────────────────────────────────────
	// Upgrade the logger to also forward log entries to the hub, so operators
	// can view process logs in the UI.  The forwarder uses a stderr-only sub-
	// logger for its own error messages to avoid infinite loops.
	stderrLog := zerolog.New(os.Stderr).With().
		Timestamp().
		Str("service", "remote-collector").
		Str("version", version).
		Logger()
	fwd := logfwd.New(hubClient, stderrLog)
	logger = zerolog.New(zerolog.MultiLevelWriter(os.Stderr, fwd)).With().
		Timestamp().
		Str("service", "remote-collector").
		Str("version", version).
		Logger()

	// ── Trap handler ─────────────────────────────────────────────────────────
	// Install (or refresh) the snmptrapd exec handler binary on every startup.
	// Non-fatal: the collector still runs if this fails.
	installTrapHandler(ctx, hubClient, logger)

	// ── Collectors ────────────────────────────────────────────────────────────

	snmpCol    := collector.NewSNMPCollector(hubClient, cfg.SNMP, logger)
	sshCfgCol  := collector.NewSSHConfigCollector(hubClient, logger)
	restCol    := collector.NewArubaRESTCollector(hubClient, logger)
	eapiCol    := collector.NewAristaEAPICollector(hubClient, logger)
	probeCol   := collector.NewProbeCollector(hubClient, logger)

	devicesByIP := make(map[string]string)
	flowCol    := collector.NewFlowCollector(hubClient, cfg.Flow, cfg.Forward, devicesByIP, logger)
	syslogCol  := collector.NewSyslogCollector(hubClient, cfg.Syslog, cfg.Forward, devicesByIP, logger)

	// Initial config fetch.
	if err := refreshDevices(ctx, hubClient, snmpCol, sshCfgCol, restCol, eapiCol, probeCol, flowCol, syslogCol, logger); err != nil {
		logger.Warn().Err(err).Msg("initial config fetch failed — will retry")
	}

	// ── Control server callbacks ──────────────────────────────────────────────

	onRefresh := func() {
		if err := refreshDevices(ctx, hubClient, snmpCol, sshCfgCol, restCol, eapiCol, probeCol, flowCol, syslogCol, logger); err != nil {
			logger.Warn().Err(err).Msg("on-demand config refresh failed")
		}
	}

	// restartCh receives the new executable path when a self-update completes.
	// selfUpdate sends on this channel and calls cancel() to trigger graceful
	// shutdown.  The main goroutine then re-execs into the new binary.
	restartCh := make(chan string, 1)

	onUpdate := func() error {
		go selfUpdate(hubClient, cancel, restartCh, logger)
		return nil
	}

	// ── Mini HTTP server on the WireGuard IP ─────────────────────────────────

	controlSrv := server.NewServer(st.WGAssignedIP, 9090, st.APIKey, onRefresh, onUpdate, snmpCol, version, logger)

	// ── Launch all goroutines ─────────────────────────────────────────────────

	var wg sync.WaitGroup

	wg.Add(1)
	go func() {
		defer wg.Done()
		fwd.Run(ctx)
	}()

	wg.Add(1)
	go func() {
		defer wg.Done()
		heartbeatLoop(ctx, hubClient, version, startTime, logger)
	}()

	wg.Add(1)
	go func() {
		defer wg.Done()
		configRefreshLoop(ctx, hubClient, snmpCol, sshCfgCol, restCol, eapiCol, probeCol, flowCol, syslogCol, logger)
	}()

	wg.Add(1)
	go func() {
		defer wg.Done()
		snmpCol.Run(ctx)
	}()

	wg.Add(1)
	go func() {
		defer wg.Done()
		sshCfgCol.Run(ctx)
	}()

	wg.Add(1)
	go func() {
		defer wg.Done()
		restCol.Run(ctx)
	}()

	wg.Add(1)
	go func() {
		defer wg.Done()
		eapiCol.Run(ctx)
	}()

	wg.Add(1)
	go func() {
		defer wg.Done()
		probeCol.Run(ctx)
	}()

	wg.Add(1)
	go func() {
		defer wg.Done()
		flowCol.Run(ctx)
	}()

	wg.Add(1)
	go func() {
		defer wg.Done()
		syslogCol.Run(ctx)
	}()

	wg.Add(1)
	go func() {
		defer wg.Done()
		if err := controlSrv.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
			logger.Error().Err(err).Msg("control server error")
		}
	}()

	// Wait for context cancellation (SIGINT/SIGTERM or self-update).
	<-ctx.Done()
	logger.Info().Msg("shutdown signal received — draining goroutines")
	drainDone := make(chan struct{})
	go func() {
		wg.Wait()
		close(drainDone)
	}()
	select {
	case <-drainDone:
	case <-time.After(15 * time.Second):
		logger.Warn().Msg("drain timeout — forcing exit")
	}
	logger.Info().Msg("remote-collector stopped")

	// ── Self-update re-exec ───────────────────────────────────────────────────
	// If selfUpdate completed successfully it sent the new binary path on
	// restartCh and called cancel().  We re-exec into the new binary here,
	// AFTER all goroutines have drained but BEFORE the deferred tunnel.Teardown
	// runs (syscall.Exec replaces the process image — defers don't run).
	// The WireGuard tunnel therefore stays up and the new binary finds it
	// already configured, avoiding any connectivity gap.
	select {
	case newBin := <-restartCh:
		logger.Info().Str("binary", newBin).Msg("re-execing into updated binary")
		if err := syscall.Exec(newBin, os.Args, os.Environ()); err != nil {
			// exec failed — fall through to normal shutdown (defer tears down tunnel)
			return fmt.Errorf("self-exec failed: %w", err)
		}
		// syscall.Exec never returns on success.
	default:
		// Normal shutdown — deferred tunnel.Teardown will run.
	}

	return nil
}

// ─── Self-update ──────────────────────────────────────────────────────────────

const trapHandlerPath = "/usr/local/bin/anthrimon-traphandler"

// installTrapHandler downloads the trap-handler binary from the hub and
// installs it at trapHandlerPath.  Called on first boot and on self-update.
// A failure is logged but never fatal — trap collection is optional.
func installTrapHandler(ctx context.Context, hubClient *hub.Client, logger zerolog.Logger) {
	log := logger.With().Str("op", "install_trap_handler").Logger()

	data, expectedSHA, err := hubClient.DownloadTrapHandler(ctx, runtime.GOARCH)
	if err != nil {
		log.Warn().Err(err).Msg("could not download trap-handler (trap collection unavailable)")
		return
	}

	if expectedSHA != "" {
		actual := fmt.Sprintf("%x", sha256.Sum256(data))
		if actual != expectedSHA {
			log.Error().Str("expected", expectedSHA).Str("actual", actual).
				Msg("trap-handler SHA-256 mismatch — skipping install")
			return
		}
	}

	tmpPath := trapHandlerPath + ".new"
	if err := os.WriteFile(tmpPath, data, 0755); err != nil { //nolint:gosec
		log.Error().Err(err).Msg("write trap-handler failed")
		return
	}
	if err := os.Rename(tmpPath, trapHandlerPath); err != nil {
		_ = os.Remove(tmpPath)
		log.Error().Err(err).Msg("install trap-handler failed")
		return
	}
	log.Info().Int("bytes", len(data)).Str("path", trapHandlerPath).Msg("trap-handler installed")
}

// selfUpdate downloads the latest binary from the hub, verifies its SHA-256,
// atomically replaces the running executable, sends the new path on restartCh,
// and cancels the context to trigger graceful shutdown → re-exec.
// The trap-handler binary is also updated before the restart.
func selfUpdate(
	hubClient *hub.Client,
	cancel    context.CancelFunc,
	restartCh chan<- string,
	logger    zerolog.Logger,
) {
	log := logger.With().Str("op", "self_update").Logger()

	exePath, err := os.Executable()
	if err != nil {
		log.Error().Err(err).Msg("cannot determine executable path")
		return
	}

	log.Info().Str("arch", runtime.GOARCH).Msg("downloading updated binary")

	dlCtx, dlCancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer dlCancel()

	data, expectedSHA, err := hubClient.DownloadBinary(dlCtx, runtime.GOARCH)
	if err != nil {
		log.Error().Err(err).Msg("download failed")
		return
	}

	// Verify SHA-256 when the hub provides it.
	if expectedSHA != "" {
		actual := fmt.Sprintf("%x", sha256.Sum256(data))
		if actual != expectedSHA {
			log.Error().
				Str("expected", expectedSHA).
				Str("actual", actual).
				Msg("SHA-256 mismatch — aborting update")
			return
		}
		log.Info().Str("sha256", actual).Msg("SHA-256 verified")
	}

	// Also update the trap-handler binary.
	installTrapHandler(dlCtx, hubClient, logger)

	// Write to a temp file adjacent to the current binary.
	tmpPath := exePath + ".new"
	if err := os.WriteFile(tmpPath, data, 0755); err != nil { //nolint:gosec
		log.Error().Err(err).Str("path", tmpPath).Msg("write temp binary failed")
		return
	}

	// Atomically replace the running binary.
	if err := os.Rename(tmpPath, exePath); err != nil {
		_ = os.Remove(tmpPath)
		log.Error().Err(err).Str("path", exePath).Msg("rename failed")
		return
	}

	log.Info().
		Str("path", exePath).
		Int("bytes", len(data)).
		Msg("binary replaced — initiating graceful restart")

	// Signal the main goroutine: send path, then cancel context.
	restartCh <- exePath
	cancel()
}

// wgHubIP derives the hub's WireGuard IP from the collector's assigned IP by
// replacing the last octet with 1 (e.g. "10.100.0.3" → "10.100.0.1").
// Falls back to the conventional default if the IP is unparseable.
func wgHubIP(assignedIP string) string {
	if i := strings.LastIndex(assignedIP, "."); i >= 0 {
		return assignedIP[:i+1] + "1"
	}
	return "10.100.0.1"
}

// ─── Bootstrap helper ─────────────────────────────────────────────────────────

// loadOrBootstrap loads the state file if it exists, or performs a one-time
// bootstrap registration with the hub and persists the resulting state.
func loadOrBootstrap(ctx context.Context, cfg *config.Config, hostname string, logger zerolog.Logger) (*state.State, error) {
	st, err := state.Load(cfg.StateFile)
	if err != nil {
		return nil, fmt.Errorf("load state: %w", err)
	}

	if st != nil {
		logger.Info().
			Str("collector_id", st.CollectorID).
			Str("wg_ip", st.WGAssignedIP).
			Msg("loaded existing state")
		return st, nil
	}

	// State file absent — perform bootstrap.
	logger.Info().Str("hub", cfg.HubURL).Msg("no state file — bootstrapping with hub")

	if cfg.Token == "" {
		return nil, fmt.Errorf("ANTHRIMON_TOKEN is required for first-time bootstrap")
	}

	st, err = bootstrap.Bootstrap(cfg, hostname, version, capabilities)
	if err != nil {
		return nil, fmt.Errorf("bootstrap request: %w", err)
	}

	if err := st.Save(cfg.StateFile); err != nil {
		return nil, fmt.Errorf("save state: %w", err)
	}

	logger.Info().
		Str("collector_id", st.CollectorID).
		Str("wg_ip", st.WGAssignedIP).
		Msg("bootstrap complete — state saved")

	return st, nil
}

// ─── Heartbeat loop ───────────────────────────────────────────────────────────

func heartbeatLoop(ctx context.Context, hubClient *hub.Client, ver string, startTime time.Time, logger zerolog.Logger) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	send := func() {
		stats := map[string]any{
			"uptime_s":     int(time.Since(startTime).Seconds()),
			"arch":         runtime.GOARCH,
			"capabilities": capabilities,
		}
		if err := hubClient.Heartbeat(ctx, ver, stats); err != nil {
			logger.Warn().Err(err).Msg("heartbeat failed")
		} else {
			logger.Debug().Msg("heartbeat sent")
		}
	}

	// Send immediately on startup.
	send()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			send()
		}
	}
}

// ─── Config refresh loop ──────────────────────────────────────────────────────

func configRefreshLoop(
	ctx context.Context,
	hubClient *hub.Client,
	snmpCol   *collector.SNMPCollector,
	sshCfgCol *collector.SSHConfigCollector,
	restCol   *collector.ArubaRESTCollector,
	eapiCol   *collector.AristaEAPICollector,
	probeCol  *collector.ProbeCollector,
	flowCol   *collector.FlowCollector,
	syslogCol *collector.SyslogCollector,
	logger    zerolog.Logger,
) {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := refreshDevices(ctx, hubClient, snmpCol, sshCfgCol, restCol, eapiCol, probeCol, flowCol, syslogCol, logger); err != nil {
				logger.Warn().Err(err).Msg("periodic config refresh failed")
			}
		}
	}
}

// refreshDevices fetches the device list from the hub and pushes it to all collectors.
func refreshDevices(
	ctx context.Context,
	hubClient *hub.Client,
	snmpCol   *collector.SNMPCollector,
	sshCfgCol *collector.SSHConfigCollector,
	restCol   *collector.ArubaRESTCollector,
	eapiCol   *collector.AristaEAPICollector,
	probeCol  *collector.ProbeCollector,
	flowCol   *collector.FlowCollector,
	syslogCol *collector.SyslogCollector,
	logger    zerolog.Logger,
) error {
	devCfg, err := hubClient.FetchConfig(ctx)
	if err != nil {
		return fmt.Errorf("fetch config: %w", err)
	}

	byIP := make(map[string]string, len(devCfg.Devices))
	for _, d := range devCfg.Devices {
		byIP[d.MgmtIP] = d.ID
	}

	snmpCol.SetDevices(devCfg.Devices)
	sshCfgCol.SetDevices(devCfg.Devices)
	restCol.SetDevices(devCfg.Devices)
	eapiCol.SetDevices(devCfg.Devices)
	probeCol.SetDevices(devCfg.Devices)
	flowCol.UpdateDevices(byIP)
	syslogCol.UpdateDevices(byIP)
	syslogCol.SetTimezone(devCfg.Timezone)
	restCol.SetIntervals(devCfg.StateIntervalS, devCfg.CounterIntervalS)
	eapiCol.SetIntervals(devCfg.StateIntervalS, devCfg.CounterIntervalS)

	logger.Info().
		Int("devices", len(devCfg.Devices)).
		Str("generated_at", devCfg.GeneratedAt).
		Msg("device config refreshed")

	return nil
}
