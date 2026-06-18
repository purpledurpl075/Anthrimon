// Package collector — ArubaOS-CX REST state collector.
//
// ArubaRESTCollector polls ArubaOS-CX devices every 5 minutes via the
// native AOS-CX REST API and posts BGP session and OSPF neighbor state
// to the hub via POST /api/v1/collectors/bgp-sessions and
// POST /api/v1/collectors/ospf-neighbors.
//
// The hub upserts the data into the same bgp_sessions / ospf_neighbors
// tables used by SNMP, so the existing UI, alerting, and BGP event log
// all work without change.
//
// REST API must be enabled on the switch:
//
//	conf t
//	https-server vrf mgmt
//	end
//	wr mem
//
// Collection is controlled by the rest_collection_enabled flag per device.
// It is currently supported only for vendor == "aruba_cx".
package collector

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/rs/zerolog"

	"github.com/purpledurpl075/anthri-mon/collectors/remote/internal/hub"
)

const arubaAPIVersion = "v10.16"

// ── ArubaRESTCollector ────────────────────────────────────────────────────────

// ArubaRESTCollector collects routing state and topology data from ArubaOS-CX
// devices via the native REST API and forwards results to the hub.
//
// Two polling tiers are used:
//   - State tier (stateInterval, default 15s): BGP sessions + OSPF neighbors.
//     These are time-sensitive; fast detection drives alert latency.
//   - Counter tier (counterInterval, default 60s): routes, VLANs, STP, ARP/MAC,
//     inventory. Heavier REST walks that are less time-critical.
type ArubaRESTCollector struct {
	hubClient       *hub.Client
	mu              sync.RWMutex
	devices         []hub.Device
	stateInterval   time.Duration
	counterInterval time.Duration
	logger          zerolog.Logger
}

// NewArubaRESTCollector creates a new Aruba REST state collector with default intervals.
func NewArubaRESTCollector(hubClient *hub.Client, logger zerolog.Logger) *ArubaRESTCollector {
	return &ArubaRESTCollector{
		hubClient:       hubClient,
		stateInterval:   15 * time.Second,
		counterInterval: 60 * time.Second,
		logger:          logger.With().Str("subsystem", "aruba_rest").Logger(),
	}
}

// SetDevices replaces the current device list.
func (c *ArubaRESTCollector) SetDevices(devices []hub.Device) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.devices = devices
}

// SetIntervals configures the state and counter poll cadences. A zero or
// negative value retains the current default. Changes take effect on the
// next collector restart (tickers are created once in Run).
func (c *ArubaRESTCollector) SetIntervals(stateS, counterS int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if stateS > 0 {
		c.stateInterval = time.Duration(stateS) * time.Second
	}
	if counterS > 0 {
		c.counterInterval = time.Duration(counterS) * time.Second
	}
}

// Run starts the dual-ticker REST collection loop.
func (c *ArubaRESTCollector) Run(ctx context.Context) {
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

func (c *ArubaRESTCollector) enabledDevices() []hub.Device {
	c.mu.RLock()
	defer c.mu.RUnlock()
	out := make([]hub.Device, 0, len(c.devices))
	for _, d := range c.devices {
		if d.RestCollectionEnabled && d.Vendor == "aruba_cx" {
			out = append(out, d)
		}
	}
	return out
}

// collectState polls BGP sessions and OSPF neighbors for every REST-enabled
// ArubaOS-CX device. These are time-sensitive state fields that drive alert latency.
// Devices are polled concurrently so a slow device doesn't delay state detection
// for the rest of the fleet.
func (c *ArubaRESTCollector) collectState(ctx context.Context) {
	devices := c.enabledDevices()
	var wg sync.WaitGroup
	for _, dev := range devices {
		wg.Add(1)
		go func(d hub.Device) {
			defer wg.Done()
			if err := c.collectStateDevice(ctx, d); err != nil {
				c.logger.Warn().Err(err).Str("device", d.Hostname).Msg("aruba rest state collection failed")
			}
		}(dev)
	}
	wg.Wait()
}

func (c *ArubaRESTCollector) collectStateDevice(ctx context.Context, dev hub.Device) error {
	cred := dev.SSHCredential()
	if cred == nil {
		return fmt.Errorf("no credential available for %s", dev.Hostname)
	}
	username, _ := cred.Data["username"].(string)
	password, _ := cred.Data["password"].(string)

	ac := NewArubaClient(dev.MgmtIP, username, password)
	if err := ac.Login(ctx); err != nil {
		return fmt.Errorf("login: %w", err)
	}
	defer ac.Logout(ctx)

	// BGP — posted even when empty so the hub can mark stale sessions.
	bgpSessions, bgpErr := ac.collectBGP(ctx, dev.ID)
	if bgpErr != nil {
		c.logger.Warn().Err(bgpErr).Str("device", dev.Hostname).Msg("bgp collection failed")
	} else {
		if err := c.hubClient.PostBGPSessions(ctx, dev.ID, bgpSessions); err != nil {
			c.logger.Warn().Err(err).Str("device", dev.Hostname).Msg("bgp post to hub failed")
		} else {
			c.logger.Info().Str("device", dev.Hostname).Int("sessions", len(bgpSessions)).Msg("bgp sessions posted")
		}
	}

	// OSPF — posted even when empty so the hub can mark neighbors down.
	ospfNbrs, ospfErr := ac.collectOSPF(ctx, dev.ID)
	if ospfErr != nil {
		c.logger.Warn().Err(ospfErr).Str("device", dev.Hostname).Msg("ospf collection failed")
	} else {
		if err := c.hubClient.PostOSPFNeighbors(ctx, dev.ID, ospfNbrs); err != nil {
			c.logger.Warn().Err(err).Str("device", dev.Hostname).Msg("ospf post to hub failed")
		} else {
			c.logger.Info().Str("device", dev.Hostname).Int("neighbors", len(ospfNbrs)).Msg("ospf neighbors posted")
		}
	}

	return nil
}

// collectCounters polls routes, VLANs, STP, addresses, and inventory for every
// REST-enabled ArubaOS-CX device. These are heavier walks that are less time-sensitive.
// Devices are polled concurrently so a slow device doesn't delay the full sweep.
func (c *ArubaRESTCollector) collectCounters(ctx context.Context) {
	devices := c.enabledDevices()
	var wg sync.WaitGroup
	for _, dev := range devices {
		wg.Add(1)
		go func(d hub.Device) {
			defer wg.Done()
			if err := c.collectCountersDevice(ctx, d); err != nil {
				c.logger.Warn().Err(err).Str("device", d.Hostname).Msg("aruba rest counter collection failed")
			}
		}(dev)
	}
	wg.Wait()
}

func (c *ArubaRESTCollector) collectCountersDevice(ctx context.Context, dev hub.Device) error {
	cred := dev.SSHCredential()
	if cred == nil {
		return fmt.Errorf("no credential available for %s", dev.Hostname)
	}
	username, _ := cred.Data["username"].(string)
	password, _ := cred.Data["password"].(string)

	ac := NewArubaClient(dev.MgmtIP, username, password)
	if err := ac.Login(ctx); err != nil {
		return fmt.Errorf("login: %w", err)
	}
	defer ac.Logout(ctx)

	// Routes — always posted even when empty so the hub can prune stale entries.
	routes, routesErr := ac.collectRoutes(ctx, dev.ID)
	if routesErr != nil {
		c.logger.Warn().Err(routesErr).Str("device", dev.Hostname).Msg("routes collection failed")
	} else {
		if err := c.hubClient.PostRoutes(ctx, dev.ID, routes); err != nil {
			c.logger.Warn().Err(err).Str("device", dev.Hostname).Msg("routes post to hub failed")
		} else {
			c.logger.Info().Str("device", dev.Hostname).Int("routes", len(routes)).Msg("routes posted")
		}
	}

	// VLANs — ArubaOS-CX does not expose Q-BRIDGE-MIB via SNMP.
	vlanRecords, vlanErr := ac.collectVLANs(ctx, dev.ID)
	if vlanErr != nil {
		c.logger.Warn().Err(vlanErr).Str("device", dev.Hostname).Msg("vlan collection failed")
	} else if len(vlanRecords) > 0 {
		if err := c.hubClient.PostVLANs(ctx, vlanRecords); err != nil {
			c.logger.Warn().Err(err).Str("device", dev.Hostname).Msg("vlan post to hub failed")
		} else {
			c.logger.Info().Str("device", dev.Hostname).Int("records", len(vlanRecords)).Msg("vlans posted")
		}
	}

	// STP
	stpPorts, stpErr := ac.collectSTP(ctx, dev.ID)
	if stpErr != nil {
		c.logger.Warn().Err(stpErr).Str("device", dev.Hostname).Msg("stp collection failed")
	} else if len(stpPorts) > 0 {
		if err := c.hubClient.PostSTPPorts(ctx, stpPorts); err != nil {
			c.logger.Warn().Err(err).Str("device", dev.Hostname).Msg("stp post to hub failed")
		} else {
			c.logger.Info().Str("device", dev.Hostname).Int("ports", len(stpPorts)).Msg("stp posted")
		}
	}

	// Addresses (ARP/ND + MAC FDB) — REST is the only source for collector-managed CX.
	addrRecords, addrErr := ac.collectAddresses(ctx, dev.ID)
	if addrErr != nil {
		c.logger.Warn().Err(addrErr).Str("device", dev.Hostname).Msg("address collection failed")
	} else if len(addrRecords) > 0 {
		if err := c.hubClient.PostAddresses(ctx, addrRecords); err != nil {
			c.logger.Warn().Err(err).Str("device", dev.Hostname).Msg("addresses post to hub failed")
		} else {
			c.logger.Info().Str("device", dev.Hostname).Int("records", len(addrRecords)).Msg("addresses posted")
		}
	}

	// Inventory (serial number)
	if inv, invErr := ac.collectInventory(ctx, dev.ID); invErr != nil {
		c.logger.Warn().Err(invErr).Str("device", dev.Hostname).Msg("inventory collection failed")
	} else if inv != nil {
		if err := c.hubClient.PostDeviceInventory(ctx, []map[string]any{inv}); err != nil {
			c.logger.Warn().Err(err).Str("device", dev.Hostname).Msg("inventory post to hub failed")
		} else {
			c.logger.Info().Str("device", dev.Hostname).Msg("inventory posted")
		}
	}

	return nil
}

// ── VLAN / STP collection (AOS-CX REST) ───────────────────────────────────────

// vlanIDsFrom extracts VLAN id(s) from an AOS-CX attribute that may be a number,
// a numeric string, a {"<id>": "<uri>"} reference map, or a list of those.
func vlanIDsFrom(v any) []int {
	var out []int
	switch t := v.(type) {
	case float64:
		out = append(out, int(t))
	case string:
		if n, err := strconv.Atoi(t); err == nil {
			out = append(out, n)
		}
	case map[string]any:
		for k := range t {
			if n, err := strconv.Atoi(k); err == nil {
				out = append(out, n)
			}
		}
	case []any:
		for _, e := range t {
			out = append(out, vlanIDsFrom(e)...)
		}
	}
	return out
}

// collectVLANs returns a flat list of records for the hub /collectors/vlans
// ingest: VLAN definitions ({device_id, vlan_id, name}) and per-interface
// memberships ({device_id, vlan_id, if_name, tagged}).
func (a *ArubaClient) collectVLANs(ctx context.Context, deviceID string) ([]map[string]any, error) {
	params := url.Values{}
	params.Set("depth", "2")

	rawVlans, err := a.Get(ctx, "/system/vlans", params)
	if err != nil {
		return nil, err
	}
	var records []map[string]any
	if m, ok := rawVlans.(map[string]any); ok {
		for key, obj := range m {
			vid := 0
			var name any
			if o, ok := obj.(map[string]any); ok {
				if idf, ok := o["id"].(float64); ok {
					vid = int(idf)
				}
				name = o["name"]
			}
			if vid == 0 {
				if n, err := strconv.Atoi(key); err == nil {
					vid = n
				} else {
					continue
				}
			}
			records = append(records, map[string]any{
				"device_id": deviceID, "vlan_id": vid, "name": name,
			})
		}
	}

	rawPorts, err := a.Get(ctx, "/system/interfaces", params)
	if err == nil {
		if m, ok := rawPorts.(map[string]any); ok {
			for name, obj := range m {
				o, ok := obj.(map[string]any)
				if !ok {
					continue
				}
				access := o["vlan_tag"]
				if access == nil {
					access = o["applied_vlan_tag"]
				}
				for _, vid := range vlanIDsFrom(access) {
					records = append(records, map[string]any{
						"device_id": deviceID, "if_name": name, "vlan_id": vid, "tagged": false,
					})
				}
				trunks := o["vlan_trunks"]
				if trunks == nil {
					trunks = o["applied_vlan_trunks"]
				}
				for _, vid := range vlanIDsFrom(trunks) {
					records = append(records, map[string]any{
						"device_id": deviceID, "if_name": name, "vlan_id": vid, "tagged": true,
					})
				}
			}
		}
	}
	return records, nil
}

func normSTPState(v any) string {
	switch strings.ToLower(strings.TrimSpace(fmt.Sprint(v))) {
	case "forwarding":
		return "forwarding"
	case "blocking", "blocked", "discarding":
		return "blocking"
	case "learning":
		return "learning"
	case "listening":
		return "listening"
	default:
		return "disabled"
	}
}

func normSTPRole(v any) string {
	s := strings.ToLower(strings.TrimSpace(fmt.Sprint(v)))
	switch {
	case strings.Contains(s, "root"):
		return "root"
	case strings.Contains(s, "designated"):
		return "designated"
	case strings.Contains(s, "alternate"):
		return "alternate"
	case strings.Contains(s, "backup"):
		return "backup"
	default:
		return "unknown"
	}
}

// collectSTP returns per-port CIST (instance 0) STP state records for the hub
// /collectors/stp-ports ingest: {device_id, if_name, stp_state, stp_role}.
func (a *ArubaClient) collectSTP(ctx context.Context, deviceID string) ([]map[string]any, error) {
	params := url.Values{}
	params.Set("depth", "3")
	raw, err := a.Get(ctx, "/system/stp_instances", params)
	if err != nil {
		return nil, err
	}
	m, ok := raw.(map[string]any)
	if !ok {
		return nil, nil
	}
	var out []map[string]any
	for _, inst := range m {
		io, ok := inst.(map[string]any)
		if !ok {
			continue
		}
		if idf, ok := io["stp_instance_id"].(float64); ok && int(idf) != 0 {
			continue // only the Common Internal Spanning Tree maps to per-port state
		}
		ports, ok := io["stp_instance_ports"].(map[string]any)
		if !ok {
			continue
		}
		for pname, pobj := range ports {
			po, ok := pobj.(map[string]any)
			if !ok {
				continue
			}
			state := po["port_state"]
			if state == nil {
				state = po["oper_port_state"]
			}
			role := po["port_role"]
			if role == nil {
				role = po["oper_port_role"]
			}
			out = append(out, map[string]any{
				"device_id": deviceID, "if_name": pname,
				"stp_state": normSTPState(state), "stp_role": normSTPRole(role),
			})
		}
	}
	return out, nil
}

// ── MAC / ARP / inventory collection (AOS-CX REST) ────────────────────────────

// firstStr returns the first non-empty string among the given values.
func firstStr(vals ...any) string {
	for _, v := range vals {
		if s, ok := v.(string); ok && s != "" {
			return s
		}
	}
	return ""
}

// arubaRefName resolves an AOS-CX reference attribute to a name. Ports come back
// either as a plain name string or a {"<name>": "/rest/.../<name>"} map.
func arubaRefName(vals ...any) string {
	for _, v := range vals {
		switch t := v.(type) {
		case string:
			if t != "" {
				return t
			}
		case map[string]any:
			for k := range t {
				return k
			}
		}
	}
	return ""
}

// collectAddresses returns ARP/ND + MAC FDB records for the hub
// /collectors/addresses ingest. Field names are matched tolerantly across
// firmware variants.
func (a *ArubaClient) collectAddresses(ctx context.Context, deviceID string) ([]map[string]any, error) {
	p2 := url.Values{}
	p2.Set("depth", "2")
	var records []map[string]any

	for _, vrf := range []string{"default", "mgmt"} {
		raw, err := a.Get(ctx, "/system/vrfs/"+vrf+"/neighbors", p2)
		if err != nil {
			continue
		}
		m, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		for key, obj := range m {
			o, _ := obj.(map[string]any)
			ip := firstStr(o["ip_address"], o["ip"])
			if ip == "" {
				ip = strings.Split(key, ",")[0]
			}
			mac := firstStr(o["mac"], o["mac_addr"], o["mac_address"])
			if ip == "" || mac == "" {
				continue
			}
			records = append(records, map[string]any{
				"device_id": deviceID, "ip_address": ip, "mac_address": mac,
				"interface_name": arubaRefName(o["port"], o["mac_port"], o["interface"]),
			})
		}
	}

	p1 := url.Values{}
	p1.Set("depth", "1")
	if rawVlans, err := a.Get(ctx, "/system/vlans", p1); err == nil {
		if vm, ok := rawVlans.(map[string]any); ok {
			for vid := range vm {
				raw, err := a.Get(ctx, "/system/vlans/"+vid+"/macs", p2)
				if err != nil {
					continue
				}
				m, ok := raw.(map[string]any)
				if !ok {
					continue
				}
				vlanID, _ := strconv.Atoi(vid)
				for key, obj := range m {
					o, _ := obj.(map[string]any)
					mac := firstStr(o["mac_addr"], o["mac"], o["mac_address"])
					if mac == "" {
						parts := strings.Split(key, ",")
						mac = parts[len(parts)-1]
					}
					if !strings.Contains(mac, ":") {
						continue
					}
					rec := map[string]any{
						"device_id":   deviceID,
						"mac_address": mac,
						"port_name":   arubaRefName(o["port"], o["mac_port"], o["interface"]),
					}
					if vlanID != 0 {
						rec["vlan_id"] = vlanID
					}
					records = append(records, rec)
				}
			}
		}
	}
	return records, nil
}

// collectInventory returns {device_id, serial_number} from AOS-CX subsystem
// product_info (preferring the chassis subsystem), or nil if unavailable.
func (a *ArubaClient) collectInventory(ctx context.Context, deviceID string) (map[string]any, error) {
	p2 := url.Values{}
	p2.Set("depth", "2")
	raw, err := a.Get(ctx, "/system/subsystems", p2)
	if err != nil {
		return nil, err
	}
	m, ok := raw.(map[string]any)
	if !ok {
		return nil, nil
	}
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		ci := strings.HasPrefix(keys[i], "chassis")
		cj := strings.HasPrefix(keys[j], "chassis")
		if ci != cj {
			return ci
		}
		return keys[i] < keys[j]
	})
	for _, k := range keys {
		o, ok := m[k].(map[string]any)
		if !ok {
			continue
		}
		pi, ok := o["product_info"].(map[string]any)
		if !ok {
			continue
		}
		if s, ok := pi["serial_number"].(string); ok && s != "" {
			return map[string]any{"device_id": deviceID, "serial_number": s}, nil
		}
	}
	return nil, nil
}

// ── ArubaOS-CX HTTP client ────────────────────────────────────────────────────

// ArubaClient is a small cookie-authenticated HTTP client for the ArubaOS-CX
// REST API.  Exported so the collector's HTTP server (package server) can
// reuse it for the generic /aoscx-rest passthrough.
type ArubaClient struct {
	host     string
	username string
	password string
	cookies  []*http.Cookie
	http     *http.Client
}

// NewArubaClient creates a REST client for the ArubaOS-CX device at host,
// authenticating with the given username/password (the same credentials used
// for SSH).
func NewArubaClient(host, username, password string) *ArubaClient {
	return &ArubaClient{
		host:     host,
		username: username,
		password: password,
		http: &http.Client{
			Timeout: 15 * time.Second,
			Transport: &http.Transport{
				TLSClientConfig: &tls.Config{
					InsecureSkipVerify: true, //nolint:gosec — enterprise self-signed certs
				},
			},
		},
	}
}

func (a *ArubaClient) baseURL() string {
	return fmt.Sprintf("https://%s/rest/%s", a.host, arubaAPIVersion)
}

// Login authenticates and stores the session cookie.  It also requests a CSRF
// token (firmware 10.09+ requires one on PUT/POST/DELETE when using cookie
// auth); on firmware that doesn't support CSRF protection the
// X-Use-CSRF-Token header is simply ignored and csrfToken stays empty.
func (a *ArubaClient) Login(ctx context.Context) error {
	form := url.Values{
		"username": {a.username},
		"password": {a.password},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		a.baseURL()+"/login", strings.NewReader(form.Encode()))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := a.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("login returned HTTP %d: %s", resp.StatusCode, string(body))
	}
	io.ReadAll(resp.Body) //nolint:errcheck
	a.cookies = resp.Cookies()
	return nil
}

func (a *ArubaClient) Logout(ctx context.Context) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.baseURL()+"/logout", nil)
	if err != nil {
		return
	}
	for _, ck := range a.cookies {
		req.AddCookie(ck)
	}
	resp, err := a.http.Do(req)
	if err == nil {
		resp.Body.Close()
	}
}

// Get performs a GET request against the AOS-CX REST API and returns the
// parsed JSON body.  Returns an empty map on 404.
func (a *ArubaClient) Get(ctx context.Context, path string, params url.Values) (any, error) {
	rawURL := a.baseURL() + path
	if len(params) > 0 {
		rawURL += "?" + params.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	for _, ck := range a.cookies {
		req.AddCookie(ck)
	}

	resp, err := a.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		return map[string]any{}, nil
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GET %s returned HTTP %d", path, resp.StatusCode)
	}

	var result any
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("decode %s: %w", path, err)
	}
	return result, nil
}

// Put sends a JSON-encoded body via PUT and returns the raw status code and
// response body.  The caller decides how to interpret both — AOS-CX returns
// varying status codes (200/201/204) and bodies (empty or JSON error detail)
// depending on the endpoint and firmware version.
func (a *ArubaClient) Put(ctx context.Context, path string, params url.Values, body any) (int, []byte, error) {
	encoded, err := json.Marshal(body)
	if err != nil {
		return 0, nil, fmt.Errorf("encode body: %w", err)
	}

	rawURL := a.baseURL() + path
	if len(params) > 0 {
		rawURL += "?" + params.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, rawURL, strings.NewReader(string(encoded)))
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	for _, ck := range a.cookies {
		req.AddCookie(ck)
	}

	resp, err := a.http.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return resp.StatusCode, nil, fmt.Errorf("read response: %w", err)
	}
	return resp.StatusCode, respBody, nil
}

// ── State normalisers ─────────────────────────────────────────────────────────

func normBGPState(raw string) string {
	switch strings.ToLower(raw) {
	case "established":
		return "established"
	case "active":
		return "active"
	case "idle":
		return "idle"
	case "connect":
		return "connect"
	case "opensent":
		return "opensent"
	case "openconfirm", "openconfirmed":
		return "openconfirm"
	}
	return "unknown"
}

func normOSPFState(raw string) string {
	switch strings.ToLower(raw) {
	case "full":
		return "full"
	case "two_way", "2-way":
		return "two_way"
	case "init":
		return "init"
	case "exstart":
		return "exstart"
	case "exchange":
		return "exchange"
	case "loading":
		return "loading"
	case "down":
		return "down"
	case "attempt":
		return "attempt"
	}
	return "unknown"
}

// ── BGP collection ────────────────────────────────────────────────────────────

func (a *ArubaClient) collectBGP(ctx context.Context, deviceID string) ([]map[string]any, error) {
	vrfsRaw, err := a.Get(ctx, "/system/vrfs", nil)
	if err != nil {
		return nil, fmt.Errorf("get vrfs: %w", err)
	}
	vrfs, ok := vrfsRaw.(map[string]any)
	if !ok || len(vrfs) == 0 {
		return nil, nil
	}

	var sessions []map[string]any

	for vrfName := range vrfs {
		routersRaw, err := a.Get(ctx, "/system/vrfs/"+vrfName+"/bgp_routers", nil)
		if err != nil {
			continue
		}
		routers, ok := routersRaw.(map[string]any)
		if !ok {
			continue
		}

		for asnStr := range routers {
			var localASN int
			fmt.Sscanf(asnStr, "%d", &localASN)

			nbrsRaw, err := a.Get(ctx,
				"/system/vrfs/"+vrfName+"/bgp_routers/"+asnStr+"/bgp_neighbors",
				url.Values{"depth": {"2"}},
			)
			if err != nil {
				continue
			}
			nbrs, ok := nbrsRaw.(map[string]any)
			if !ok {
				continue
			}

			for peerIP, dataRaw := range nbrs {
				data, ok := dataRaw.(map[string]any)
				if !ok {
					continue
				}
				status, _ := data["status"].(map[string]any)
				stats, _ := data["statistics"].(map[string]any)
				if status == nil {
					status = map[string]any{}
				}
				if stats == nil {
					stats = map[string]any{}
				}

				stateRaw, _ := status["bgp_peer_state"].(string)

				// Prefix statistics live under status.prefix_statistics.<afi-safi>.{received,sent}
				prefixesRx := 0
				prefixesTx := 0
				if pfxStats, ok := status["prefix_statistics"].(map[string]any); ok {
					for _, afiRaw := range pfxStats {
						if afi, ok := afiRaw.(map[string]any); ok {
							prefixesRx += jsonInt(afi["received"])
							prefixesTx += jsonInt(afi["sent"])
						}
					}
				}

				sessions = append(sessions, map[string]any{
					"device_id":            deviceID,
					"vrf":                  vrfName,
					"peer_ip":              peerIP,
					"peer_asn":             data["remote_as"],
					"local_asn":            localASN,
					"description":          data["description"],
					"state":                normBGPState(stateRaw),
					"uptime_s":             jsonInt(stats["bgp_peer_uptime"]),
					"flap_count":           jsonInt(stats["bgp_peer_established_count"]),
					"in_updates":           jsonInt(stats["bgp_peer_update_in_count"]),
					"out_updates":          jsonInt(stats["bgp_peer_update_out_count"]),
					"prefixes_received":    prefixesRx,
					"prefixes_advertised":  prefixesTx,
				})
			}
		}
	}

	return sessions, nil
}

// ── OSPF collection ───────────────────────────────────────────────────────────

func (a *ArubaClient) collectOSPF(ctx context.Context, deviceID string) ([]map[string]any, error) {
	vrfsRaw, err := a.Get(ctx, "/system/vrfs", nil)
	if err != nil {
		return nil, fmt.Errorf("get vrfs: %w", err)
	}
	vrfs, ok := vrfsRaw.(map[string]any)
	if !ok || len(vrfs) == 0 {
		return nil, nil
	}

	var neighbors []map[string]any

	for vrfName := range vrfs {
		routersRaw, err := a.Get(ctx, "/system/vrfs/"+vrfName+"/ospf_routers", nil)
		if err != nil {
			continue
		}
		routers, ok := routersRaw.(map[string]any)
		if !ok {
			continue
		}

		for tag := range routers {
			areasRaw, err := a.Get(ctx,
				"/system/vrfs/"+vrfName+"/ospf_routers/"+tag+"/areas", nil)
			if err != nil {
				continue
			}
			areas, ok := areasRaw.(map[string]any)
			if !ok {
				continue
			}

			for areaID := range areas {
				ifacesRaw, err := a.Get(ctx,
					"/system/vrfs/"+vrfName+"/ospf_routers/"+tag+
						"/areas/"+areaID+"/ospf_interfaces", nil)
				if err != nil {
					continue
				}
				ifaces, ok := ifacesRaw.(map[string]any)
				if !ok {
					continue
				}

				for ifaceName := range ifaces {
					// URL-encode the interface name (e.g. "1/1/1" → "1%2F1%2F1").
					ifaceEnc := url.PathEscape(ifaceName)

					nbrsRaw, err := a.Get(ctx,
						"/system/vrfs/"+vrfName+"/ospf_routers/"+tag+
							"/areas/"+areaID+"/ospf_interfaces/"+ifaceEnc+"/ospf_neighbors",
						url.Values{"depth": {"2"}},
					)
					if err != nil {
						continue
					}
					nbrs, ok := nbrsRaw.(map[string]any)
					if !ok {
						continue
					}

					for routerIDKey, nbrRaw := range nbrs {
						nbr, ok := nbrRaw.(map[string]any)
						if !ok {
							continue
						}

						neighborID, _ := nbr["nbr_router_id"].(string)
						if neighborID == "" {
							neighborID = routerIDKey
						}
						neighborIP, _ := nbr["nbr_if_addr"].(string)
						if neighborIP == "" {
							neighborIP = routerIDKey
						}
						stateRaw, _ := nbr["nfsm_state"].(string)

						neighbors = append(neighbors, map[string]any{
							"device_id":      deviceID,
							"vrf":            vrfName,
							"router_id":      neighborID,
							"neighbor_ip":    neighborIP,
							"interface_name": ifaceName,
							"area":           areaID,
							"state":          normOSPFState(stateRaw),
						})
					}
				}
			}
		}
	}

	return neighbors, nil
}

// ── Routes ────────────────────────────────────────────────────────────────────

// collectRoutes fetches the RIB for the "default" VRF via the AOS-CX Route
// table (/system/vrfs/default/routes?depth=2) and returns route_entries-shaped
// records, one per nexthop so ECMP routes are preserved under
// route_entries' UNIQUE(device_id, destination, next_hop) constraint.
//
// Only the default VRF is collected — route_entries has no VRF column, and
// other VRFs (e.g. "mgmt") are not reachable from the default VRF without an
// explicit route leak, so mixing them in would let path-trace hop through
// routes that don't actually carry default-VRF traffic.
func (a *ArubaClient) collectRoutes(ctx context.Context, deviceID string) ([]map[string]any, error) {
	routesRaw, err := a.Get(ctx, "/system/vrfs/default/routes", url.Values{"depth": {"2"}})
	if err != nil {
		return nil, fmt.Errorf("get routes: %w", err)
	}
	routeMap, ok := routesRaw.(map[string]any)
	if !ok {
		return nil, nil
	}

	var routes []map[string]any

	for _, routeRaw := range routeMap {
		route, ok := routeRaw.(map[string]any)
		if !ok {
			continue
		}
		prefix, _ := route["prefix"].(string)
		if prefix == "" {
			continue
		}
		fromRaw, _ := route["from"].(string)
		proto := normArubaRouteOwner(fromRaw)

		nexthops := a.arubaRouteNexthops(ctx, route["nexthops"])
		if len(nexthops) == 0 && proto == "static" {
			// Static routes not yet selected into the FIB carry their
			// configured nexthop(s) under static_nexthops instead of
			// nexthops.
			nexthops = a.arubaRouteNexthops(ctx, route["static_nexthops"])
		}

		if len(nexthops) == 0 {
			// Connected routes (no next-hop IP, just an egress port) and
			// "nullroute"/blackhole statics both land here with an empty
			// next_hop. This is also the safety net for any nexthops shape
			// arubaRouteNexthops doesn't recognise, so a route is never
			// silently dropped from route_entries.
			routes = append(routes, map[string]any{
				"device_id":      deviceID,
				"destination":    prefix,
				"next_hop":       "",
				"protocol":       proto,
				"metric":         0,
				"interface_name": "",
			})
			continue
		}

		for _, nh := range nexthops {
			routes = append(routes, map[string]any{
				"device_id":      deviceID,
				"destination":    prefix,
				"next_hop":       nh.ip,
				"protocol":       proto,
				"metric":         nh.metric,
				"interface_name": nh.iface,
			})
		}
	}

	return routes, nil
}

// arubaNexthopEntry holds the route_entries-relevant fields of a single
// AOS-CX Route_Nexthop.
type arubaNexthopEntry struct {
	ip     string
	iface  string
	metric int
}

// arubaRouteNexthops normalises a Route's "nexthops" (or "static_nexthops")
// reference set into a flat list of next-hop entries.
//
// At depth=2, AOS-CX REST is expected to expand each nexthop reference into
// its full Route_Nexthop object — but for routes with a non-empty nexthop
// set (connected interfaces, OSPF/BGP-learned routes, default routes) the
// reference set has been observed coming back as {key: "<URI>"} or
// ["<URI>", ...] instead, with the objects left unexpanded. Both shapes are
// handled here, following any unexpanded URI with one extra GET so the real
// next-hop IP/interface is still captured instead of the route disappearing.
func (a *ArubaClient) arubaRouteNexthops(ctx context.Context, raw any) []arubaNexthopEntry {
	var refs []any
	switch v := raw.(type) {
	case map[string]any:
		for _, nh := range v {
			refs = append(refs, nh)
		}
	case []any:
		refs = v
	default:
		return nil
	}

	var out []arubaNexthopEntry
	for _, nhRaw := range refs {
		switch nh := nhRaw.(type) {
		case map[string]any:
			out = append(out, parseArubaNexthop(nh))
		case string:
			obj, err := a.Get(ctx, arubaRefPath(nh), url.Values{"depth": {"2"}})
			if err != nil {
				continue
			}
			if m, ok := obj.(map[string]any); ok && len(m) > 0 {
				out = append(out, parseArubaNexthop(m))
			}
		}
	}
	return out
}

// parseArubaNexthop extracts route_entries fields from an expanded
// Route_Nexthop object.
func parseArubaNexthop(nh map[string]any) arubaNexthopEntry {
	ip, _ := nh["ip_address"].(string)
	return arubaNexthopEntry{
		ip:     ip,
		iface:  arubaPortName(nh["port"]),
		metric: jsonInt(nh["distance"]),
	}
}

// arubaRefPath strips the "/rest/<version>" prefix from an absolute AOS-CX
// REST resource URI so it can be re-used with ArubaClient.Get, which
// prepends the base URL itself.
func arubaRefPath(uri string) string {
	prefix := "/rest/" + arubaAPIVersion
	if rest, ok := strings.CutPrefix(uri, prefix); ok {
		return rest
	}
	return uri
}

// arubaPortName extracts the port/interface name from a Route_Nexthop's
// "port" reference field, which AOS-CX REST returns as either a bare string
// or a {"<name>": "/rest/.../system/ports/<name>"} reference object.
func arubaPortName(v any) string {
	switch p := v.(type) {
	case string:
		return p
	case map[string]any:
		for _, refRaw := range p {
			ref, ok := refRaw.(string)
			if !ok {
				continue
			}
			i := strings.LastIndex(ref, "/")
			if i < 0 {
				continue
			}
			if name, err := url.PathUnescape(ref[i+1:]); err == nil {
				return name
			}
			return ref[i+1:]
		}
	}
	return ""
}

// normArubaRouteOwner maps AOS-CX Route.from values to the same protocol
// vocabulary used by SNMP/eAPI (cidrProtoName/normEOSRouteType).
func normArubaRouteOwner(raw string) string {
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
	default:
		return "other"
	}
}

// ── helpers ───────────────────────────────────────────────────────────────────

// jsonInt converts a JSON-decoded numeric value (float64 from encoding/json)
// to int, returning 0 on failure.
func jsonInt(v any) int {
	switch n := v.(type) {
	case float64:
		return int(n)
	case int:
		return n
	case int64:
		return int(n)
	}
	return 0
}
