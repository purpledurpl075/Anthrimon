// Package bootstrap handles the one-time registration of the collector with
// the Anthrimon hub and generation of WireGuard key material.
package bootstrap

import (
	"bytes"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/purpledurpl075/anthri-mon/collectors/remote/internal/config"
	"github.com/purpledurpl075/anthri-mon/collectors/remote/internal/state"
)

// bootstrapRequest is the JSON body sent to POST /api/v1/collectors/bootstrap.
type bootstrapRequest struct {
	Token        string   `json:"token"`
	WGPublicKey  string   `json:"wg_public_key"`
	Hostname     string   `json:"hostname"`
	Version      string   `json:"version"`
	Capabilities []string `json:"capabilities"`
}

// bootstrapResponse is the JSON body returned by the hub on success.
type bootstrapResponse struct {
	CollectorID   string `json:"collector_id"`
	APIKey        string `json:"api_key"`
	WGAssignedIP  string `json:"wg_assigned_ip"`
	WGHubPubkey   string `json:"wg_hub_pubkey"`
	WGHubEndpoint string `json:"wg_hub_endpoint"`
	CACert        string `json:"ca_cert"`
}

// GenerateWGKeypair generates a WireGuard private/public key pair by shelling
// out to the `wg` command-line tool (part of wireguard-tools).
func GenerateWGKeypair() (privKey, pubKey string, err error) {
	// Generate private key.
	privCmd := exec.Command("wg", "genkey")
	privOut, err := privCmd.Output()
	if err != nil {
		return "", "", fmt.Errorf("wg genkey: %w", err)
	}
	privKey = strings.TrimSpace(string(privOut))

	// Derive public key from private key.
	pubCmd := exec.Command("wg", "pubkey")
	pubCmd.Stdin = strings.NewReader(privKey + "\n")
	pubOut, err := pubCmd.Output()
	if err != nil {
		return "", "", fmt.Errorf("wg pubkey: %w", err)
	}
	pubKey = strings.TrimSpace(string(pubOut))

	return privKey, pubKey, nil
}

// Bootstrap performs the one-time registration with the hub.
// It reads the CA certificate from cfg.CACert, posts the registration request,
// and returns a populated State on success.
func Bootstrap(cfg *config.Config, hostname, version string) (*state.State, error) {
	privKey, pubKey, err := GenerateWGKeypair()
	if err != nil {
		return nil, fmt.Errorf("generate wg keypair: %w", err)
	}

	httpClient, err := buildHTTPClient(cfg.CACert)
	if err != nil {
		return nil, fmt.Errorf("build http client: %w", err)
	}

	reqBody := bootstrapRequest{
		Token:        cfg.Token,
		WGPublicKey:  pubKey,
		Hostname:     hostname,
		Version:      version,
		Capabilities: []string{"snmp", "flow", "syslog"},
	}
	body, err := json.Marshal(reqBody)
	if err != nil {
		return nil, fmt.Errorf("marshal bootstrap request: %w", err)
	}

	url := strings.TrimRight(cfg.HubURL, "/") + "/api/v1/collectors/bootstrap"
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("create bootstrap request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("bootstrap POST %s: %w", url, err)
	}
	defer resp.Body.Close()

	respData, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read bootstrap response: %w", err)
	}

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		return nil, fmt.Errorf("bootstrap failed: HTTP %d: %s", resp.StatusCode, string(respData))
	}

	var bResp bootstrapResponse
	if err := json.Unmarshal(respData, &bResp); err != nil {
		return nil, fmt.Errorf("parse bootstrap response: %w", err)
	}

	// Persist the hub-provided CA cert if returned.
	if bResp.CACert != "" && cfg.CACert != "" {
		if err := os.WriteFile(cfg.CACert, []byte(bResp.CACert), 0640); err != nil {
			return nil, fmt.Errorf("write CA cert to %s: %w", cfg.CACert, err)
		}
	}

	st := &state.State{
		CollectorID:   bResp.CollectorID,
		APIKey:        bResp.APIKey,
		WGPrivateKey:  privKey,
		WGPublicKey:   pubKey,
		WGAssignedIP:  bResp.WGAssignedIP,
		WGHubPubkey:   bResp.WGHubPubkey,
		WGHubEndpoint: bResp.WGHubEndpoint,
	}
	return st, nil
}

// buildHTTPClient returns an *http.Client that trusts caCertPath in addition
// to the system root CAs.  If the file does not exist the system pool is used
// alone (graceful degradation during first-boot before CA is provisioned).
func buildHTTPClient(caCertPath string) (*http.Client, error) {
	pool, err := x509.SystemCertPool()
	if err != nil {
		pool = x509.NewCertPool()
	}

	if caCertPath != "" {
		caPEM, err := os.ReadFile(caCertPath)
		if err == nil {
			pool.AppendCertsFromPEM(caPEM)
		}
		// If the file doesn't exist yet we continue with the system pool.
	}

	tlsCfg := &tls.Config{
		RootCAs:    pool,
		MinVersion: tls.VersionTLS12,
	}

	return &http.Client{
		Transport: &http.Transport{TLSClientConfig: tlsCfg},
		Timeout:   30 * time.Second,
	}, nil
}
