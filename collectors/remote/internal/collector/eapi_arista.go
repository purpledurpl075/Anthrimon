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

	"github.com/purpledurpl075/anthri-mon/collectors/remote/internal/hub"
)

const eapiCollectEvery = 5 * time.Minute

// ── AristaEAPICollector ───────────────────────────────────────────────────────

// AristaEAPICollector collects IS-IS adjacency state from Arista EOS devices
// via eAPI and forwards results to the hub.
type AristaEAPICollector struct {
	hubClient *hub.Client
	mu        sync.RWMutex
	devices   []hub.Device
	logger    zerolog.Logger
}

// NewAristaEAPICollector creates a new Arista eAPI IS-IS collector.
func NewAristaEAPICollector(hubClient *hub.Client, logger zerolog.Logger) *AristaEAPICollector {
	return &AristaEAPICollector{
		hubClient: hubClient,
		logger:    logger.With().Str("subsystem", "arista_eapi").Logger(),
	}
}

// SetDevices replaces the current device list.
func (c *AristaEAPICollector) SetDevices(devices []hub.Device) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.devices = devices
}

// Run starts the periodic eAPI collection loop.
func (c *AristaEAPICollector) Run(ctx context.Context) {
	ticker := time.NewTicker(eapiCollectEvery)
	defer ticker.Stop()

	c.collectAll(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			c.collectAll(ctx)
		}
	}
}

// collectAll runs IS-IS collection for every eAPI-enabled Arista device.
func (c *AristaEAPICollector) collectAll(ctx context.Context) {
	c.mu.RLock()
	devices := make([]hub.Device, len(c.devices))
	copy(devices, c.devices)
	c.mu.RUnlock()

	for _, dev := range devices {
		if !dev.EapiEnabled {
			continue
		}
		if dev.Vendor != "arista" {
			continue
		}
		adjs, err := c.collectDevice(ctx, dev)
		if err != nil {
			c.logger.Warn().Err(err).Str("device", dev.Hostname).Msg("arista eapi collection failed")
			continue
		}
		if len(adjs) == 0 {
			continue
		}
		if err := c.hubClient.PostISISNeighbors(ctx, adjs); err != nil {
			c.logger.Warn().Err(err).Str("device", dev.Hostname).Msg("isis post to hub failed")
		} else {
			c.logger.Info().
				Str("device", dev.Hostname).
				Int("adjacencies", len(adjs)).
				Msg("isis neighbors posted")
		}
	}
}

// collectDevice fetches IS-IS adjacency state from one Arista device via eAPI.
func (c *AristaEAPICollector) collectDevice(ctx context.Context, dev hub.Device) ([]map[string]any, error) {
	cred := dev.SSHCredential()
	if cred == nil {
		return nil, fmt.Errorf("no credential for %s", dev.Hostname)
	}
	username, _ := cred.Data["username"].(string)
	password, _ := cred.Data["password"].(string)

	result, err := eapiCall(ctx, dev.MgmtIP, username, password, dev.EapiAllowHTTP, []string{"show isis neighbors"})
	if err != nil {
		return nil, err
	}
	if len(result) == 0 {
		return nil, nil
	}

	return parseISISNeighbors(dev.ID, result[0]), nil
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

func eapiCall(ctx context.Context, host, username, password string, allowHTTP bool, cmds []string) ([]map[string]any, error) {
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

	schemes := []string{"https"}
	if allowHTTP {
		schemes = append(schemes, "http")
	}

	for _, scheme := range schemes {
		url := fmt.Sprintf("%s://%s/command-api", scheme, host)
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
		if err != nil {
			continue
		}
		req.Header.Set("Content-Type", "application/json")
		req.SetBasicAuth(username, password)

		resp, err := eapiHTTP.Do(req)
		if err != nil {
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
