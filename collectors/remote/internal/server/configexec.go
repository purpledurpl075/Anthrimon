package server

// config-exec: the collector-side executor for hub-delegated config operations.
//
// For devices behind a remote collector, the hub can't SSH to the device (it's
// on a remote LAN) and the device can't reach the hub.  The collector sits on
// the device's LAN, so the hub ships it a recipe (and, for rollback, the config
// text) and the collector does the work: it SSHes the device, runs the recipe's
// send/expect steps, and — when serving a rollback — hosts a one-shot HTTP
// server on its own device-facing IP that the device pulls the config from.
//
// All vendor logic lives on the hub.  This file is a generic "SSH a sequence of
// steps, optionally host one file" executor — it has no per-vendor knowledge.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"

	"github.com/purpledurpl075/anthri-mon/collectors/remote/internal/sshtofu"
)

// configStep is one send/expect interaction.  A literal "{{URL}}" in Command is
// replaced with the URL of the one-shot config server (rollback only).
// Expect2/Response2/Delay2 are an optional second prompt/response pair,
// checked against the latest output after Expect/Response is handled (or
// against the first read if Expect didn't match) -- used by AOS-CX's SFTP
// rollback recipe, whose host-key-trust prompt is sometimes skipped, leaving
// only the password prompt. A literal "{{SFTP_PASSWORD}}" in Response2 (or
// Command) is replaced with the one-shot SFTP server's password.
// MinWait, if > 0, overrides the default floor (400ms) before readFor's
// idle-exit check kicks in for this step's first read and its post-Response
// read -- needed for commands like AOS-CX's SFTP copy, which echo
// immediately but then go silent for over a second before their real output
// (a progress spinner) starts.
type configStep struct {
	Command   string  `json:"command"`
	Expect    string  `json:"expect"`
	Response  string  `json:"response"`
	Delay     float64 `json:"delay"`
	Expect2   string  `json:"expect2"`
	Response2 string  `json:"response2"`
	Delay2    float64 `json:"delay2"`
	MinWait   float64 `json:"min_wait"`
}

// configExecReq is the POST body for /config-exec.
type configExecReq struct {
	Operation      string       `json:"operation"` // backup | deploy | rollback (informational)
	DeviceIP       string       `json:"device_ip"`
	SSHPort        int          `json:"ssh_port"`
	Vendor         string       `json:"vendor"`
	Username       string       `json:"username"`
	Password       string       `json:"password"`
	EnableSecret   string       `json:"enable_secret"`
	EnterEnable    bool         `json:"enter_enable"`
	Steps          []configStep `json:"steps"`
	FinalRead      string       `json:"final_read_command"`
	ServeConfig    string       `json:"serve_config"`
	ServeTransport string       `json:"serve_transport"` // "http" (default) | "sftp"
	ExpectedSrcIP  string       `json:"expected_source_ip"`
}

type configExecResp struct {
	Output       string `json:"output"`
	ConfigServed bool   `json:"config_served"`
}

// ── thread-safe growing buffer for the shell's combined output ────────────────

type safeBuf struct {
	mu sync.Mutex
	b  []byte
}

func (s *safeBuf) Write(p []byte) (int, error) {
	s.mu.Lock()
	s.b = append(s.b, p...)
	s.mu.Unlock()
	return len(p), nil
}

func (s *safeBuf) len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.b)
}

func (s *safeBuf) from(i int) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if i < 0 {
		i = 0
	}
	if i > len(s.b) {
		i = len(s.b)
	}
	return string(s.b[i:])
}

func (s *safeBuf) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return string(s.b)
}

// ── one-shot config server (mirror of the hub's serve_rollback) ───────────────

type configServer struct {
	url    string
	srv    *http.Server
	mu     sync.Mutex
	served bool
}

func (cs *configServer) wasServed() bool {
	cs.mu.Lock()
	defer cs.mu.Unlock()
	return cs.served
}

func (cs *configServer) shutdown() {
	if cs.srv != nil {
		_ = cs.srv.Close()
	}
}

// outboundIPTo returns the local source IP the kernel would use to reach dst —
// i.e. the collector's device-facing IP for this device.
func outboundIPTo(dst string) string {
	conn, err := net.Dial("udp", net.JoinHostPort(dst, "9"))
	if err != nil {
		if ip, e2 := getOutboundIP(); e2 == nil {
			return ip
		}
		return "0.0.0.0"
	}
	defer conn.Close()
	return conn.LocalAddr().(*net.UDPAddr).IP.String()
}

// startConfigServer hosts `text` on the device-facing IP (ports 5050-5054) at a
// random token path, served exactly once, only to expectedSrc.
func startConfigServer(deviceIP, expectedSrc, text string) (*configServer, error) {
	bindIP := outboundIPTo(deviceIP)
	var ln net.Listener
	var port int
	for p := 5050; p <= 5054; p++ {
		l, err := net.Listen("tcp", fmt.Sprintf("%s:%d", bindIP, p))
		if err == nil {
			ln, port = l, p
			break
		}
	}
	if ln == nil {
		return nil, fmt.Errorf("no free port in 5050-5054 on %s", bindIP)
	}

	tok := make([]byte, 16)
	if _, err := rand.Read(tok); err != nil {
		_ = ln.Close()
		return nil, err
	}
	token := hex.EncodeToString(tok)

	cs := &configServer{}
	cs.url = fmt.Sprintf("http://%s:%d/%s", bindIP, port, token)

	mux := http.NewServeMux()
	mux.HandleFunc("/"+token, func(w http.ResponseWriter, r *http.Request) {
		peer := r.RemoteAddr
		if h, _, err := net.SplitHostPort(peer); err == nil {
			peer = h
		}
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			peer = strings.TrimSpace(strings.Split(xff, ",")[0])
		}
		if expectedSrc != "" && peer != expectedSrc {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		cs.mu.Lock()
		if cs.served {
			cs.mu.Unlock()
			http.NotFound(w, r)
			return
		}
		cs.served = true
		cs.mu.Unlock()
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = io.WriteString(w, text)
	})

	cs.srv = &http.Server{Handler: mux}
	go func() { _ = cs.srv.Serve(ln) }()
	return cs, nil
}

// ── SSH session executor ──────────────────────────────────────────────────────

func runConfigSession(ctx context.Context, req *configExecReq, serveURL, sftpPassword string) (string, error) {
	port := req.SSHPort
	if port == 0 {
		port = 22
	}

	cfg := &ssh.ClientConfig{
		User:            req.Username,
		HostKeyCallback: sshtofu.HostKeyCallback(),
		Timeout:         30 * time.Second,
	}
	if req.Password != "" {
		cfg.Auth = append(cfg.Auth,
			ssh.Password(req.Password),
			ssh.KeyboardInteractive(func(_, _ string, questions []string, _ []bool) ([]string, error) {
				ans := make([]string, len(questions))
				for i := range ans {
					ans[i] = req.Password
				}
				return ans, nil
			}),
		)
	}

	addr := net.JoinHostPort(req.DeviceIP, fmt.Sprintf("%d", port))
	client, err := ssh.Dial("tcp", addr, cfg)
	if err != nil {
		return "", fmt.Errorf("ssh dial %s: %w", addr, err)
	}
	defer client.Close()

	session, err := client.NewSession()
	if err != nil {
		return "", fmt.Errorf("ssh session: %w", err)
	}
	defer session.Close()

	// Tall PTY so the device doesn't paginate ("--More--") on long output.
	modes := ssh.TerminalModes{ssh.ECHO: 0, ssh.TTY_OP_ISPEED: 14400, ssh.TTY_OP_OSPEED: 14400}
	if err := session.RequestPty("vt100", 1000, 300, modes); err != nil {
		return "", fmt.Errorf("request pty: %w", err)
	}

	stdin, err := session.StdinPipe()
	if err != nil {
		return "", err
	}
	var buf safeBuf
	session.Stdout = &buf
	session.Stderr = &buf
	if err := session.Shell(); err != nil {
		return "", fmt.Errorf("start shell: %w", err)
	}

	write := func(s string) { _, _ = io.WriteString(stdin, s+"\n") }
	const idleGap = 1200 * time.Millisecond        // quiet period that means "done"
	const defaultMinWait = 400 * time.Millisecond  // let the command at least echo
	// readFor returns everything the device emitted since byte offset `start`.
	// `maxWait` is a hard cap; within it we return early once output has started
	// and then gone idle for idleGap — so a `show running-config` that finishes
	// in 3 s doesn't cost the full 30 s cap.  A `start`-relative growth check
	// avoids declaring idle before the device has emitted anything (e.g. while a
	// `configure replace` thinks before printing its confirm prompt).
	// `minWait` is a floor before idle-exit is even considered -- some commands
	// (e.g. AOS-CX's SFTP copy) echo immediately, then pause for over a second
	// before their real output (a progress spinner) starts; a minWait shorter
	// than that pause causes readFor to return with just the echo, before the
	// text Expect is looking for has appeared.
	readFor := func(start int, maxWait float64, minWait time.Duration) string {
		if maxWait <= 0 {
			maxWait = 1.0
		}
		deadline := time.Now().Add(time.Duration(maxWait * float64(time.Second)))
		floor := time.Now().Add(minWait)
		lastLen := buf.len()
		lastGrow := time.Now()
		for time.Now().Before(deadline) {
			select {
			case <-ctx.Done():
				return buf.from(start)
			case <-time.After(150 * time.Millisecond):
			}
			if n := buf.len(); n != lastLen {
				lastLen, lastGrow = n, time.Now()
			}
			if time.Now().After(floor) && buf.len() > start &&
				time.Since(lastGrow) >= idleGap {
				break
			}
		}
		return buf.from(start)
	}

	// Drain the login banner / first prompt.
	readFor(0, 1.5, defaultMinWait)

	if req.EnterEnable {
		start := buf.len()
		write("enable")
		out := readFor(start, 1.5, defaultMinWait)
		if req.EnableSecret != "" && regexp.MustCompile(`(?i)password`).MatchString(out) {
			write(req.EnableSecret)
			readFor(buf.len(), 1.5, defaultMinWait)
		}
	}

	for _, st := range req.Steps {
		cmd := strings.ReplaceAll(st.Command, "{{URL}}", serveURL)
		cmd = strings.ReplaceAll(cmd, "{{SFTP_PASSWORD}}", sftpPassword)
		minWait := defaultMinWait
		if st.MinWait > 0 {
			minWait = time.Duration(st.MinWait * float64(time.Second))
		}
		start := buf.len()
		write(cmd)
		out := readFor(start, st.Delay, minWait)
		if st.Expect != "" {
			if matched, _ := regexp.MatchString("(?i)"+st.Expect, out); matched {
				resp := strings.ReplaceAll(st.Response, "{{SFTP_PASSWORD}}", sftpPassword)
				write(resp)
				out = readFor(buf.len(), st.Delay, minWait)
			}
		}
		if st.Expect2 != "" {
			if matched, _ := regexp.MatchString("(?i)"+st.Expect2, out); matched {
				resp2 := strings.ReplaceAll(st.Response2, "{{SFTP_PASSWORD}}", sftpPassword)
				write(resp2)
				readFor(buf.len(), st.Delay2, defaultMinWait)
			}
		}
	}

	if req.FinalRead != "" {
		start := buf.len()
		write(req.FinalRead)
		readFor(start, 30, defaultMinWait)
	}

	write("exit")
	readFor(buf.len(), 0.5, defaultMinWait)
	_ = session.Close()

	return buf.String(), nil
}

// ── handler ───────────────────────────────────────────────────────────────────

func (s *Server) handleConfigExec(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.checkAuth(w, r) {
		return
	}

	var req configExecReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}
	if req.DeviceIP == "" || req.Username == "" {
		http.Error(w, "device_ip and username are required", http.StatusBadRequest)
		return
	}
	if net.ParseIP(req.DeviceIP) == nil {
		http.Error(w, "device_ip is not a valid IP", http.StatusBadRequest)
		return
	}

	s.log.Info().
		Str("op", req.Operation).
		Str("device", req.DeviceIP).
		Int("steps", len(req.Steps)).
		Bool("serve", req.ServeConfig != "").
		Msg("config-exec requested")

	serveURL := ""
	sftpPassword := ""
	var wasServed func() bool
	if req.ServeConfig != "" {
		if req.ServeTransport == "sftp" {
			ss, err := startSFTPServer(req.DeviceIP, req.ExpectedSrcIP, req.ServeConfig)
			if err != nil {
				http.Error(w, "config server: "+err.Error(), http.StatusInternalServerError)
				return
			}
			serveURL, sftpPassword, wasServed = ss.url, ss.password, ss.wasServed
			defer ss.shutdown()
		} else {
			cs, err := startConfigServer(req.DeviceIP, req.ExpectedSrcIP, req.ServeConfig)
			if err != nil {
				http.Error(w, "config server: "+err.Error(), http.StatusInternalServerError)
				return
			}
			serveURL, wasServed = cs.url, cs.wasServed
			defer cs.shutdown()
		}
	}

	out, err := runConfigSession(r.Context(), &req, serveURL, sftpPassword)
	served := wasServed != nil && wasServed()
	if err != nil {
		s.log.Warn().Err(err).Str("device", req.DeviceIP).Msg("config-exec failed")
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadGateway)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"error":         err.Error(),
			"output":        out,
			"config_served": served,
		})
		return
	}

	s.log.Info().Str("device", req.DeviceIP).Bool("served", served).Msg("config-exec complete")
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(configExecResp{Output: out, ConfigServed: served})
}
