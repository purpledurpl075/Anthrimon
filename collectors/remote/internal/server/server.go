// Package server exposes a tiny HTTP server on the collector's WireGuard IP
// that accepts hub-initiated commands (/refresh, /health, /update, /live).
package server

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/rs/zerolog"

	"github.com/purpledurpl075/anthri-mon/collectors/remote/internal/collector"
)

const (
	defaultPort     = 9090
	shutdownTimeout = 5 * time.Second
)

// Server is the mini HTTP control plane exposed to the hub.
type Server struct {
	wgIP       string
	port       int
	version    string
	authToken  string // sha256hex(apiKey) — expected Bearer token on mutating endpoints
	onRefresh  func()
	onUpdate   func() error
	snmpCol    *collector.SNMPCollector
	refreshMu  sync.Mutex
	log        zerolog.Logger
}

// NewServer creates a Server.
//
//   - wgIP      is the WireGuard-assigned IP (e.g. "10.100.0.2").
//   - port      is the listen port; 0 means use defaultPort (9090).
//   - apiKey    is the collector's plaintext API key; its SHA-256 hex is used
//               as the expected Bearer token on mutating endpoints so the hub
//               can authenticate without storing the plaintext key.
//   - onRefresh is called when POST /refresh is received.
//   - onUpdate  is called when POST /update is received; nil disables the endpoint.
//   - snmpCol   is used for GET /live streaming; nil disables the endpoint.
//   - version   is included in /health responses.
func NewServer(
	wgIP string, port int, apiKey string,
	onRefresh func(), onUpdate func() error,
	snmpCol *collector.SNMPCollector,
	version string,
	log zerolog.Logger,
) *Server {
	if port == 0 {
		port = defaultPort
	}
	h := sha256.Sum256([]byte(apiKey))
	authToken := fmt.Sprintf("%x", h)
	return &Server{
		wgIP:      wgIP,
		port:      port,
		version:   version,
		authToken: authToken,
		onRefresh: onRefresh,
		onUpdate:  onUpdate,
		snmpCol:   snmpCol,
		log:       log.With().Str("component", "control_server").Logger(),
	}
}

// checkAuth validates the Authorization: Bearer header against a time-based
// HMAC-SHA256 token.  The hub sends HMAC(key=authToken, msg=utc_minute); the
// collector accepts the current minute and ±1 to tolerate clock skew, giving
// tokens a ~3-minute lifetime and preventing static replay of a captured token.
func (s *Server) checkAuth(w http.ResponseWriter, r *http.Request) bool {
	auth := r.Header.Get("Authorization")
	token, ok := strings.CutPrefix(auth, "Bearer ")
	if !ok || token == "" {
		s.log.Warn().
			Str("remote_addr", r.RemoteAddr).
			Str("path", r.URL.Path).
			Msg("control server: unauthorized request")
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return false
	}

	now := time.Now().Unix() / 60
	for _, minute := range []int64{now - 1, now, now + 1} {
		mac := hmac.New(sha256.New, []byte(s.authToken))
		mac.Write([]byte(strconv.FormatInt(minute, 10)))
		expected := fmt.Sprintf("%x", mac.Sum(nil))
		if subtle.ConstantTimeCompare([]byte(token), []byte(expected)) == 1 {
			return true
		}
	}

	s.log.Warn().
		Str("remote_addr", r.RemoteAddr).
		Str("path", r.URL.Path).
		Msg("control server: unauthorized request")
	http.Error(w, "unauthorized", http.StatusUnauthorized)
	return false
}

// Run starts the HTTP server and blocks until ctx is cancelled.
func (s *Server) Run(ctx context.Context) error {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", s.handleHealth)
	mux.HandleFunc("/refresh", s.handleRefresh)
	mux.HandleFunc("/update", s.handleUpdate)
	mux.HandleFunc("/live", s.handleLive)
	mux.HandleFunc("/probe", s.handleProbe)
	mux.HandleFunc("/probe-icmp", s.handleProbeICMP)
	mux.HandleFunc("/sweep", s.handleSweep)
	mux.HandleFunc("/poll", s.handlePoll)
	mux.HandleFunc("/config-exec", s.handleConfigExec)
	mux.HandleFunc("/api-probe", s.handleAPIProbe)
	mux.HandleFunc("/aoscx-rest", s.handleAOSCXRest)
	mux.HandleFunc("/trap-config", s.handleTrapConfig)

	addr := net.JoinHostPort(s.wgIP, fmt.Sprintf("%d", s.port))
	srv := &http.Server{
		Addr:        addr,
		Handler:     mux,
		ReadTimeout: 10 * time.Second,
		// WriteTimeout=0: /live uses SSE; per-handler deadlines applied below for short endpoints.
		WriteTimeout: 0,
		IdleTimeout:  60 * time.Second,
	}

	s.log.Info().Str("addr", addr).Msg("control server starting")

	errCh := make(chan error, 1)
	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			errCh <- err
		}
	}()

	select {
	case err := <-errCh:
		return fmt.Errorf("control server: %w", err)
	case <-ctx.Done():
	}

	shutCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	if err := srv.Shutdown(shutCtx); err != nil {
		s.log.Warn().Err(err).Msg("control server shutdown error")
	}
	s.log.Info().Msg("control server stopped")
	return nil
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.checkAuth(w, r) {
		return
	}
	rc := http.NewResponseController(w)
	_ = rc.SetWriteDeadline(time.Now().Add(5 * time.Second))
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{
		"status":  "ok",
		"version": s.version,
		"wg_ip":   s.wgIP,
	})
}

func (s *Server) handleRefresh(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.checkAuth(w, r) {
		return
	}
	rc := http.NewResponseController(w)
	_ = rc.SetWriteDeadline(time.Now().Add(5 * time.Second))
	if s.onRefresh != nil {
		if !s.refreshMu.TryLock() {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]string{"status": "already refreshing"})
			return
		}
		go func() {
			defer s.refreshMu.Unlock()
			s.onRefresh()
		}()
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{
		"status": "refreshing",
	})
}

func (s *Server) handleUpdate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.checkAuth(w, r) {
		return
	}
	if s.onUpdate == nil {
		http.Error(w, "update not configured", http.StatusNotImplemented)
		return
	}
	s.log.Info().Msg("self-update requested by hub")
	go func() {
		if err := s.onUpdate(); err != nil {
			s.log.Error().Err(err).Msg("self-update failed")
		}
	}()
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{
		"status": "updating",
	})
}

// handleLive streams raw SNMP interface counter snapshots as Server-Sent Events.
// Query params: device_id (string), if_index (int).
// Each event is a JSON-encoded LiveSample; a final {"done":true} event closes the stream.
func (s *Server) handleLive(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.checkAuth(w, r) {
		return
	}
	if s.snmpCol == nil {
		http.Error(w, "live sampling not available", http.StatusServiceUnavailable)
		return
	}

	deviceID := r.URL.Query().Get("device_id")
	ifIndexStr := r.URL.Query().Get("if_index")
	if deviceID == "" || ifIndexStr == "" {
		http.Error(w, "device_id and if_index are required", http.StatusBadRequest)
		return
	}
	ifIndex, err := strconv.Atoi(ifIndexStr)
	if err != nil || ifIndex < 1 {
		http.Error(w, "invalid if_index", http.StatusBadRequest)
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return
	}

	ch, err := s.snmpCol.LiveInterface(r.Context(), deviceID, ifIndex)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	for sample := range ch {
		b, _ := json.Marshal(sample)
		fmt.Fprintf(w, "data: %s\n\n", b)
		flusher.Flush()
	}

	fmt.Fprintf(w, "data: {\"done\":true}\n\n")
	flusher.Flush()
}

// ─── trap-triggered repoll ────────────────────────────────────────────────────

type pollReq struct {
	DeviceID string `json:"device_id"`
}

// handlePoll triggers an immediate SNMP poll for a specific device.
// Called by the hub after a qualifying trap is received for that device.
func (s *Server) handlePoll(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.checkAuth(w, r) {
		return
	}
	if s.snmpCol == nil {
		http.Error(w, "snmp collector not available", http.StatusServiceUnavailable)
		return
	}

	var req pollReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}
	if req.DeviceID == "" {
		http.Error(w, "device_id is required", http.StatusBadRequest)
		return
	}

	rc := http.NewResponseController(w)
	_ = rc.SetWriteDeadline(time.Now().Add(5 * time.Second))

	s.snmpCol.TriggerPoll(req.DeviceID)

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"status": "queued", "device_id": req.DeviceID})
}

// ─── on-demand probe / sweep ──────────────────────────────────────────────────

type probeReq struct {
	IP       string                `json:"ip"`
	Port     int                   `json:"port"`
	Creds    []collector.CredSpec  `json:"creds"`
	TimeoutS int                   `json:"timeout_s"`
}

type sweepReq struct {
	CIDR          string               `json:"cidr"`
	Port          int                  `json:"port"`
	Creds         []collector.CredSpec `json:"creds"`
	TimeoutS      int                  `json:"timeout_s"`
	MaxConcurrent int                  `json:"max_concurrent"`
}

// handleProbe tries each credential against a single IP and returns the first
// successful ProbeResult as JSON, or 404 if the device does not respond.
func (s *Server) handleProbe(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.checkAuth(w, r) {
		return
	}

	var req probeReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}
	if req.IP == "" || len(req.Creds) == 0 {
		http.Error(w, "ip and creds are required", http.StatusBadRequest)
		return
	}
	if req.Port == 0 {
		req.Port = 161
	}
	if req.TimeoutS <= 0 || req.TimeoutS > 10 {
		req.TimeoutS = 3
	}

	rc := http.NewResponseController(w)
	_ = rc.SetWriteDeadline(time.Now().Add(time.Duration(req.TimeoutS)*time.Second*time.Duration(len(req.Creds)) + 2*time.Second))

	result, _ := collector.ProbeOne(req.IP, req.Port, req.Creds, time.Duration(req.TimeoutS)*time.Second)

	w.Header().Set("Content-Type", "application/json")
	if result == nil {
		w.WriteHeader(http.StatusNotFound)
		_ = json.NewEncoder(w).Encode(map[string]string{"detail": "device did not respond"})
		return
	}
	_ = json.NewEncoder(w).Encode(result)
}

// handleSweep probes every usable host in the requested CIDR and returns a
// SweepResult JSON object when the sweep completes.  The request context
// propagates to the sweep so the client can cancel by closing the connection.
func (s *Server) handleSweep(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.checkAuth(w, r) {
		return
	}

	var req sweepReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}
	if req.CIDR == "" || len(req.Creds) == 0 {
		http.Error(w, "cidr and creds are required", http.StatusBadRequest)
		return
	}
	if req.Port == 0 {
		req.Port = 161
	}
	if req.TimeoutS <= 0 || req.TimeoutS > 10 {
		req.TimeoutS = 3
	}
	if req.MaxConcurrent <= 0 || req.MaxConcurrent > 254 {
		req.MaxConcurrent = 50
	}

	s.log.Info().Str("cidr", req.CIDR).Msg("sweep requested")

	result, err := collector.SweepCIDR(
		r.Context(), req.CIDR, req.Port, req.Creds,
		time.Duration(req.TimeoutS)*time.Second, req.MaxConcurrent,
	)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	s.log.Info().Str("cidr", req.CIDR).Int("found", len(result.Found)).Msg("sweep complete")

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(result)
}

// ─── snmptrapd v3 credential config ──────────────────────────────────────────

type trapV3User struct {
	Username  string `json:"username"`
	AuthProto string `json:"auth_proto"` // SHA-256, SHA, MD5, etc.
	AuthKey   string `json:"auth_key"`
	PrivProto string `json:"priv_proto"` // AES, AES-256, DES, etc.
	PrivKey   string `json:"priv_key"`
}

type trapConfigReq struct {
	Users []trapV3User `json:"users"`
}

// snmptrapd config and persistent-user-DB paths — override via env.
func snmptrapConf() string {
	if v := os.Getenv("ANTHRIMON_SNMPTRAPD_CONF"); v != "" {
		return v
	}
	return "/etc/snmp/snmptrapd.conf"
}

func snmptrapPersist() string {
	if v := os.Getenv("ANTHRIMON_SNMPTRAPD_PERSIST"); v != "" {
		return v
	}
	return "/var/lib/snmp/snmptrapd.conf"
}

func buildSnmptrapConf(users []trapV3User) string {
	var b strings.Builder
	b.WriteString("# Generated by Anthrimon — do not edit manually\n")
	b.WriteString("# Regenerate: POST /trap-config on the collector control server\n\n")
	b.WriteString("disableAuthorization yes\n\n")
	b.WriteString("# Output numeric OIDs so the handler needs no MIB files\n")
	b.WriteString("outputOption n\n\n")
	b.WriteString("# Route all traps to the Anthrimon handler\n")
	b.WriteString("traphandle default /usr/local/bin/anthrimon-traphandler\n")
	if len(users) > 0 {
		b.WriteString("\n# Authorize v3 users to trigger handlers\n")
		for _, u := range users {
			fmt.Fprintf(&b, "authUser execute,log,net %s\n", u.Username)
		}
		b.WriteString("\n# SNMPv3 users (plaintext; snmptrapd localizes keys on restart)\n")
		for _, u := range users {
			if u.PrivProto != "" && u.PrivKey != "" {
				fmt.Fprintf(&b, "createUser %s %s \"%s\" %s \"%s\"\n",
					u.Username, u.AuthProto, u.AuthKey, u.PrivProto, u.PrivKey)
			} else if u.AuthProto != "" && u.AuthKey != "" {
				fmt.Fprintf(&b, "createUser %s %s \"%s\"\n",
					u.Username, u.AuthProto, u.AuthKey)
			} else {
				fmt.Fprintf(&b, "createUser %s\n", u.Username)
			}
		}
	}
	return b.String()
}

// handleTrapConfig receives a v3 user list from the hub, regenerates the
// snmptrapd config, and restarts snmptrapd.
func (s *Server) handleTrapConfig(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.checkAuth(w, r) {
		return
	}

	var req trapConfigReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}

	confPath := snmptrapConf()
	persistPath := snmptrapPersist()
	confContent := buildSnmptrapConf(req.Users)

	if err := os.WriteFile(confPath, []byte(confContent), 0640); err != nil {
		s.log.Error().Err(err).Str("path", confPath).Msg("trap-config: write snmptrapd.conf failed")
		http.Error(w, "failed to write snmptrapd.conf: "+err.Error(), http.StatusInternalServerError)
		return
	}

	// Remove localized key DB so snmptrapd re-derives keys from the new createUser entries.
	if err := os.Remove(persistPath); err != nil && !os.IsNotExist(err) {
		s.log.Warn().Err(err).Str("path", persistPath).Msg("trap-config: could not remove persistent user DB")
	}

	if err := exec.Command("systemctl", "restart", "snmptrapd").Run(); err != nil {
		s.log.Error().Err(err).Msg("trap-config: snmptrapd restart failed")
		http.Error(w, "snmptrapd restart failed: "+err.Error(), http.StatusInternalServerError)
		return
	}

	s.log.Info().Int("v3_users", len(req.Users)).Msg("trap-config: snmptrapd restarted with updated users")

	rc := http.NewResponseController(w)
	_ = rc.SetWriteDeadline(time.Now().Add(5 * time.Second))
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"status":    "restarted",
		"v3_users":  len(req.Users),
	})
}

// ── /probe-icmp ──────────────────────────────────────────────────────────────
//
// Runs ping / traceroute / mtr from this collector's vantage point and streams
// the output back as newline-delimited JSON.  Each line is one of:
//
//   {"event": "start",    "command": "...", "source": "<wg-ip>"}
//   {"event": "line",     "data":    "..."}
//   {"event": "complete", "exit_code": N}
//   {"event": "error",    "detail":  "..."}
//
// Hub-side router consumes this and forwards events to its own WebSocket client.

type probeICMPReq struct {
	Type     string `json:"type"`       // "ping" | "traceroute" | "mtr"
	Target   string `json:"target"`     // hostname or IP
	Count    int    `json:"count"`      // probes (ping/mtr) — clamped 1..60
	TimeoutS int    `json:"timeout_s"`  // per-probe seconds — clamped 1..10
	MaxHops  int    `json:"max_hops"`   // traceroute only — clamped 1..32
}

func validProbeTarget(s string) bool {
	if len(s) == 0 || len(s) > 253 || s[0] == '-' {
		return false
	}
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z',
			r >= 'A' && r <= 'Z',
			r >= '0' && r <= '9',
			r == '.', r == ':', r == '-', r == '_':
			// ok
		default:
			return false
		}
	}
	return true
}

func clampInt(v, lo, hi int) int {
	if v < lo { return lo }
	if v > hi { return hi }
	return v
}

func (s *Server) handleProbeICMP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.checkAuth(w, r) {
		return
	}

	var req probeICMPReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}
	if !validProbeTarget(req.Target) {
		http.Error(w, "invalid target", http.StatusBadRequest)
		return
	}
	count := clampInt(req.Count, 1, 60)
	timeoutS := clampInt(req.TimeoutS, 1, 10)
	maxHops := clampInt(req.MaxHops, 1, 32)
	if count == 0 { count = 5 }
	if timeoutS == 0 { timeoutS = 3 }
	if maxHops == 0 { maxHops = 24 }

	var cmd *exec.Cmd
	switch req.Type {
	case "ping":
		cmd = exec.Command("ping", "-n", "-c", strconv.Itoa(count), "-W", strconv.Itoa(timeoutS), req.Target)
	case "traceroute":
		// Drop -n so inetutils-traceroute (which doesn't support it) works
		// alongside the modern traceroute package.  The parser accepts both
		// IPs and hostnames.
		cmd = exec.Command("traceroute", "-w", strconv.Itoa(timeoutS), "-q", "1",
			"-m", strconv.Itoa(maxHops), req.Target)
	case "mtr":
		// Long-form flags — work on mtr (full) and mtr-tiny.  If mtr-tiny
		// glibc-aborts anyway, the hub-side runner detects the abort line
		// and surfaces a clear install message.
		cmd = exec.Command("mtr", "--report", "--report-cycles", strconv.Itoa(count),
			"--no-dns", req.Target)
	default:
		http.Error(w, "type must be ping|traceroute|mtr", http.StatusBadRequest)
		return
	}

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		http.Error(w, "pipe: "+err.Error(), http.StatusInternalServerError)
		return
	}
	cmd.Stderr = cmd.Stdout

	// Stream newline-JSON.  Disable buffering on the response writer so each line
	// reaches the hub immediately.
	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("X-Accel-Buffering", "no")
	flusher, _ := w.(http.Flusher)

	writeEvent := func(ev map[string]any) bool {
		buf, _ := json.Marshal(ev)
		buf = append(buf, '\n')
		if _, err := w.Write(buf); err != nil {
			return false
		}
		if flusher != nil { flusher.Flush() }
		return true
	}

	wgIP, _ := getOutboundIP()
	// Hide the absolute path of the binary in the displayed command.
	displayArgs := append([]string{}, cmd.Args...)
	if len(displayArgs) > 0 {
		if i := strings.LastIndex(displayArgs[0], "/"); i >= 0 {
			displayArgs[0] = displayArgs[0][i+1:]
		}
	}
	writeEvent(map[string]any{
		"event":   "start",
		"command": strings.Join(displayArgs, " "),
		"source":  wgIP,
	})

	if err := cmd.Start(); err != nil {
		writeEvent(map[string]any{"event": "error", "detail": "start: " + err.Error()})
		return
	}

	// Stream stdout line-by-line.  Watch for glibc fortify-check aborts
	// (`*** buffer overflow detected *** : terminated`) which Ubuntu's
	// mtr-tiny throws — surface a clean error instead of the abort line.
	buf := make([]byte, 4096)
	leftover := []byte{}
	glibcAbort := false
	for {
		n, err := stdout.Read(buf)
		if n > 0 {
			leftover = append(leftover, buf[:n]...)
			for {
				i := bytesIndexNewline(leftover)
				if i < 0 { break }
				line := strings.TrimRight(string(leftover[:i]), "\r")
				leftover = leftover[i+1:]
				if line == "" { continue }
				if strings.Contains(line, "buffer overflow detected") ||
					strings.Contains(line, "stack smashing detected") {
					glibcAbort = true
					continue
				}
				if !writeEvent(map[string]any{"event": "line", "data": line}) {
					_ = cmd.Process.Kill()
					return
				}
			}
		}
		if err != nil { break }
	}
	if len(leftover) > 0 {
		tail := strings.TrimRight(string(leftover), "\r")
		if !strings.Contains(tail, "buffer overflow detected") &&
			!strings.Contains(tail, "stack smashing detected") {
			writeEvent(map[string]any{"event": "line", "data": tail})
		} else {
			glibcAbort = true
		}
	}
	if glibcAbort && req.Type == "mtr" {
		writeEvent(map[string]any{
			"event":  "error",
			"detail": "mtr crashed with a glibc fortify abort — install full mtr (sudo apt-get install -y mtr) on the collector.",
		})
		_ = cmd.Wait()
		return
	}

	rc := http.NewResponseController(w)
	_ = rc.SetWriteDeadline(time.Now().Add(10 * time.Second))

	exitCode := 0
	if err := cmd.Wait(); err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			exitCode = ee.ExitCode()
		} else {
			writeEvent(map[string]any{"event": "error", "detail": "wait: " + err.Error()})
			return
		}
	}
	writeEvent(map[string]any{"event": "complete", "exit_code": exitCode})
}

func bytesIndexNewline(b []byte) int {
	for i, c := range b {
		if c == '\n' { return i }
	}
	return -1
}

// getOutboundIP returns the IP address used by the host to reach the public
// internet — used to label the "source" of probe events.  Falls back to the
// hostname if no UDP connect succeeds.
func getOutboundIP() (string, error) {
	conn, err := net.Dial("udp", "8.8.8.8:80")
	if err != nil {
		h, _ := os.Hostname()
		return h, err
	}
	defer conn.Close()
	return conn.LocalAddr().(*net.UDPAddr).IP.String(), nil
}
