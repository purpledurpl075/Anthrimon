// trap-handler is invoked by snmptrapd for each received SNMP trap.
//
// snmptrapd passes the decoded trap via stdin:
//
//	Line 1: sender hostname or IP address
//	Line 2: transport string, e.g. "UDP: [10.0.0.1]:1234->[0.0.0.0]:162"
//	Lines 3+: ".OID = TYPE: VALUE" (one varbind per line, numeric OIDs)
//
// The handler normalises the varbinds, resolves the trap OID to a human
// name and severity, and POSTs a single event to the hub's trap-ingest
// endpoint.  v1 traps are pre-normalised to v2c format by snmptrapd before
// the handler is invoked.
//
// Configuration (environment variables):
//
//	ANTHRIMON_TRAP_HUB_URL   Hub base URL (default "http://127.0.0.1:8001")
//	ANTHRIMON_TRAP_API_KEY   Collector API key (required)
package main

import (
	"bufio"
	"bytes"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"
)

const version = "0.1.4"

const defaultCACertPath = "/etc/anthrimon/ca.crt"

// tlsTransport returns an http.Transport that trusts the Anthrimon hub CA cert
// if present, falling back to the system pool.
func tlsTransport() *http.Transport {
	pool, _ := x509.SystemCertPool()
	if pool == nil {
		pool = x509.NewCertPool()
	}
	if pem, err := os.ReadFile(defaultCACertPath); err == nil {
		pool.AppendCertsFromPEM(pem)
	}
	return &http.Transport{
		TLSClientConfig: &tls.Config{
			RootCAs:    pool,
			MinVersion: tls.VersionTLS12,
		},
	}
}

// ── OID → trap type / severity ────────────────────────────────────────────────

var _standardTraps = map[string]trapMeta{
	"1.3.6.1.6.3.1.1.5.1": {Name: "coldStart",             Severity: "warning"},
	"1.3.6.1.6.3.1.1.5.2": {Name: "warmStart",             Severity: "info"},
	"1.3.6.1.6.3.1.1.5.3": {Name: "linkDown",              Severity: "critical"},
	"1.3.6.1.6.3.1.1.5.4": {Name: "linkUp",                Severity: "info"},
	"1.3.6.1.6.3.1.1.5.5": {Name: "authenticationFailure", Severity: "warning"},
	"1.3.6.1.6.3.1.1.5.6": {Name: "egpNeighborLoss",       Severity: "warning"},
}

var _enterpriseTraps = []enterpriseTrap{
	{Prefix: "1.3.6.1.4.1.30065.3.9",      Name: "arista.bgpPeerStateChange",   Severity: "warning"},
	{Prefix: "1.3.6.1.4.1.30065.3.10",     Name: "arista.linkStateChange",      Severity: "warning"},
	{Prefix: "1.3.6.1.4.1.30065.",         Name: "arista.trap",                 Severity: "info"},
	{Prefix: "1.3.6.1.4.1.47196.4.1.1.3.20", Name: "aruba_cx.linkStateChange", Severity: "warning"},
	{Prefix: "1.3.6.1.4.1.47196.",         Name: "aruba_cx.trap",               Severity: "info"},
	{Prefix: "1.3.6.1.4.1.11.2.14.12.1",  Name: "hp.linkChange",               Severity: "warning"},
	{Prefix: "1.3.6.1.4.1.11.2.",         Name: "hp.trap",                      Severity: "info"},
	{Prefix: "1.3.6.1.4.1.9.9.187.",      Name: "cisco.bgpBackwardTransition",  Severity: "critical"},
	{Prefix: "1.3.6.1.4.1.9.",            Name: "cisco.trap",                   Severity: "info"},
	{Prefix: "1.3.6.1.4.1.2636.",         Name: "juniper.trap",                 Severity: "info"},
}

type trapMeta struct {
	Name     string
	Severity string
}

type enterpriseTrap struct {
	Prefix   string
	Name     string
	Severity string
}

func resolveTrapType(oid string) trapMeta {
	if m, ok := _standardTraps[oid]; ok {
		return m
	}
	best := trapMeta{Name: "unknown", Severity: "info"}
	bestLen := 0
	for _, et := range _enterpriseTraps {
		if strings.HasPrefix(oid, et.Prefix) && len(et.Prefix) > bestLen {
			best = trapMeta{Name: et.Name, Severity: et.Severity}
			bestLen = len(et.Prefix)
		}
	}
	return best
}

// ── stdin parsing ─────────────────────────────────────────────────────────────

// _transportRE extracts the source IP from e.g. "UDP: [10.0.0.1]:1234->[0.0.0.0]:162"
var _transportRE = regexp.MustCompile(`\[([^\]]+)\]:\d+->`)

// sourceIPFromTransport parses the source IP out of the transport line.
// Falls back to the hostname line (line 0) if the pattern doesn't match.
func sourceIPFromTransport(transport, hostname string) string {
	m := _transportRE.FindStringSubmatch(transport)
	if len(m) >= 2 {
		return m[1]
	}
	return hostname
}

const (
	oidSysUpTime = "1.3.6.1.2.1.1.3.0"
	oidTrapOID   = "1.3.6.1.6.3.1.1.4.1.0"
	// snmpTrapCommunity — present in v2c PDUs, absent in v3.
	oidTrapCommunity = "1.3.6.1.6.3.18.1.4.0"
)

type parsedTrap struct {
	sourceIP    string
	trapOID     string
	snmpVersion string
	varbinds    []map[string]any
}

func parseStdin(lines []string) parsedTrap {
	var t parsedTrap
	if len(lines) < 2 {
		return t
	}
	t.sourceIP = sourceIPFromTransport(lines[1], lines[0])
	t.snmpVersion = "v2c" // default; overridden below

	for _, line := range lines[2:] {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		// snmptrapd exec format is either:
		//   ".OID = TYPE: VALUE"  (older/log format)
		//   ".OID VALUE"          (space-only format produced by outputOption n)
		var rawOID, typStr, val string
		if eqIdx := strings.Index(line, " = "); eqIdx >= 0 {
			rawOID = strings.TrimSpace(line[:eqIdx])
			rest := strings.TrimSpace(line[eqIdx+3:])
			if colonIdx := strings.Index(rest, ":"); colonIdx >= 0 {
				typStr = strings.TrimSpace(rest[:colonIdx])
				val = strings.TrimSpace(rest[colonIdx+1:])
			} else {
				typStr = "STRING"
				val = rest
			}
		} else {
			spIdx := strings.IndexByte(line, ' ')
			if spIdx < 0 {
				continue
			}
			rawOID = strings.TrimSpace(line[:spIdx])
			val = strings.TrimSpace(line[spIdx+1:])
			typStr = ""
		}
		oid := strings.TrimPrefix(rawOID, ".")

		// Timeticks: "(12345) 0:02:03.45" → keep only the integer part
		if typStr == "Timeticks" {
			if i := strings.Index(val, "("); i >= 0 {
				if j := strings.Index(val[i:], ")"); j >= 0 {
					val = val[i+1 : i+j]
				}
			}
		}

		// Strip leading dot from OID values (both explicit OID type and bare .OID values)
		if typStr == "OID" || strings.HasPrefix(val, ".") {
			val = strings.TrimPrefix(strings.TrimSpace(val), ".")
		}

		switch oid {
		case oidSysUpTime:
			continue
		case oidTrapOID:
			t.trapOID = val
			continue
		case oidTrapCommunity:
			// Presence confirms v2c (absent in v3 — snmptrapd doesn't inject it for v3)
			t.snmpVersion = "v2c"
			continue
		}

		t.varbinds = append(t.varbinds, map[string]any{
			"oid":   oid,
			"type":  typStr,
			"value": val,
		})
	}

	// If no community OID was seen and no trapOID matched a standard one, it
	// may be v3 — we can't distinguish reliably from the exec format alone, but
	// "v2c" is the correct default since snmptrapd normalises v1→v2c too.
	return t
}

// ── Hub POST ──────────────────────────────────────────────────────────────────

func postToHub(hubURL, apiKey string, t parsedTrap) error {
	if t.trapOID == "" {
		t.trapOID = "unknown"
	}
	meta := resolveTrapType(t.trapOID)

	event := map[string]any{
		"source_ip":    t.sourceIP,
		"device_id":    "",
		"trap_type":    meta.Name,
		"oid":          t.trapOID,
		"severity":     meta.Severity,
		"varbinds":     t.varbinds,
		"snmp_version": t.snmpVersion,
		"received_at":  time.Now().UTC().Format(time.RFC3339Nano),
	}

	payload, _ := json.Marshal(map[string]any{"events": []any{event}})

	req, err := http.NewRequest(http.MethodPost, hubURL+"/api/v1/collectors/traps", bytes.NewReader(payload))
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)

	client := &http.Client{
		Timeout:   10 * time.Second,
		Transport: tlsTransport(),
	}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("post: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		return fmt.Errorf("hub returned HTTP %d", resp.StatusCode)
	}
	return nil
}

// ── Config ────────────────────────────────────────────────────────────────────

// collectorState mirrors the fields we need from the collector state file.
type collectorState struct {
	APIKey       string `json:"api_key"`
	WGAssignedIP string `json:"wg_assigned_ip"`
}

const defaultStatePath = "/etc/anthrimon/collector-state.json"

// loadConfig returns (hubURL, apiKey).  Env vars take precedence; the
// collector state file is the fallback so snmptrapd subprocess invocations
// work without any extra env configuration.
func loadConfig() (string, string, error) {
	hubURL := os.Getenv("ANTHRIMON_TRAP_HUB_URL")
	apiKey := os.Getenv("ANTHRIMON_TRAP_API_KEY")

	if hubURL != "" && apiKey != "" {
		return hubURL, apiKey, nil
	}

	// Read the collector state file.
	statePath := os.Getenv("ANTHRIMON_STATE")
	if statePath == "" {
		statePath = defaultStatePath
	}
	data, err := os.ReadFile(statePath)
	if err != nil {
		if apiKey == "" {
			return "", "", fmt.Errorf("ANTHRIMON_TRAP_API_KEY not set and state file unreadable: %w", err)
		}
		// apiKey is set, hubURL missing — use default.
		if hubURL == "" {
			hubURL = "http://127.0.0.1:8001"
		}
		return hubURL, apiKey, nil
	}

	var st collectorState
	if err := json.Unmarshal(data, &st); err != nil {
		return "", "", fmt.Errorf("parse state file: %w", err)
	}

	if apiKey == "" {
		apiKey = st.APIKey
	}
	if hubURL == "" && st.WGAssignedIP != "" {
		// Hub is always .1 in the same /24 as the collector's WireGuard IP.
		if i := strings.LastIndex(st.WGAssignedIP, "."); i >= 0 {
			hubURL = "https://" + st.WGAssignedIP[:i+1] + "1"
		}
	}
	if hubURL == "" {
		hubURL = "http://127.0.0.1:8001"
	}
	if apiKey == "" {
		return "", "", fmt.Errorf("api_key not found in state file %s", statePath)
	}
	return hubURL, apiKey, nil
}

// ── Entry point ───────────────────────────────────────────────────────────────

func main() {
	hubURL, apiKey, err := loadConfig()
	if err != nil {
		fmt.Fprintf(os.Stderr, "trap-handler: %v\n", err)
		os.Exit(1)
	}

	var lines []string
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		lines = append(lines, scanner.Text())
	}

	trap := parseStdin(lines)
	if trap.sourceIP == "" {
		os.Exit(0) // empty/malformed input — nothing to post
	}

	if err := postToHub(hubURL, apiKey, trap); err != nil {
		fmt.Fprintf(os.Stderr, "trap-handler: %v\n", err)
		os.Exit(1)
	}
}
