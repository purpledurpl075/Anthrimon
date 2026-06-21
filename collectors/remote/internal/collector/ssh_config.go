// Package collector — SSH configuration backup collector.
//
// SSHConfigCollector periodically connects to each assigned device via SSH,
// runs the appropriate "show running-config" command (vendor-specific), and
// posts the result to the hub via POST /api/v1/collectors/config-backup.
//
// The hub stores it, diffs it against the previous snapshot, and fires
// config-change alerts when the configuration has changed.
package collector

import (
	"context"
	"fmt"
	"io"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/rs/zerolog"
	"golang.org/x/crypto/ssh"

	"github.com/purpledurpl075/anthri-mon/collectors/remote/internal/hub"
	"github.com/purpledurpl075/anthri-mon/collectors/remote/internal/sshtofu"
)

// ── Vendor tables ─────────────────────────────────────────────────────────────

var (
	// showRunCmd maps vendor string → CLI command to fetch the running config.
	showRunCmd = map[string]string{
		"arista":      "show running-config",
		"cisco_ios":   "show running-config",
		"cisco_iosxe": "show running-config",
		"cisco_iosxr": "show running-config all",
		"cisco_nxos":  "show running-config",
		"juniper":     "show configuration | display set",
		"hp_procurve": "show running-config",
		"procurve":    "show running-config",
		"aruba_cx":    "show running-config",
		"fortios":     "show full-configuration",
		"ubiquiti":    "cat /tmp/system.cfg",
	}

	// noPagerCmd disables pagination before running the show command.
	noPagerCmd = map[string]string{
		"arista":      "terminal length 0",
		"cisco_ios":   "terminal length 0",
		"cisco_iosxe": "terminal length 0",
		"cisco_iosxr": "terminal length 0",
		"cisco_nxos":  "terminal length 0",
		"hp_procurve": "no page",
		"procurve":    "no page",
		"aruba_cx":    "no page",
		"juniper":     "set cli screen-length 0",
	}

	// needsEnable lists vendors that require entering privileged exec mode.
	// ArubaOS-CX uses RBAC — admin credentials log in at full privilege already.
	needsEnable = map[string]bool{
		"arista":      true,
		"cisco_ios":   true,
		"cisco_iosxe": true,
		"cisco_iosxr": true,
		"cisco_nxos":  true,
		"hp_procurve": true,
		"procurve":    true,
	}
)

// promptRE matches a line ending with a network device shell prompt (# or >).
var (
	promptRE   = regexp.MustCompile(`[#>]\s*$`)
	passwordRE = regexp.MustCompile(`(?i)password\s*:`)
	moreRE     = regexp.MustCompile(`(?i)--\s*[Mm]ore\s*--`)
	ansiRE     = regexp.MustCompile(`\x1b\[[0-9;]*[a-zA-Z]`)
	// bannerNoiseRE matches header lines that are CLI framing, not real config.
	// These vary between captures (timestamps, byte counts, session metadata)
	// and produce spurious diffs. Mirrors _BANNER_NOISE in configmgmt/collector.py.
	bannerNoiseRE = regexp.MustCompile(`(?i)^(` +
		`Building configuration|Current configuration` +
		`|[!;#]+\s*Command[\s:]` + // Arista/NX-OS command echo
		`|[!#]+\s*Last configuration change` + // Cisco timestamp
		`|[!#]+\s*NVRAM config` + // Cisco NVRAM timestamp
		`|!!?\s*IOS XR Configuration` + // IOS-XR byte-count header
		`|[!#]+\s*Time:\s` + // NX-OS per-capture timestamp
		`|[!#]+\s*Startup database` + // NX-OS startup-DB timestamp
		`|#+\s*Last changed:` + // Juniper timestamp
		`|;\s*[A-Z]\w+\s+Configuration Editor` + // ProCurve model header
		`|;\s*Ver\s+#` + // ProCurve firmware header
		`|#config-version=` + // FortiOS build/version line
		`)`)
)

// ── SSHConfigCollector ────────────────────────────────────────────────────────

// SSHConfigCollector periodically fetches device running-configurations via SSH.
type SSHConfigCollector struct {
	hubClient     *hub.Client
	mu            sync.RWMutex
	devices       []hub.Device
	lastCollected map[string]time.Time
	logger        zerolog.Logger
}

// NewSSHConfigCollector creates a new SSH config collector.
func NewSSHConfigCollector(hubClient *hub.Client, logger zerolog.Logger) *SSHConfigCollector {
	return &SSHConfigCollector{
		hubClient:     hubClient,
		lastCollected: make(map[string]time.Time),
		logger:        logger.With().Str("subsystem", "ssh_config").Logger(),
	}
}

// SetDevices replaces the current device list.
func (c *SSHConfigCollector) SetDevices(devices []hub.Device) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.devices = devices
}

// Run starts the periodic collection loop.
// It waits 90 s on startup (letting SNMP settle) then collects every 10 min,
// skipping devices whose per-device interval hasn't elapsed.
func (c *SSHConfigCollector) Run(ctx context.Context) {
	// Wait for SNMP to establish before first collection.
	select {
	case <-ctx.Done():
		return
	case <-time.After(90 * time.Second):
	}

	ticker := time.NewTicker(10 * time.Minute)
	defer ticker.Stop()

	c.collectDue(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			c.collectDue(ctx)
		}
	}
}

// collectDue iterates devices and collects those past their config interval.
func (c *SSHConfigCollector) collectDue(ctx context.Context) {
	c.mu.RLock()
	devices := make([]hub.Device, len(c.devices))
	copy(devices, c.devices)
	c.mu.RUnlock()

	now := time.Now()
	for _, dev := range devices {
		cred := dev.SSHCredential()
		if cred == nil {
			continue // no SSH credentials — skip
		}

		c.mu.RLock()
		last := c.lastCollected[dev.ID]
		c.mu.RUnlock()

		interval := time.Duration(dev.ConfigIntervalS) * time.Second
		if interval <= 0 {
			interval = time.Hour // default: hourly
		}
		if !last.IsZero() && now.Sub(last) < interval {
			continue // not due yet
		}

		if err := c.collectOne(ctx, dev, cred); err != nil {
			c.logger.Warn().Err(err).
				Str("device", dev.Hostname).
				Msg("ssh config collection failed")
		} else {
			c.mu.Lock()
			c.lastCollected[dev.ID] = time.Now()
			c.mu.Unlock()
		}

		// Brief pause between devices to avoid SSH connection storms.
		select {
		case <-ctx.Done():
			return
		case <-time.After(2 * time.Second):
		}
	}
}

// collectOne collects the running config for one device and posts it to the hub.
func (c *SSHConfigCollector) collectOne(ctx context.Context, dev hub.Device, cred *hub.Credential) error {
	username, _ := cred.Data["username"].(string)
	password, _ := cred.Data["password"].(string)
	enablePass, _ := cred.Data["enable_secret"].(string)
	if enablePass == "" {
		enablePass = password // common fallback
	}

	vendor := normalizeVendor(dev.Vendor)
	showCmd := showRunCmd[vendor]
	if showCmd == "" {
		showCmd = "show running-config"
	}

	c.logger.Debug().
		Str("device", dev.Hostname).
		Str("vendor", vendor).
		Msg("collecting ssh config")

	configText, err := sshCollect(dev.MgmtIP, 22, username, password, enablePass, vendor, showCmd)
	if err != nil {
		return fmt.Errorf("ssh collect: %w", err)
	}
	if len(configText) < 50 {
		return fmt.Errorf("config output too short (%d bytes) — likely an error", len(configText))
	}

	if err := c.hubClient.PostConfigBackup(ctx, dev.ID, configText, "ssh_show_run"); err != nil {
		return fmt.Errorf("post to hub: %w", err)
	}

	c.logger.Info().
		Str("device", dev.Hostname).
		Int("bytes", len(configText)).
		Msg("config backup posted to hub")

	return nil
}

// vendorMatchOrder lists vendor keys in most-specific-first order so that
// substrings like "cisco_ios" don't accidentally match "cisco_iosxe".
var vendorMatchOrder = []string{
	"cisco_iosxr",
	"cisco_iosxe",
	"cisco_nxos",
	"cisco_ios",
	"hp_procurve",
	"aruba_cx",
	"arista",
	"juniper",
	"procurve",
	"fortios",
	"ubiquiti",
}

// normalizeVendor maps a vendor string (from the hub config) to a key used
// in the showRunCmd / noPagerCmd / needsEnable lookup tables.
func normalizeVendor(v string) string {
	v = strings.ToLower(v)
	for _, k := range vendorMatchOrder {
		if strings.Contains(v, k) {
			return k
		}
	}
	if strings.Contains(v, "arista") || strings.Contains(v, "eos") {
		return "arista"
	}
	if strings.Contains(v, "cisco") {
		return "cisco_ios"
	}
	return "cisco_ios" // safe fallback
}

// ── SSH transport ─────────────────────────────────────────────────────────────

// sshCollect opens an SSH connection and returns the device running-config text.
func sshCollect(
	host string, port int,
	username, password, enablePass, vendor, showCmd string,
) (string, error) {
	sshCfg := &ssh.ClientConfig{
		User: username,
		Auth: []ssh.AuthMethod{
			ssh.Password(password),
			// Some devices use keyboard-interactive for password auth.
			ssh.KeyboardInteractive(func(_, _ string, questions []string, _ []bool) ([]string, error) {
				answers := make([]string, len(questions))
				for i := range questions {
					answers[i] = password
				}
				return answers, nil
			}),
		},
		HostKeyCallback: sshtofu.HostKeyCallback(),
		Timeout:         30 * time.Second,
	}

	client, err := ssh.Dial("tcp", fmt.Sprintf("%s:%d", host, port), sshCfg)
	if err != nil {
		return "", fmt.Errorf("dial %s:%d: %w", host, port, err)
	}
	defer client.Close()

	return collectViaShell(client, vendor, enablePass, showCmd)
}

// collectViaShell opens a PTY interactive shell on the SSH connection,
// disables pagination, optionally enters privileged exec mode, runs the
// show command, and returns the clean configuration output.
func collectViaShell(client *ssh.Client, vendor, enablePass, showCmd string) (string, error) {
	session, err := client.NewSession()
	if err != nil {
		return "", fmt.Errorf("new session: %w", err)
	}
	defer session.Close()

	modes := ssh.TerminalModes{
		ssh.ECHO:          0, // no echo
		ssh.TTY_OP_ISPEED: 9600,
		ssh.TTY_OP_OSPEED: 9600,
	}
	if err := session.RequestPty("vt100", 200, 200, modes); err != nil {
		return "", fmt.Errorf("request pty: %w", err)
	}

	stdin, err := session.StdinPipe()
	if err != nil {
		return "", fmt.Errorf("stdin pipe: %w", err)
	}
	stdoutPipe, err := session.StdoutPipe()
	if err != nil {
		return "", fmt.Errorf("stdout pipe: %w", err)
	}
	if err := session.Shell(); err != nil {
		return "", fmt.Errorf("start shell: %w", err)
	}

	cr := newChanReader(stdoutPipe)

	// 1. Wait for the initial prompt.
	if _, err := cr.readUntilPrompt(20 * time.Second); err != nil {
		return "", fmt.Errorf("initial prompt timeout: %w", err)
	}

	// 2. Disable pagination so the full config comes back without --More--.
	if cmd, ok := noPagerCmd[vendor]; ok && cmd != "" {
		fmt.Fprintf(stdin, "%s\n", cmd)
		cr.readUntilPrompt(10 * time.Second) //nolint:errcheck — non-fatal
	}

	// 3. Enter enable / privileged exec mode if required.
	if needsEnable[vendor] {
		fmt.Fprintf(stdin, "enable\n")
		out, _ := cr.readUntil(regexp.MustCompile(`[#>:]\s*$`), 10*time.Second)
		if passwordRE.MatchString(out) {
			// Device prompted for an enable password.
			fmt.Fprintf(stdin, "%s\n", enablePass)
			cr.readUntilPrompt(10 * time.Second) //nolint:errcheck
		}
		// If already at priv 15 the prompt reappears immediately — that's fine.
	}

	// 4. Send the show command.
	fmt.Fprintf(stdin, "%s\n", showCmd)

	// 5. Read the config output, handling --More-- pagination and the trailing prompt.
	var outputBuf strings.Builder
	deadline := time.After(90 * time.Second)

READLOOP:
	for {
		select {
		case data, ok := <-cr.ch:
			if !ok {
				break READLOOP
			}
			// Strip ANSI escape codes emitted by some devices.
			chunk := ansiRE.ReplaceAllString(string(data), "")
			outputBuf.WriteString(chunk)

			s := outputBuf.String()
			lines := strings.Split(strings.TrimRight(s, "\r\n "), "\n")
			lastLine := ""
			if len(lines) > 0 {
				lastLine = strings.TrimRight(lines[len(lines)-1], "\r ")
			}

			// Dismiss --More-- by sending a space.
			if moreRE.MatchString(lastLine) {
				fmt.Fprintf(stdin, " ")
				continue
			}

			// Stop when the device prompt reappears.
			if promptRE.MatchString(lastLine) {
				break READLOOP
			}

			// Safety limit: 2 MB
			if outputBuf.Len() > 2*1024*1024 {
				break READLOOP
			}

		case <-deadline:
			break READLOOP
		}
	}

	return cleanOutput(outputBuf.String(), showCmd), nil
}

// cleanOutput normalises line endings, strips the command echo if present, and
// removes the trailing shell prompt from captured device output.
//
// Some devices (e.g. ArubaOS-CX) do not echo the typed command back over the
// PTY; in that case the output starts directly with the config.  If no command
// echo is found we fall through and include all lines up to the trailing prompt.
func cleanOutput(raw, cmd string) string {
	// Normalise CR+LF → LF.
	raw = strings.ReplaceAll(raw, "\r\n", "\n")
	raw = strings.ReplaceAll(raw, "\r", "\n")

	lines := strings.Split(raw, "\n")
	cmdFirst := strings.Split(cmd, " ")[0]

	var out []string
	started := false
	for _, line := range lines {
		stripped := strings.TrimRight(line, " \t")

		if !started {
			// Skip lines up to and including the command echo.
			if strings.Contains(stripped, cmd) || strings.Contains(stripped, cmdFirst) {
				started = true
			}
			continue
		}

		if promptRE.MatchString(stripped) {
			break
		}
		if bannerNoiseRE.MatchString(stripped) {
			continue
		}
		out = append(out, stripped)
	}

	// Device didn't echo the command — include everything up to the trailing prompt.
	if !started {
		out = out[:0]
		for _, line := range lines {
			stripped := strings.TrimRight(line, " \t")
			if promptRE.MatchString(stripped) {
				break
			}
			if bannerNoiseRE.MatchString(stripped) {
				continue
			}
			out = append(out, stripped)
		}
	}

	// Strip session-noise words that can leak to the head of the buffer when
	// the SSH channel drains across command boundaries (e.g. vEOS with ECHO:0).
	for len(out) > 0 && (out[0] == "exit" || out[0] == "quit" || out[0] == "logout") {
		out = out[1:]
	}

	return strings.TrimSpace(strings.Join(out, "\n"))
}

// ── Channel-based async reader ────────────────────────────────────────────────
//
// Spawns a goroutine that continuously reads from r into a buffered channel.
// readUntil / readUntilPrompt consume from the channel with a timeout.
// The goroutine exits (and closes the channel) when r returns an error (EOF).

type chanReader struct {
	ch chan []byte
}

func newChanReader(r io.Reader) *chanReader {
	cr := &chanReader{ch: make(chan []byte, 512)}
	go func() {
		defer close(cr.ch)
		buf := make([]byte, 4096)
		for {
			n, err := r.Read(buf)
			if n > 0 {
				data := make([]byte, n)
				copy(data, buf[:n])
				cr.ch <- data
			}
			if err != nil {
				return
			}
		}
	}()
	return cr
}

// readUntilPrompt reads until promptRE matches the last (non-whitespace) line.
func (cr *chanReader) readUntilPrompt(timeout time.Duration) (string, error) {
	return cr.readUntil(promptRE, timeout)
}

// readUntil reads until pattern matches the last non-whitespace line, or timeout.
func (cr *chanReader) readUntil(pattern *regexp.Regexp, timeout time.Duration) (string, error) {
	var buf strings.Builder
	deadline := time.After(timeout)
	for {
		select {
		case data, ok := <-cr.ch:
			if !ok {
				return buf.String(), io.EOF
			}
			buf.Write(data)
			s := strings.TrimRight(buf.String(), " \t\r\n")
			lines := strings.Split(s, "\n")
			if len(lines) > 0 {
				lastLine := strings.TrimRight(lines[len(lines)-1], "\r ")
				if pattern.MatchString(lastLine) {
					return buf.String(), nil
				}
			}
		case <-deadline:
			return buf.String(), fmt.Errorf("timeout waiting for prompt")
		}
	}
}
