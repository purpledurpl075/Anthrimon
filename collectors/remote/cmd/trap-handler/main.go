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

const version = "0.1.9"

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

	// ENTITY-MIB (RFC 4133) — standard IETF notification, not vendor-enterprise.
	"1.3.6.1.2.1.47.2.0.1": {Name: "entity.configChange", Severity: "info"},

	// BGP4-MIB (RFC 1657) legacy SNMPv1-style trap OIDs — some platforms (seen:
	// Arista EOS) emit these alongside the modern RFC 4273 bgpTraps (.15.7.x)
	// versions of the exact same two events, for backward compatibility with
	// v1-only managers. Map to the same trap_type as their .7.x counterparts
	// (see trap_catalog.py) rather than treating them as distinct trap types.
	"1.3.6.1.2.1.15.0.1": {Name: "bgp.established",        Severity: "info"},
	"1.3.6.1.2.1.15.0.2": {Name: "bgp.backwardTransition",  Severity: "warning"},

	// ISIS-MIB (RFC 4444, isisNotifications = 1.3.6.1.2.1.138.0) — exact
	// notification-number assignments confirmed directly against the RFC
	// text; see the comment on the old (wrong) prefix-matched entries below
	// for why these live here instead.
	"1.3.6.1.2.1.138.0.1":  {Name: "isis.databaseOverload",   Severity: "critical"},
	"1.3.6.1.2.1.138.0.3":  {Name: "isis.corruptedLSP",       Severity: "critical"},
	"1.3.6.1.2.1.138.0.13": {Name: "isis.rejectedAdjacency",  Severity: "warning"},
	"1.3.6.1.2.1.138.0.17": {Name: "isis.adjacencyChange",    Severity: "warning"},
}

var _enterpriseTraps = []enterpriseTrap{
	// ── BGP (RFC 4273, 1.3.6.1.2.1.15) ──────────────────────────────────────
	{Prefix: "1.3.6.1.2.1.15.7.2", Name: "bgp.backwardTransition", Severity: "warning"},
	{Prefix: "1.3.6.1.2.1.15.7.1", Name: "bgp.established",        Severity: "info"},

	// ── OSPF (RFC 4750, 1.3.6.1.2.1.14) ─────────────────────────────────────
	{Prefix: "1.3.6.1.2.1.14.16.2.7",  Name: "ospf.authFailure",             Severity: "critical"},
	{Prefix: "1.3.6.1.2.1.14.16.2.8",  Name: "ospf.virtAuthFailure",         Severity: "critical"},
	{Prefix: "1.3.6.1.2.1.14.16.2.15", Name: "ospf.lsdbOverflow",            Severity: "critical"},
	{Prefix: "1.3.6.1.2.1.14.16.2.16", Name: "ospf.lsdbApproachingOverflow", Severity: "warning"},
	{Prefix: "1.3.6.1.2.1.14.16.2.3",  Name: "ospf.nbrStateChange",          Severity: "warning"},
	{Prefix: "1.3.6.1.2.1.14.16.2.4",  Name: "ospf.virtNbrStateChange",      Severity: "warning"},
	{Prefix: "1.3.6.1.2.1.14.16.2.1",  Name: "ospf.ifStateChange",           Severity: "warning"},
	{Prefix: "1.3.6.1.2.1.14.16.2.2",  Name: "ospf.virtIfStateChange",       Severity: "warning"},
	{Prefix: "1.3.6.1.2.1.14.",        Name: "ospf.trap",                     Severity: "warning"},

	// ── IS-IS (RFC 4444, 1.3.6.1.2.1.138) ───────────────────────────────────
	// The three specific entries this used to have here (.0.1, .0.5, .0.7)
	// were wrong — verified against the RFC 4444 text directly, the correct
	// numbers are .0.1=isisDatabaseOverload, .0.3=isisCorruptedLSPDetected,
	// .0.17=isisAdjacencyChange. They only "worked" by accident: string-prefix
	// matching means ".0.1" also matches ".0.10" through ".0.19", so real
	// isisAdjacencyChange traps (.0.17) got labeled by the wrong entry. Moved
	// to _standardTraps below as exact matches so this can't happen again —
	// these are individually-enumerated notifications, not a variable-instance
	// table, so exact matching is both correct and collision-proof.
	{Prefix: "1.3.6.1.2.1.138.", Name: "isis.trap", Severity: "warning"},

	// ── MPLS LSR (RFC 3813, 1.3.6.1.2.1.131) ────────────────────────────────
	{Prefix: "1.3.6.1.2.1.131.0.2", Name: "mpls.xcDown", Severity: "warning"},
	{Prefix: "1.3.6.1.2.1.131.0.1", Name: "mpls.xcUp",   Severity: "info"},
	{Prefix: "1.3.6.1.2.1.131.",    Name: "mpls.trap",    Severity: "info"},

	// ── STP / BRIDGE-MIB (RFC 1493, 1.3.6.1.2.1.17) ────────────────────────
	{Prefix: "1.3.6.1.2.1.17.0.2", Name: "stp.topologyChange", Severity: "warning"},
	{Prefix: "1.3.6.1.2.1.17.0.1", Name: "stp.newRoot",        Severity: "warning"},
	{Prefix: "1.3.6.1.2.1.17.",    Name: "stp.trap",            Severity: "info"},

	// ── LLDP (IEEE 802.1AB, 1.0.8802.1.1.2) ────────────────────────────────
	{Prefix: "1.0.8802.1.1.2.0.0.1", Name: "lldp.remTablesChange", Severity: "info"},
	{Prefix: "1.0.8802.1.1.2.",      Name: "lldp.trap",             Severity: "info"},

	// ── VRRP (RFC 2787, 1.3.6.1.2.1.68) ────────────────────────────────────
	{Prefix: "1.3.6.1.2.1.68.0.2", Name: "vrrp.authFailure", Severity: "warning"},
	{Prefix: "1.3.6.1.2.1.68.0.1", Name: "vrrp.newMaster",   Severity: "info"},
	{Prefix: "1.3.6.1.2.1.68.",    Name: "vrrp.trap",         Severity: "info"},

	// ── Arista ───────────────────────────────────────────────────────────────
	{Prefix: "1.3.6.1.4.1.30065.3.9",    Name: "arista.bgpPeerStateChange", Severity: "warning"},
	{Prefix: "1.3.6.1.4.1.30065.3.10",   Name: "arista.linkStateChange",    Severity: "warning"},
	// ARISTA-BRIDGE-EXT-MIB (aristaMibs.2) notifications
	{Prefix: "1.3.6.1.4.1.30065.3.2.0.1", Name: "arista.macMove",  Severity: "info"},
	{Prefix: "1.3.6.1.4.1.30065.3.2.0.2", Name: "arista.macLearn", Severity: "info"},
	{Prefix: "1.3.6.1.4.1.30065.3.2.0.3", Name: "arista.macAge",   Severity: "info"},
	// ARISTA-BGP4V2-MIB — same two events as bgp.established/backwardTransition
	// (RFC 4273), just Arista's newer BGP4V2 MIB instead of the classic one.
	// Reuse the vendor-neutral trap_type so the Traps UI aggregates the same
	// real-world event across vendors instead of splitting it per-MIB.
	{Prefix: "1.3.6.1.4.1.30065.4.1.0.1", Name: "bgp.established",        Severity: "info"},
	{Prefix: "1.3.6.1.4.1.30065.4.1.0.2", Name: "bgp.backwardTransition", Severity: "warning"},
	{Prefix: "1.3.6.1.4.1.30065.",        Name: "arista.trap",     Severity: "info"},

	// ── Aruba CX ─────────────────────────────────────────────────────────────
	{Prefix: "1.3.6.1.4.1.47196.4.1.1.3.20",      Name: "aruba_cx.linkStateChange", Severity: "warning"},
	// ARUBAWIRED-MGMD-RMON-TRAP-MIB — generic RMON event-log export (carries
	// RMON-MIB eventIndex/eventDescription varbinds; severity is really
	// per-message, "warning" is a reasonable default over the generic fallback).
	{Prefix: "1.3.6.1.4.1.47196.4.1.1.3.4.1.1",   Name: "aruba_cx.rmonEvent",       Severity: "warning"},
	{Prefix: "1.3.6.1.4.1.47196.",                Name: "aruba_cx.trap",             Severity: "info"},

	// ── HP / ProCurve ────────────────────────────────────────────────────────
	{Prefix: "1.3.6.1.4.1.11.2.14.12.1", Name: "hp.linkChange", Severity: "warning"},
	{Prefix: "1.3.6.1.4.1.11.2.",        Name: "hp.trap",        Severity: "info"},

	// ── Cisco ────────────────────────────────────────────────────────────────
	{Prefix: "1.3.6.1.4.1.9.9.187.",      Name: "cisco.bgpBackwardTransition",  Severity: "critical"},
	{Prefix: "1.3.6.1.4.1.9.9.43.",       Name: "cisco.configChange",           Severity: "warning"},
	{Prefix: "1.3.6.1.4.1.9.9.13.",       Name: "cisco.envMonAlert",            Severity: "critical"},
	{Prefix: "1.3.6.1.4.1.9.9.41.2.0.1",  Name: "cisco.syslogMessage",          Severity: "info"},
	// CISCO-RF-MIB (Redundancy Framework) — ciscoRFSwactNotif (.2.0.1, an
	// actual failover) is more severe than ciscoRFProgressionNotif (.2.0.2,
	// routine state-machine progress); only the latter has shown up so far.
	{Prefix: "1.3.6.1.4.1.9.9.176.2.0.1", Name: "cisco.rfSwitchover",           Severity: "warning"},
	{Prefix: "1.3.6.1.4.1.9.9.176.2.0.2", Name: "cisco.rfProgression",          Severity: "info"},
	// CISCO-IPSEC-MIB cryptomap add/delete
	{Prefix: "1.3.6.1.4.1.9.10.62.2.0.3", Name: "cisco.ipsecCryptomapAdded",    Severity: "info"},
	{Prefix: "1.3.6.1.4.1.9.10.62.2.0.4", Name: "cisco.ipsecCryptomapDeleted",  Severity: "warning"},
	// Legacy CISCOTRAP-MIB enterprise trap #1 — TTY/VTY (SSH/Telnet) session
	// torn down; fires on ordinary management-session teardown, including our
	// own SSH-based polling, so it's routine noise rather than a fault signal.
	{Prefix: "1.3.6.1.4.1.9.0.1",         Name: "cisco.tcpConnectionClose",     Severity: "info"},
	{Prefix: "1.3.6.1.4.1.9.",            Name: "cisco.trap",                    Severity: "info"},

	// ── Net-SNMP agent (1.3.6.1.4.1.8072) ───────────────────────────────────
	{Prefix: "1.3.6.1.4.1.8072.4.0.1", Name: "netsnmp.agentStart", Severity: "info"},

	// ── Juniper ──────────────────────────────────────────────────────────────
	{Prefix: "1.3.6.1.4.1.2636.", Name: "juniper.trap", Severity: "info"},
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
