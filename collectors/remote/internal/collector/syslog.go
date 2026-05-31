package collector

import (
	"bufio"
	"context"
	"fmt"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/rs/zerolog"

	"github.com/purpledurpl075/anthri-mon/collectors/remote/internal/config"
	"github.com/purpledurpl075/anthri-mon/collectors/remote/internal/hub"
)

// SyslogCollector listens for RFC 3164 syslog messages on UDP and TCP, parses
// them, and forwards them to the hub in JSON batches.
type SyslogCollector struct {
	hub         *hub.Client
	cfg         config.SyslogConfig
	fwdCfg      config.ForwardConfig
	devicesByIP map[string]string // mgmt_ip → device_id
	timezone    string            // collector-level IANA timezone (e.g. "America/New_York")
	loc         *time.Location    // cached location for timezone — updated by SetTimezone
	log         zerolog.Logger

	mu  sync.Mutex
	buf []map[string]any
}

// NewSyslogCollector creates a SyslogCollector.
func NewSyslogCollector(
	hubClient *hub.Client,
	cfg config.SyslogConfig,
	fwdCfg config.ForwardConfig,
	devicesByIP map[string]string,
	log zerolog.Logger,
) *SyslogCollector {
	return &SyslogCollector{
		hub:         hubClient,
		cfg:         cfg,
		fwdCfg:      fwdCfg,
		devicesByIP: devicesByIP,
		timezone:    "UTC",
		loc:         time.UTC,
		log:         log.With().Str("component", "syslog_collector").Logger(),
	}
}

// UpdateDevices replaces the IP→device_id map.
func (c *SyslogCollector) UpdateDevices(devicesByIP map[string]string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.devicesByIP = devicesByIP
}

// SetTimezone updates the IANA timezone used to interpret RFC 3164 timestamps.
// Called whenever the collector config is refreshed from the hub.
func (c *SyslogCollector) SetTimezone(tz string) {
	if tz == "" {
		tz = "UTC"
	}
	loc := loadLocation(tz)
	c.mu.Lock()
	c.timezone = tz
	c.loc = loc
	c.mu.Unlock()
	c.log.Info().Str("timezone", tz).Msg("syslog timezone updated")
}

// Run starts UDP and TCP listeners and the flush loop.
// It blocks until ctx is cancelled and all listeners have exited.
func (c *SyslogCollector) Run(ctx context.Context) {
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); c.listenUDP(ctx) }()
	go func() { defer wg.Done(); c.listenTCP(ctx) }()
	c.flushLoop(ctx)
	wg.Wait()
}

// ─── UDP listener ─────────────────────────────────────────────────────────────

func (c *SyslogCollector) listenUDP(ctx context.Context) {
	conn, err := net.ListenPacket("udp", c.cfg.UDPAddr)
	if err != nil {
		c.log.Error().Err(err).Str("addr", c.cfg.UDPAddr).Msg("udp listen failed")
		return
	}
	defer conn.Close()
	c.log.Info().Str("addr", c.cfg.UDPAddr).Msg("syslog udp listening")

	buf := make([]byte, 65535)
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}
		_ = conn.SetReadDeadline(time.Now().Add(time.Second))
		n, src, err := conn.ReadFrom(buf)
		if err != nil {
			continue
		}
		srcIP := ""
		if ua, ok := src.(*net.UDPAddr); ok {
			srcIP = ua.IP.String()
		}
		c.ingest(string(buf[:n]), srcIP)
	}
}

// ─── TCP listener ─────────────────────────────────────────────────────────────

func (c *SyslogCollector) listenTCP(ctx context.Context) {
	ln, err := net.Listen("tcp", c.cfg.TCPAddr)
	if err != nil {
		c.log.Error().Err(err).Str("addr", c.cfg.TCPAddr).Msg("tcp listen failed")
		return
	}
	defer ln.Close()
	c.log.Info().Str("addr", c.cfg.TCPAddr).Msg("syslog tcp listening")

	go func() {
		<-ctx.Done()
		ln.Close()
	}()

	for {
		conn, err := ln.Accept()
		if err != nil {
			select {
			case <-ctx.Done():
				return
			default:
				continue
			}
		}
		go c.handleTCPConn(ctx, conn)
	}
}

func (c *SyslogCollector) handleTCPConn(ctx context.Context, conn net.Conn) {
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Minute))
	srcIP := ""
	if ta, ok := conn.RemoteAddr().(*net.TCPAddr); ok {
		srcIP = ta.IP.String()
	}

	scanner := bufio.NewScanner(conn)
	scanner.Buffer(make([]byte, 65536), 1<<20)
	for scanner.Scan() {
		select {
		case <-ctx.Done():
			return
		default:
		}
		c.ingest(scanner.Text(), srcIP)
	}
	if err := scanner.Err(); err != nil {
		c.log.Debug().Err(err).Str("src", srcIP).Msg("syslog tcp scanner error")
	}
}

// ─── Ingest + parse ───────────────────────────────────────────────────────────

func (c *SyslogCollector) ingest(raw, srcIP string) {
	c.mu.Lock()
	deviceID := c.devicesByIP[srcIP]
	loc := c.loc
	c.mu.Unlock()

	record := parseMessage(raw, srcIP, loc)
	record["device_id"] = deviceID
	record["device_ip"] = srcIP

	c.mu.Lock()
	c.buf = append(c.buf, record)
	overflow := len(c.buf) >= c.fwdCfg.BatchSize
	c.mu.Unlock()

	if overflow {
		go c.flush(context.Background())
	}
}

// loadLocation returns the *time.Location for an IANA timezone name.
// Falls back to UTC on any error.
func loadLocation(name string) *time.Location {
	if name == "" || name == "UTC" {
		return time.UTC
	}
	loc, err := time.LoadLocation(name)
	if err != nil {
		return time.UTC
	}
	return loc
}

// parseMessage dispatches to RFC 5424 or RFC 3164 parsing based on the
// version byte that follows the priority field.
//
// RFC 5424:  <PRI>1 TIMESTAMP HOSTNAME APP-NAME PROCID MSGID SD MSG
// RFC 3164:  <PRI>TIMESTAMP HOSTNAME PROGRAM[PID]: MESSAGE
//
// loc is used only for RFC 3164 timestamps (which carry no timezone).
func parseMessage(raw, srcIP string, loc *time.Location) map[string]any {
	record := map[string]any{
		"facility": 0,
		"severity": 0,
		"ts":       time.Now().UTC().Format(time.RFC3339),
		"hostname": srcIP,
		"program":  "",
		"pid":      "",
		"message":  raw,
		"raw":      raw,
	}

	s := raw

	facility, severity, rest, ok := parsePriority(s)
	if ok {
		record["facility"] = facility
		record["severity"] = severity
		s = rest
	}

	// RFC 5424 version byte "1 " immediately follows the priority.
	if len(s) >= 2 && s[0] == '1' && s[1] == ' ' {
		parse5424(s[2:], record)
		return record
	}

	// RFC 3164 fallback.
	ts, rest2, ok2 := parseTimestamp(s, loc)
	if ok2 {
		record["ts"] = ts
		s = rest2
	}

	parts := strings.SplitN(s, " ", 3)
	if len(parts) >= 1 {
		record["hostname"] = strings.TrimSpace(parts[0])
	}
	if len(parts) >= 2 {
		prog, pid := splitProgPID(parts[1])
		record["program"] = prog
		record["pid"] = pid
	}
	if len(parts) >= 3 {
		msg := strings.TrimPrefix(parts[2], ": ")
		record["message"] = strings.TrimSpace(msg)
	}

	return record
}

// parse5424 fills record with the fields parsed from the body of an RFC 5424
// message — the portion after "<PRI>1 " has already been stripped.
//
// Grammar (per RFC 5424 §6):
//
//	TIMESTAMP SP HOSTNAME SP APP-NAME SP PROCID SP MSGID SP STRUCTURED-DATA [SP MSG]
//
// Any field may be the nil value "-".
func parse5424(body string, record map[string]any) {
	s := body

	// next returns the next SP-delimited token and advances s past it.
	next := func() string {
		if i := strings.IndexByte(s, ' '); i >= 0 {
			tok := s[:i]
			s = s[i+1:]
			return tok
		}
		tok := s
		s = ""
		return tok
	}

	nilOrStr := func(tok string) string {
		if tok == "-" {
			return ""
		}
		return tok
	}

	// TIMESTAMP — RFC 3339 with sub-second precision and timezone offset.
	tsTok := next()
	if tsTok != "-" {
		for _, layout := range []string{time.RFC3339Nano, time.RFC3339} {
			if t, err := time.Parse(layout, tsTok); err == nil {
				record["ts"] = t.UTC().Format(time.RFC3339)
				break
			}
		}
	}

	record["hostname"] = nilOrStr(next()) // HOSTNAME
	record["program"] = nilOrStr(next())  // APP-NAME
	record["pid"] = nilOrStr(next())      // PROCID
	next()                                // MSGID — not stored

	// STRUCTURED-DATA: either "-" or one or more "[ID KEY="VAL" ...]" blocks.
	s = skipSD(s)

	// MSG (optional): strip leading UTF-8 BOM that some implementations add.
	msg := strings.TrimPrefix(s, "\xef\xbb\xbf")
	if msg != "" {
		record["message"] = msg
	}
}

// skipSD advances past all structured-data elements in an RFC 5424 message
// and returns the remaining string (the message body, or "").
func skipSD(s string) string {
	if len(s) == 0 {
		return ""
	}
	// Nil SD.
	if s[0] == '-' {
		s = s[1:]
		if len(s) > 0 && s[0] == ' ' {
			s = s[1:]
		}
		return s
	}
	// One or more "[…]" SD elements.
	for len(s) > 0 && s[0] == '[' {
		depth, i := 0, 0
		for i < len(s) {
			switch s[i] {
			case '[':
				depth++
			case ']':
				depth--
				if depth == 0 {
					i++
					s = s[i:]
					if len(s) > 0 && s[0] == ' ' {
						s = s[1:]
					}
					goto nextElement
				}
			case '\\':
				i++ // skip escaped character inside param-value
			}
			i++
		}
		return "" // unterminated SD element — discard rest
	nextElement:
	}
	return s
}

func parsePriority(s string) (facility, severity int, rest string, ok bool) {
	if len(s) < 3 || s[0] != '<' {
		return 0, 0, s, false
	}
	end := strings.IndexByte(s, '>')
	if end < 0 {
		return 0, 0, s, false
	}
	pri, err := strconv.Atoi(s[1:end])
	if err != nil {
		return 0, 0, s, false
	}
	return pri >> 3, pri & 7, strings.TrimSpace(s[end+1:]), true
}

func parseTimestamp(s string, loc *time.Location) (ts, rest string, ok bool) {
	if len(s) >= 19 {
		t, err := time.Parse(time.RFC3339, s[:19])
		if err == nil {
			return t.UTC().Format(time.RFC3339), strings.TrimSpace(s[19:]), true
		}
	}

	if len(s) >= 15 {
		for _, layout := range []string{"Jan  2 15:04:05", "Jan 02 15:04:05"} {
			t, err := time.Parse(layout, s[:15])
			if err != nil {
				continue
			}
			now := time.Now().In(loc)
			year := now.Year()
			if t.Month() == time.December && now.Month() == time.January {
				year--
			}
			t = time.Date(year, t.Month(), t.Day(), t.Hour(), t.Minute(), t.Second(), 0, loc)
			return t.UTC().Format(time.RFC3339), strings.TrimSpace(s[15:]), true
		}
	}

	return "", s, false
}

func splitProgPID(token string) (prog, pid string) {
	token = strings.TrimSuffix(token, ":")
	if idx := strings.Index(token, "["); idx >= 0 {
		prog = token[:idx]
		pid = strings.Trim(token[idx:], "[]")
		return
	}
	return token, ""
}

// ─── Flush ────────────────────────────────────────────────────────────────────

func (c *SyslogCollector) flushLoop(ctx context.Context) {
	interval := time.Duration(c.fwdCfg.FlushIntervalS) * time.Second
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			c.flush(context.Background())
			return
		case <-ticker.C:
			c.flush(ctx)
		}
	}
}

func (c *SyslogCollector) flush(ctx context.Context) {
	c.mu.Lock()
	if len(c.buf) == 0 {
		c.mu.Unlock()
		return
	}
	batch := c.buf
	c.buf = nil
	c.mu.Unlock()

	if err := c.hub.PostSyslog(ctx, batch); err != nil {
		c.log.Error().Err(err).Int("records", len(batch)).Msg("failed to post syslog")
	} else {
		c.log.Debug().Int("records", len(batch)).
			Str("sample", fmt.Sprintf("%v", batch[0]["message"])).Msg("syslog posted")
	}
}
