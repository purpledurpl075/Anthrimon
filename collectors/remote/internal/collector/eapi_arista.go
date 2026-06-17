// Package collector — Arista eAPI IS-IS collector.
//
// AristaEAPICollector polls Arista EOS devices every 5 minutes via the native
// eAPI JSON-RPC endpoint (/command-api) and posts IS-IS adjacency state to the
// hub via POST /api/v1/collectors/isis-neighbors.
//
// The hub upserts the data into the same isis_neighbors table used by the SNMP
// path, so the existing UI and alerting work without change.
//
// Collection is controlled by the eapi_enabled flag per device (set by the hub
// when device_api_methods has arista_eapi enabled+reachable).
package collector

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/rs/zerolog"
	zlog "github.com/rs/zerolog/log"

	"github.com/purpledurpl075/anthri-mon/collectors/remote/internal/hub"
)

var eapiLog = zlog.Logger.With().Str("subsystem", "arista_eapi").Logger()

// ── AristaEAPICollector ───────────────────────────────────────────────────────

// AristaEAPICollector collects routing state and topology data from Arista EOS
// devices via eAPI and forwards results to the hub.
//
// Two polling tiers are used:
//   - State tier (stateInterval, default 15s): BGP sessions + IS-IS neighbors.
//     These are time-sensitive; fast detection drives alert latency.
//   - Counter tier (counterInterval, default 60s): STP ports + route table.
//     Heavier walks, but changes are less time-critical.
type AristaEAPICollector struct {
	hubClient       *hub.Client
	mu              sync.RWMutex
	devices         []hub.Device
	stateInterval   time.Duration
	counterInterval time.Duration
	logger          zerolog.Logger
}

// NewAristaEAPICollector creates a new Arista eAPI collector with default intervals.
func NewAristaEAPICollector(hubClient *hub.Client, logger zerolog.Logger) *AristaEAPICollector {
	return &AristaEAPICollector{
		hubClient:       hubClient,
		stateInterval:   15 * time.Second,
		counterInterval: 60 * time.Second,
		logger:          logger.With().Str("subsystem", "arista_eapi").Logger(),
	}
}

// SetDevices replaces the current device list.
func (c *AristaEAPICollector) SetDevices(devices []hub.Device) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.devices = devices
}

// SetIntervals configures the state and counter poll cadences. A zero or
// negative value retains the current default. Changes take effect on the
// next collector restart (tickers are created once in Run).
func (c *AristaEAPICollector) SetIntervals(stateS, counterS int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if stateS > 0 {
		c.stateInterval = time.Duration(stateS) * time.Second
	}
	if counterS > 0 {
		c.counterInterval = time.Duration(counterS) * time.Second
	}
}

// Run starts the dual-ticker eAPI collection loop.
func (c *AristaEAPICollector) Run(ctx context.Context) {
	c.mu.RLock()
	stateInterval   := c.stateInterval
	counterInterval := c.counterInterval
	c.mu.RUnlock()

	if stateInterval <= 0 || stateInterval >= counterInterval {
		stateInterval = counterInterval / 4
	}

	stateTicker   := time.NewTicker(stateInterval)
	counterTicker := time.NewTicker(counterInterval)
	defer stateTicker.Stop()
	defer counterTicker.Stop()

	c.collectState(ctx)
	c.collectCounters(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-stateTicker.C:
			c.collectState(ctx)
		case <-counterTicker.C:
			c.collectCounters(ctx)
		}
	}
}

// collectState polls BGP sessions and IS-IS neighbors for every eAPI-enabled
// Arista device. These are time-sensitive state fields that drive alert latency.
func (c *AristaEAPICollector) collectState(ctx context.Context) {
	c.mu.RLock()
	devices := make([]hub.Device, len(c.devices))
	copy(devices, c.devices)
	c.mu.RUnlock()

	for _, dev := range devices {
		if !dev.EapiEnabled || dev.Vendor != "arista" {
			continue
		}
		cred := dev.SSHCredential()
		if cred == nil {
			c.logger.Warn().Str("device", dev.Hostname).Msg("no ssh credential for eapi")
			continue
		}
		username, _ := cred.Data["username"].(string)
		password, _ := cred.Data["password"].(string)

		// IS-IS neighbors — always posted even when empty so the hub can mark
		// a fully-isolated device's adjacencies as down.
		isisResults, err := eapiCall(ctx, dev.MgmtIP, username, password, []string{"show isis neighbors"})
		if err != nil {
			c.logger.Warn().Err(err).Str("device", dev.Hostname).Msg("arista isis collection failed")
		} else if len(isisResults) > 0 {
			adjs := parseISISNeighbors(dev.ID, isisResults[0])
			if err := c.hubClient.PostISISNeighbors(ctx, dev.ID, adjs); err != nil {
				c.logger.Warn().Err(err).Str("device", dev.Hostname).Msg("isis post to hub failed")
			} else {
				c.logger.Info().Str("device", dev.Hostname).Int("adjacencies", len(adjs)).Msg("isis neighbors posted")
			}
		}

		// BGP session state — separate eAPI call so a failure here doesn't
		// discard IS-IS results. "show ip bgp summary vrf all" is used instead
		// of "show bgp summary vrf all" for broader EOS image compatibility.
		bgpResults, err := eapiCall(ctx, dev.MgmtIP, username, password, []string{"show ip bgp summary vrf all"})
		if err != nil {
			c.logger.Warn().Err(err).Str("device", dev.Hostname).Msg("arista bgp summary collection failed")
		} else if len(bgpResults) > 0 {
			sessions := parseBGPSummary(dev.ID, bgpResults[0])
			if len(sessions) == 0 {
				if raw, mErr := json.Marshal(bgpResults[0]); mErr == nil {
					c.logger.Warn().Str("device", dev.Hostname).Str("raw", string(raw)).Msg("bgp summary parsed zero sessions")
				}
			}
			if err := c.hubClient.PostBGPSessions(ctx, dev.ID, sessions); err != nil {
				c.logger.Warn().Err(err).Str("device", dev.Hostname).Msg("bgp post to hub failed")
			} else {
				c.logger.Info().Str("device", dev.Hostname).Int("sessions", len(sessions)).Msg("bgp sessions posted")
			}
		}
	}
}

// collectCounters polls STP ports and the route table for every eAPI-enabled
// Arista device. These are heavier walks that are less time-sensitive.
func (c *AristaEAPICollector) collectCounters(ctx context.Context) {
	c.mu.RLock()
	devices := make([]hub.Device, len(c.devices))
	copy(devices, c.devices)
	c.mu.RUnlock()

	for _, dev := range devices {
		if !dev.EapiEnabled || dev.Vendor != "arista" {
			continue
		}
		cred := dev.SSHCredential()
		if cred == nil {
			continue
		}
		username, _ := cred.Data["username"].(string)
		password, _ := cred.Data["password"].(string)

		results, err := eapiCall(ctx, dev.MgmtIP, username, password,
			[]string{"show spanning-tree", "show ip route vrf all"})
		if err != nil {
			c.logger.Warn().Err(err).Str("device", dev.Hostname).Msg("arista counter collection failed")
			continue
		}

		// STP ports (result[0])
		if len(results) > 0 {
			stpPorts := parseAristaSTP(dev.ID, results[0])
			if len(stpPorts) > 0 {
				if err := c.hubClient.PostSTPPorts(ctx, stpPorts); err != nil {
					c.logger.Warn().Err(err).Str("device", dev.Hostname).Msg("stp post to hub failed")
				} else {
					c.logger.Info().Str("device", dev.Hostname).Int("ports", len(stpPorts)).Msg("stp ports posted")
				}
			}
		}

		// Route table (result[1]) — always posted even when empty so the hub
		// can prune previously-reported routes for a device whose table is empty.
		if len(results) > 1 {
			routes := parseAristaRoutes(dev.ID, results[1])
			if err := c.hubClient.PostRoutes(ctx, dev.ID, routes); err != nil {
				c.logger.Warn().Err(err).Str("device", dev.Hostname).Msg("routes post to hub failed")
			} else {
				c.logger.Info().Str("device", dev.Hostname).Int("routes", len(routes)).Msg("routes posted")
			}
		}
	}
}

// ── eAPI HTTP client ──────────────────────────────────────────────────────────

var eapiHTTP = &http.Client{
	Timeout: 15 * time.Second,
	Transport: &http.Transport{
		TLSClientConfig: &tls.Config{
			InsecureSkipVerify: true, //nolint:gosec — enterprise self-signed certs
		},
		MaxIdleConnsPerHost: 2,
		IdleConnTimeout:     30 * time.Second,
	},
}

func eapiCall(ctx context.Context, host, username, password string, cmds []string) ([]map[string]any, error) {
	payload := map[string]any{
		"jsonrpc": "2.0",
		"method":  "runCmds",
		"params": map[string]any{
			"format":  "json",
			"cmds":    cmds,
			"version": 1,
		},
		"id": "1",
	}
	body, _ := json.Marshal(payload)

	// Always try HTTPS first, fall back to HTTP — matches hub-side Python behavior.
	// TLS verification is skipped (InsecureSkipVerify) so self-signed certs work.
	for _, scheme := range []string{"https", "http"} {
		url := fmt.Sprintf("%s://%s/command-api", scheme, host)
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
		if err != nil {
			continue
		}
		req.Header.Set("Content-Type", "application/json")
		req.SetBasicAuth(username, password)

		resp, err := eapiHTTP.Do(req)
		if err != nil {
			eapiLog.Debug().Err(err).Str("scheme", scheme).Str("host", host).Msg("eapi do failed")
			continue
		}
		respBody, _ := io.ReadAll(resp.Body)
		resp.Body.Close()

		if resp.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("eAPI %s returned HTTP %d", host, resp.StatusCode)
		}

		var envelope struct {
			Result []map[string]any `json:"result"`
			Error  *struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal(respBody, &envelope); err != nil {
			return nil, fmt.Errorf("eAPI parse: %w", err)
		}
		if envelope.Error != nil {
			return nil, fmt.Errorf("eAPI error: %s", envelope.Error.Message)
		}
		return envelope.Result, nil
	}
	return nil, fmt.Errorf("eAPI unreachable on %s", host)
}

// ── Response parser ───────────────────────────────────────────────────────────

// parseISISNeighbors converts "show isis neighbors" JSON output into flat
// records matching the isis_neighbors table schema.
func parseISISNeighbors(deviceID string, result map[string]any) []map[string]any {
	nowSecs := float64(time.Now().Unix())
	var rows []map[string]any

	vrfs, _ := result["vrfs"].(map[string]any)
	for _, vrfRaw := range vrfs {
		vrf, _ := vrfRaw.(map[string]any)
		instances, _ := vrf["isisInstances"].(map[string]any)
		for instName, instRaw := range instances {
			inst, _ := instRaw.(map[string]any)
			neighbors, _ := inst["neighbors"].(map[string]any)
			for sysID, nbrRaw := range neighbors {
				nbr, _ := nbrRaw.(map[string]any)
				adjs, _ := nbr["adjacencies"].([]any)
				for _, adjRaw := range adjs {
					adj, _ := adjRaw.(map[string]any)
					details, _ := adj["details"].(map[string]any)

					stateRaw, _ := adj["state"].(string)
					state := normISISAdjState(stateRaw)

					levelRaw, _ := adj["level"].(string)

					ifaceName, _ := adj["interfaceName"].(string)
					hostname, _ := adj["hostname"].(string)

					var ipv4, ipv6 string
					if details != nil {
						ipv4, _ = details["ip4Address"].(string)
						ipv6, _ = details["ip6Address"].(string)
					}

					var uptimeSecs *int64
					var lastChange *string
					if state == "up" && details != nil {
						if sc, ok := details["stateChanged"].(float64); ok && sc > 0 {
							u := int64(math.Round(nowSecs - sc))
							uptimeSecs = &u
							ts := time.Unix(int64(sc), 0).UTC().Format(time.RFC3339)
							lastChange = &ts
						}
					}

					row := map[string]any{
						"device_id":      deviceID,
						"instance":       instName,
						"sys_id":         sysID,
						"hostname":       hostname,
						"interface_name": ifaceName,
						"circuit_type":   normISISLevel(levelRaw),
						"adj_state":      state,
						"ipv4_address":   nilIfEmpty(ipv4),
						"ipv6_address":   nilIfEmpty(ipv6),
						"uptime_seconds": uptimeSecs,
						"last_state_change": lastChange,
					}
					rows = append(rows, row)
				}
			}
		}
	}
	return rows
}

// parseBGPSummary converts "show bgp summary" JSON output into
// bgp_sessions-shaped records for the hub's /collectors/bgp-sessions endpoint.
// EOS reports peer/local ASNs as strings (to accommodate 4-byte ASNs) and
// upDownTime as the epoch timestamp of the last state change. Without "vrf
// all", some EOS versions nest the result under vrfs.default like the
// multi-VRF form, others return the default VRF's fields at the top level —
// handle both.
func parseBGPSummary(deviceID string, result map[string]any) []map[string]any {
	var rows []map[string]any
	nowSecs := float64(time.Now().Unix())

	vrfs, _ := result["vrfs"].(map[string]any)
	if vrfs == nil {
		if _, ok := result["peers"]; ok {
			vrfs = map[string]any{"default": result}
		}
	}
	for vrfName, vrfRaw := range vrfs {
		vrf, _ := vrfRaw.(map[string]any)
		localASN := eosNum(vrf["asn"])

		peers, _ := vrf["peers"].(map[string]any)
		for peerIP, peerRaw := range peers {
			peer, _ := peerRaw.(map[string]any)
			stateRaw, _ := peer["peerState"].(string)

			uptimeSecs := 0
			if v, ok := peer["upDownTime"].(float64); ok && v > 0 {
				if v > 1e9 { // epoch timestamp, not a duration
					uptimeSecs = int(math.Max(0, nowSecs-v))
				} else {
					uptimeSecs = int(v)
				}
			}

			rows = append(rows, map[string]any{
				"device_id":         deviceID,
				"vrf":               vrfName,
				"peer_ip":           peerIP,
				"peer_asn":          eosNum(peer["asn"]),
				"local_asn":         localASN,
				"state":             normEOSBGPState(stateRaw),
				"uptime_s":          uptimeSecs,
				"in_updates":        jsonInt(peer["msgReceived"]),
				"out_updates":       jsonInt(peer["msgSent"]),
				"prefixes_received": jsonInt(peer["prefixReceived"]),
			})
		}
	}
	return rows
}

// eosNum converts an Arista eAPI numeric field that may be encoded as either
// a JSON number or a string (EOS does this for ASNs) to an int.
func eosNum(v any) int {
	switch n := v.(type) {
	case float64:
		return int(n)
	case string:
		var i int
		fmt.Sscanf(n, "%d", &i)
		return i
	}
	return 0
}

// normEOSBGPState maps EOS "peerState" values to the bgp_session_state enum
// (idle, connect, active, opensent, openconfirm, established, unknown).
func normEOSBGPState(raw string) string {
	switch strings.ToLower(raw) {
	case "idle", "connect", "active", "opensent", "openconfirm", "established":
		return strings.ToLower(raw)
	default:
		return "unknown"
	}
}

// parseAristaSTP converts "show spanning-tree" JSON output into flat records
// for the hub's /collectors/stp-ports endpoint.
// Arista reports STP per instance (CIST = MST0, or per-VLAN in PVST).
// We take the CIST (MST0 or MSTI 0) first; fall back to the first instance.
func parseAristaSTP(deviceID string, result map[string]any) []map[string]any {
	instances, _ := result["spanningTreeInstances"].(map[string]any)
	if len(instances) == 0 {
		return nil
	}

	// Prefer MST0 / CIST; fall back to first key.
	pick := ""
	for _, key := range []string{"MST0", "CIST", "VL1"} {
		if _, ok := instances[key]; ok {
			pick = key
			break
		}
	}
	if pick == "" {
		for k := range instances {
			pick = k
			break
		}
	}

	inst, _ := instances[pick].(map[string]any)
	ifaces, _ := inst["interfaces"].(map[string]any)

	var rows []map[string]any
	for ifName, ifRaw := range ifaces {
		iface, _ := ifRaw.(map[string]any)
		stateRaw, _ := iface["state"].(string)
		roleRaw, _ := iface["role"].(string)
		if stateRaw == "" {
			continue
		}
		rows = append(rows, map[string]any{
			"device_id": deviceID,
			"if_name":   ifName,
			"stp_state": normStpState(stateRaw),
			"stp_role":  normStpRole(roleRaw),
		})
	}
	return rows
}

// parseAristaRoutes converts "show ip route vrf all" JSON output into
// route_entries-shaped records. Only the "default" VRF is processed —
// route_entries has no VRF column, and other VRFs (e.g. "MGMT") are not
// reachable from the default VRF without an explicit route leak, so mixing
// them in would let path-trace hop through routes that don't actually carry
// default-VRF traffic. One record is emitted per via (next-hop) so ECMP
// routes are preserved under route_entries' UNIQUE(device_id, destination,
// next_hop) constraint.
func parseAristaRoutes(deviceID string, result map[string]any) []map[string]any {
	var rows []map[string]any

	vrfs, _ := result["vrfs"].(map[string]any)
	{
		vrf, _ := vrfs["default"].(map[string]any)
		routes, _ := vrf["routes"].(map[string]any)
		for prefix, routeRaw := range routes {
			route, _ := routeRaw.(map[string]any)
			routeTypeRaw, _ := route["routeType"].(string)
			proto := normEOSRouteType(routeTypeRaw)
			metric := jsonInt(route["metric"])

			vias, _ := route["vias"].([]any)
			if len(vias) == 0 {
				rows = append(rows, map[string]any{
					"device_id":      deviceID,
					"destination":    prefix,
					"next_hop":       "",
					"protocol":       proto,
					"metric":         metric,
					"interface_name": "",
				})
				continue
			}

			for _, viaRaw := range vias {
				via, _ := viaRaw.(map[string]any)
				nextHop, _ := via["nexthopAddr"].(string)
				ifaceName, _ := via["interface"].(string)
				rows = append(rows, map[string]any{
					"device_id":      deviceID,
					"destination":    prefix,
					"next_hop":       nextHop,
					"protocol":       proto,
					"metric":         metric,
					"interface_name": ifaceName,
				})
			}
		}
	}
	return rows
}

// normEOSRouteType maps EOS "show ip route" routeType strings (e.g.
// "connected", "static", "eBGP", "iBGP", "OSPF", "OSPF inter area",
// "ISIS-L1", "ISIS-L2") to the same protocol vocabulary used by SNMP
// (cidrProtoName): connected, static, bgp, ospf, isis, rip, eigrp, other.
func normEOSRouteType(raw string) string {
	lower := strings.ToLower(raw)
	switch {
	case lower == "connected":
		return "connected"
	case lower == "static":
		return "static"
	case strings.Contains(lower, "bgp"):
		return "bgp"
	case strings.HasPrefix(lower, "ospf"):
		return "ospf"
	case strings.HasPrefix(lower, "isis"):
		return "isis"
	case lower == "rip":
		return "rip"
	case strings.Contains(lower, "eigrp"):
		return "eigrp"
	default:
		return "other"
	}
}

func normStpState(s string) string {
	switch strings.ToLower(s) {
	case "forwarding":  return "forwarding"
	case "blocking":    return "blocking"
	case "listening":   return "listening"
	case "learning":    return "learning"
	case "disabled":    return "disabled"
	case "discarding":  return "blocking" // RSTP uses "discarding" instead of "blocking"
	default:            return "disabled"
	}
}

func normStpRole(s string) string {
	switch strings.ToLower(s) {
	case "root":        return "root"
	case "designated":  return "designated"
	case "alternate":   return "alternate"
	case "backup":      return "backup"
	case "disabled":    return "disabled"
	case "master":      return "root" // MSTP master port acts as root
	default:            return "unknown"
	}
}

// ── Normalisers ───────────────────────────────────────────────────────────────

func normISISAdjState(raw string) string {
	switch strings.ToLower(raw) {
	case "up":
		return "up"
	case "down":
		return "down"
	case "init", "initializing":
		return "initializing"
	case "failed":
		return "failed"
	default:
		return "unknown"
	}
}

func normISISLevel(raw string) string {
	switch strings.ToLower(raw) {
	case "level-1":
		return "level-1"
	case "level-2":
		return "level-2"
	case "level-1-2":
		return "level-1-2"
	default:
		return raw
	}
}

func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}
