// Package hub provides an authenticated HTTP client for the Anthrimon hub
// collector API.  All requests are sent through the WireGuard tunnel and
// require a Bearer API key obtained during bootstrap.
package hub

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// ─── Domain types returned by GET /api/v1/collectors/config ──────────────────

// DeviceConfig is the full device list returned by the hub.
type DeviceConfig struct {
	CollectorID      string   `json:"collector_id"`
	Timezone         string   `json:"timezone"`           // collector-level IANA timezone
	StateIntervalS   int      `json:"state_interval_s"`   // fast-path state poll cadence (BGP/OSPF/ISIS)
	CounterIntervalS int      `json:"counter_interval_s"` // slow-path counter/topology poll cadence
	Devices          []Device `json:"devices"`
	GeneratedAt      string   `json:"generated_at"`
}

// Device represents a single monitored device assigned to this collector.
type Device struct {
	ID                    string       `json:"id"`
	Hostname              string       `json:"hostname"`
	MgmtIP                string       `json:"mgmt_ip"`
	Vendor                string       `json:"vendor"`
	DeviceType            string       `json:"device_type"`
	SNMPPort              int          `json:"snmp_port"`
	PollingIntervalS      int          `json:"polling_interval_s"`
	Credentials           []Credential `json:"credentials"`
	RestCollectionEnabled bool         `json:"rest_collection_enabled"`
	EapiEnabled           bool         `json:"eapi_enabled"`
	EapiAllowHTTP         bool         `json:"eapi_allow_http"`
	ConfigIntervalS       int          `json:"config_interval_s"`
}

// SSHCredential returns the highest-priority SSH credential for the device,
// or nil if none is assigned.
func (d *Device) SSHCredential() *Credential {
	for i := range d.Credentials {
		if d.Credentials[i].Type == "ssh" {
			return &d.Credentials[i]
		}
	}
	return nil
}

// Credential holds a single authentication credential for a device.
type Credential struct {
	Type     string         `json:"type"`
	Priority int            `json:"priority"`
	Data     map[string]any `json:"data"`
}

// ─── Client ──────────────────────────────────────────────────────────────────

// Client is an authenticated HTTP client for the hub collector API.
type Client struct {
	hubURL     string
	apiKey     string
	httpClient *http.Client
}

// NewClient builds a Client that trusts the given CA certificate (PEM file
// path).  If caCertPath is empty or the file is absent the system pool is used.
func NewClient(hubURL, apiKey, caCertPath string) *Client {
	pool, err := x509.SystemCertPool()
	if err != nil {
		pool = x509.NewCertPool()
	}

	if caCertPath != "" {
		if pem, err := os.ReadFile(caCertPath); err == nil {
			pool.AppendCertsFromPEM(pem)
		}
	}

	tlsCfg := &tls.Config{
		RootCAs:    pool,
		MinVersion: tls.VersionTLS12,
	}

	return &Client{
		hubURL: strings.TrimRight(hubURL, "/"),
		apiKey: apiKey,
		httpClient: &http.Client{
			Transport: &http.Transport{TLSClientConfig: tlsCfg},
			Timeout:   30 * time.Second,
		},
	}
}

// ─── API methods ─────────────────────────────────────────────────────────────

// Heartbeat sends a heartbeat to the hub.  stats is an arbitrary map of
// collector statistics that will be included in the payload.
func (c *Client) Heartbeat(ctx context.Context, version string, stats map[string]any) error {
	payload := map[string]any{
		"version": version,
		"stats":   stats,
	}
	return c.postJSON(ctx, "/api/v1/collectors/heartbeat", payload, nil)
}

// FetchConfig retrieves the current device list from the hub.
func (c *Client) FetchConfig(ctx context.Context) (*DeviceConfig, error) {
	req, err := c.newRequest(ctx, http.MethodGet, "/api/v1/collectors/config", nil)
	if err != nil {
		return nil, err
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("GET /config: %w", err)
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read config response: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GET /config: HTTP %d: %s", resp.StatusCode, string(data))
	}

	var cfg DeviceConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("parse config response: %w", err)
	}
	return &cfg, nil
}

// PostMetrics forwards a Prometheus text exposition to the hub.
func (c *Client) PostMetrics(ctx context.Context, prometheusText string) error {
	req, err := c.newRequest(ctx, http.MethodPost, "/api/v1/collectors/metrics",
		strings.NewReader(prometheusText))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "text/plain; version=0.0.4")
	return c.doAndDiscard(req)
}

// PostFlows sends a batch of flow records to the hub.
func (c *Client) PostFlows(ctx context.Context, records []map[string]any) error {
	return c.postJSON(ctx, "/api/v1/collectors/flows", records, nil)
}

// PostSyslog sends a batch of syslog records to the hub.
func (c *Client) PostSyslog(ctx context.Context, records []map[string]any) error {
	return c.postJSON(ctx, "/api/v1/collectors/syslog", records, nil)
}

// PostConfigBackup sends a device running-configuration snapshot to the hub.
// The hub stores it, diffs it against the previous backup, and fires
// config-change alerts if applicable.
func (c *Client) PostConfigBackup(ctx context.Context, deviceID, configText, method string) error {
	return c.postJSON(ctx, "/api/v1/collectors/config-backup", map[string]any{
		"device_id":   deviceID,
		"config_text": configText,
		"method":      method,
	}, nil)
}

// PostBGPSessions sends one device's current BGP session list to the hub,
// including when empty. An empty list tells the hub this device now has
// zero BGP sessions, so any previously-reported sessions for it should be
// marked stale (session_state='idle').
func (c *Client) PostBGPSessions(ctx context.Context, deviceID string, sessions []map[string]any) error {
	if sessions == nil {
		sessions = []map[string]any{}
	}
	body := map[string]any{"device_id": deviceID, "sessions": sessions}
	return c.postJSON(ctx, "/api/v1/collectors/bgp-sessions", body, nil)
}

// PostLogs sends a batch of collector operational log entries to the hub.
func (c *Client) PostLogs(ctx context.Context, entries []map[string]any) error {
	return c.postJSON(ctx, "/api/v1/collectors/collector-logs", entries, nil)
}

// PostOSPFNeighbors sends one device's current OSPF neighbor list to the hub,
// including when empty. An empty list tells the hub this device now has zero
// OSPF neighbors, so any previously-reported neighbors for it should be
// marked down.
func (c *Client) PostOSPFNeighbors(ctx context.Context, deviceID string, neighbors []map[string]any) error {
	if neighbors == nil {
		neighbors = []map[string]any{}
	}
	body := map[string]any{"device_id": deviceID, "neighbors": neighbors}
	return c.postJSON(ctx, "/api/v1/collectors/ospf-neighbors", body, nil)
}

// PostISISNeighbors sends one device's current IS-IS adjacency list to the
// hub, including when empty. An empty list tells the hub this device now has
// zero adjacencies, so any previously-reported neighbors for it should be
// marked down.
func (c *Client) PostISISNeighbors(ctx context.Context, deviceID string, neighbors []map[string]any) error {
	if neighbors == nil {
		neighbors = []map[string]any{}
	}
	body := map[string]any{"device_id": deviceID, "neighbors": neighbors}
	return c.postJSON(ctx, "/api/v1/collectors/isis-neighbors", body, nil)
}

// PostSTPPorts sends per-interface STP state records to the hub.
// Each record must contain: device_id, if_index (int), stp_state, stp_role.
func (c *Client) PostSTPPorts(ctx context.Context, ports []map[string]any) error {
	return c.postJSON(ctx, "/api/v1/collectors/stp-ports", ports, nil)
}

// PostAddresses sends a flat list of address records to the hub. Records with an
// ip_address are ARP/ND entries; records with only mac_address are FDB entries.
func (c *Client) PostAddresses(ctx context.Context, records []map[string]any) error {
	return c.postJSON(ctx, "/api/v1/collectors/addresses", records, nil)
}

// PostDeviceInventory sends [{device_id, serial_number}] records to the hub.
func (c *Client) PostDeviceInventory(ctx context.Context, records []map[string]any) error {
	return c.postJSON(ctx, "/api/v1/collectors/device-inventory", records, nil)
}

// PostVLANs sends a flat list of VLAN records to the hub. Each record is either
// a VLAN definition ({device_id, vlan_id, name}) or a per-interface membership
// ({device_id, vlan_id, if_name, tagged}). The hub upserts vlans and replaces
// the device's interface_vlans.
func (c *Client) PostVLANs(ctx context.Context, records []map[string]any) error {
	return c.postJSON(ctx, "/api/v1/collectors/vlans", records, nil)
}

// PostRoutes sends one device's current route table to the hub, including
// when empty. An empty list tells the hub this device's routing table is
// currently empty; the hub upserts whatever rows ARE present and removes any
// previously-reported rows for that device not present in this batch.
// Each record must contain: destination, protocol, and optionally next_hop,
// metric, interface_name.
func (c *Client) PostRoutes(ctx context.Context, deviceID string, routes []map[string]any) error {
	if routes == nil {
		routes = []map[string]any{}
	}
	body := map[string]any{"device_id": deviceID, "routes": routes}
	return c.postJSON(ctx, "/api/v1/collectors/routes", body, nil)
}

// PostEngineIDs sends SNMP engine IDs discovered via v3 USM handshake to the hub.
// Each record: device_id (string), engine_id (lowercase hex string, no 0x prefix).
func (c *Client) PostEngineIDs(ctx context.Context, records []map[string]any) error {
	return c.postJSON(ctx, "/api/v1/collectors/engine-ids", records, nil)
}

// PostTraps sends a batch of decoded SNMP trap events to the hub.
func (c *Client) PostTraps(ctx context.Context, collectorID string, events []map[string]any) error {
	return c.postJSON(ctx, "/api/v1/collectors/traps", map[string]any{
		"collector_id": collectorID,
		"events":       events,
	}, nil)
}

// DownloadBinary fetches the latest collector binary for the given architecture
// from the hub.  Returns the raw bytes and the expected SHA-256 hex digest
// from the X-Binary-SHA256 response header (empty string if the hub did not
// provide one).
func (c *Client) DownloadBinary(ctx context.Context, arch string) ([]byte, string, error) {
	req, err := c.newRequest(ctx, http.MethodGet,
		"/api/v1/collectors/binary?arch="+arch, nil)
	if err != nil {
		return nil, "", err
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, "", fmt.Errorf("GET /collectors/binary: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, "", fmt.Errorf("GET /collectors/binary: HTTP %d: %s",
			resp.StatusCode, string(body))
	}

	data, err := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	if err != nil {
		return nil, "", fmt.Errorf("read binary body: %w", err)
	}

	sha256hex := resp.Header.Get("X-Binary-SHA256")
	return data, sha256hex, nil
}

// DownloadTrapHandler fetches the pre-built anthrimon-traphandler binary.
// Same semantics as DownloadBinary.
func (c *Client) DownloadTrapHandler(ctx context.Context, arch string) ([]byte, string, error) {
	req, err := c.newRequest(ctx, http.MethodGet,
		"/api/v1/collectors/trap-handler-binary?arch="+arch, nil)
	if err != nil {
		return nil, "", err
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, "", fmt.Errorf("GET /collectors/trap-handler-binary: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, "", fmt.Errorf("GET /collectors/trap-handler-binary: HTTP %d: %s",
			resp.StatusCode, string(body))
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if err != nil {
		return nil, "", fmt.Errorf("read trap-handler body: %w", err)
	}
	return data, resp.Header.Get("X-Binary-SHA256"), nil
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

func (c *Client) newRequest(ctx context.Context, method, path string, body io.Reader) (*http.Request, error) {
	url := c.hubURL + path
	req, err := http.NewRequestWithContext(ctx, method, url, body)
	if err != nil {
		return nil, fmt.Errorf("build request %s %s: %w", method, url, err)
	}
	req.Header.Set("Authorization", "Bearer "+c.apiKey)
	return req, nil
}

func (c *Client) postJSON(ctx context.Context, path string, payload any, out any) error {
	data, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal payload for %s: %w", path, err)
	}

	req, err := c.newRequest(ctx, http.MethodPost, path, bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("POST %s: %w", path, err)
	}
	defer resp.Body.Close()

	respData, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("POST %s: HTTP %d: %s", path, resp.StatusCode, string(respData))
	}

	if out != nil {
		return json.Unmarshal(respData, out)
	}
	return nil
}

func (c *Client) doAndDiscard(req *http.Request) error {
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("request %s %s: %w", req.Method, req.URL.Path, err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("%s %s: HTTP %d: %s", req.Method, req.URL.Path, resp.StatusCode, string(data))
	}
	return nil
}
