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
	CollectorID string   `json:"collector_id"`
	Timezone    string   `json:"timezone"` // collector-level IANA timezone
	Devices     []Device `json:"devices"`
	GeneratedAt string   `json:"generated_at"`
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

// PostBGPSessions sends a batch of BGP session state records to the hub.
// Each record must contain a device_id field plus the BGP peer fields.
func (c *Client) PostBGPSessions(ctx context.Context, sessions []map[string]any) error {
	return c.postJSON(ctx, "/api/v1/collectors/bgp-sessions", sessions, nil)
}

// PostLogs sends a batch of collector operational log entries to the hub.
func (c *Client) PostLogs(ctx context.Context, entries []map[string]any) error {
	return c.postJSON(ctx, "/api/v1/collectors/collector-logs", entries, nil)
}

// PostOSPFNeighbors sends a batch of OSPF neighbor state records to the hub.
// Each record must contain a device_id field plus the OSPF neighbor fields.
func (c *Client) PostOSPFNeighbors(ctx context.Context, neighbors []map[string]any) error {
	return c.postJSON(ctx, "/api/v1/collectors/ospf-neighbors", neighbors, nil)
}

// PostISISNeighbors sends a batch of IS-IS adjacency records to the hub.
// Each record must contain a device_id field plus the adjacency fields.
func (c *Client) PostISISNeighbors(ctx context.Context, neighbors []map[string]any) error {
	return c.postJSON(ctx, "/api/v1/collectors/isis-neighbors", neighbors, nil)
}

// PostSTPPorts sends per-interface STP state records to the hub.
// Each record must contain: device_id, if_index (int), stp_state, stp_role.
func (c *Client) PostSTPPorts(ctx context.Context, ports []map[string]any) error {
	return c.postJSON(ctx, "/api/v1/collectors/stp-ports", ports, nil)
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
