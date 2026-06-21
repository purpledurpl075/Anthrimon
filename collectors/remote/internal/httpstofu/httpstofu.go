// Package httpstofu provides trust-on-first-use (TOFU) TLS certificate pinning
// for the remote collector's REST connections to managed devices.
//
// Managed devices use self-signed TLS certificates with no shared CA, so
// traditional CA-chain verification is impractical. This package pins each
// device's certificate by its SHA-256 fingerprint in a per-host file:
//
//   - first connection to a device → fingerprint learned and persisted (accepted)
//   - later connection, fingerprint matches  → accepted
//   - later connection, fingerprint changed  → REJECTED (possible MITM)
//
// The store directory defaults to /etc/anthrimon/https-tofu/ and can be
// overridden with ANTHRIMON_HTTPS_TOFU_DIR.
// Set ANTHRIMON_HTTPS_PINNING=off to fall back to fully unverified TLS (matches
// the previous InsecureSkipVerify behavior). This is only for environments where
// devices do not support TLS at all and the operator has explicitly accepted the risk.
package httpstofu

import (
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

const defaultStoreDir = "/etc/anthrimon/https-tofu"

var mu sync.Mutex

func storeDir() string {
	if d := os.Getenv("ANTHRIMON_HTTPS_TOFU_DIR"); d != "" {
		return d
	}
	return defaultStoreDir
}

func enabled() bool {
	return !strings.EqualFold(os.Getenv("ANTHRIMON_HTTPS_PINNING"), "off")
}

// fingerprintPath returns the file path for the pinned fingerprint of hostPort.
// The host:port string is sanitized so it's safe as a filename.
func fingerprintPath(dir, hostPort string) string {
	safe := strings.NewReplacer(":", "_", "/", "_", "\\", "_").Replace(hostPort)
	return filepath.Join(dir, safe+".fp")
}

// PinningConfig returns a *tls.Config that implements TOFU certificate pinning
// for the given hostPort (e.g. "10.0.0.1:443"). The config skips CA chain
// validation (necessary for self-signed certs) but enforces fingerprint pinning
// via VerifyConnection.
//
// If pinning is disabled via ANTHRIMON_HTTPS_PINNING=off, the returned config
// has InsecureSkipVerify=true and no VerifyConnection callback — fully unverified,
// matching the old behavior.
func PinningConfig(hostPort string) *tls.Config {
	if !enabled() {
		return &tls.Config{InsecureSkipVerify: true} //nolint:gosec — pinning explicitly disabled
	}

	dir := storeDir()

	return &tls.Config{
		InsecureSkipVerify: true, //nolint:gosec — CA chain skipped; we pin instead via VerifyConnection
		VerifyConnection: func(cs tls.ConnectionState) error {
			if len(cs.PeerCertificates) == 0 {
				return fmt.Errorf("httpstofu: no peer certificate presented by %s", hostPort)
			}
			fpBytes := sha256.Sum256(cs.PeerCertificates[0].Raw)
			fp := hex.EncodeToString(fpBytes[:])
			return verifyOrPin(dir, hostPort, fp)
		},
	}
}

// verifyOrPin checks the stored fingerprint for hostPort. If none is stored yet,
// it pins the supplied fingerprint (TOFU) and returns nil. If one is stored and
// matches, returns nil. If stored but mismatched, returns an error.
func verifyOrPin(dir, hostPort, fp string) error {
	mu.Lock()
	defer mu.Unlock()

	if err := os.MkdirAll(dir, 0o700); err != nil {
		// Can't create store — log and fail closed.
		return fmt.Errorf("httpstofu: cannot create store %s: %w", dir, err)
	}

	p := fingerprintPath(dir, hostPort)
	stored, err := os.ReadFile(p)
	if err != nil {
		if !os.IsNotExist(err) {
			return fmt.Errorf("httpstofu: read pin for %s: %w", hostPort, err)
		}
		// First contact — pin this fingerprint.
		if err := os.WriteFile(p, []byte(fp+"\n"), 0o600); err != nil {
			return fmt.Errorf("httpstofu: write pin for %s: %w", hostPort, err)
		}
		return nil // TOFU: accepted
	}

	pinned := strings.TrimSpace(string(stored))
	if pinned == fp {
		return nil // matches pinned fingerprint
	}
	return fmt.Errorf(
		"httpstofu: certificate fingerprint mismatch for %s (possible MITM)\n  pinned: %s\n  got:    %s\n  to re-pin, delete %s",
		hostPort, pinned, fp, p,
	)
}
