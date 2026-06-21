// Package sshtofu provides trust-on-first-use (TOFU) SSH host-key verification
// for the remote collector's connections to managed devices.
//
// Previously the collector dialed devices with ssh.InsecureIgnoreHostKey(),
// so a machine-in-the-middle on the device LAN could impersonate a device and
// capture the privileged SSH/enable credentials the collector sends. This
// package pins host keys in a known_hosts file with TOFU semantics:
//
//   - first contact with a device → its key is learned and persisted (accepted)
//   - later contact, key matches    → accepted
//   - later contact, key changed    → REJECTED (the connection fails)
//
// Because the file starts empty, the existing fleet is all "first contact" on
// the first run after upgrade — nothing is locked out; only a changed key (the
// MITM signal, or a legitimately re-provisioned device) is refused thereafter.
// To re-learn a device whose key legitimately changed, delete its line from the
// known_hosts file. Set ANTHRIMON_SSH_PINNING=off to fall back to the old
// (unpinned) behavior.
package sshtofu

import (
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

// DefaultPath is the known_hosts location; override with ANTHRIMON_SSH_KNOWN_HOSTS.
const DefaultPath = "/etc/anthrimon/collector_known_hosts"

var mu sync.Mutex

func path() string {
	if p := os.Getenv("ANTHRIMON_SSH_KNOWN_HOSTS"); p != "" {
		return p
	}
	return DefaultPath
}

func enabled() bool {
	return !strings.EqualFold(os.Getenv("ANTHRIMON_SSH_PINNING"), "off")
}

func ensureFile(p string) error {
	if _, err := os.Stat(p); err == nil {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	f, err := os.OpenFile(p, os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	return f.Close()
}

// HostKeyCallback returns an ssh.HostKeyCallback implementing TOFU pinning.
// When pinning is disabled it returns InsecureIgnoreHostKey() so behavior is
// unchanged. It never errors on setup — on a bookkeeping failure it logs via the
// returned error path only at connect time, never preventing the collector from
// starting.
func HostKeyCallback() ssh.HostKeyCallback {
	if !enabled() {
		return ssh.InsecureIgnoreHostKey() //nolint:gosec — pinning explicitly disabled
	}
	p := path()
	if err := ensureFile(p); err != nil {
		// Store unavailable — fail loudly rather than silently downgrading to
		// InsecureIgnoreHostKey. A silent fallback would allow MITM while
		// appearing to work normally. Operators must fix the permissions or
		// explicitly set ANTHRIMON_SSH_PINNING=off to disable pinning.
		storeErr := err
		return func(hostname string, _ net.Addr, _ ssh.PublicKey) error {
			return fmt.Errorf(
				"sshtofu: host-key store unavailable (fix perms on %s or set ANTHRIMON_SSH_PINNING=off to disable): %w",
				p, storeErr,
			)
		}
	}
	return func(hostname string, remote net.Addr, key ssh.PublicKey) error {
		mu.Lock()
		defer mu.Unlock()

		// Re-read the file each call so a key learned earlier this process is seen.
		cb, err := knownhosts.New(p)
		if err != nil {
			return fmt.Errorf("sshtofu: load known_hosts: %w", err)
		}
		err = cb(hostname, remote, key)
		if err == nil {
			return nil // known host, key matches
		}
		var keyErr *knownhosts.KeyError
		if errors.As(err, &keyErr) {
			if len(keyErr.Want) == 0 {
				// Unknown host → learn it (TOFU) and accept.
				return learn(p, hostname, remote, key)
			}
			// Known host, key changed → reject.
			return fmt.Errorf("sshtofu: host key mismatch for %s (possible MITM): %w", hostname, err)
		}
		return err
	}
}

// learn appends the host key to the known_hosts file and accepts the connection.
func learn(p, hostname string, remote net.Addr, key ssh.PublicKey) error {
	addrs := []string{knownhosts.Normalize(hostname)}
	if remote != nil {
		if rn := knownhosts.Normalize(remote.String()); rn != addrs[0] {
			addrs = append(addrs, rn)
		}
	}
	line := knownhosts.Line(addrs, key)

	f, err := os.OpenFile(p, os.O_APPEND|os.O_WRONLY|os.O_CREATE, 0o600)
	if err != nil {
		return fmt.Errorf("sshtofu: persist learned host key: %w", err)
	}
	defer f.Close()
	if _, err := f.WriteString(line + "\n"); err != nil {
		return fmt.Errorf("sshtofu: write learned host key: %w", err)
	}
	return nil // accept this first-contact connection
}
