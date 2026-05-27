// Package tunnel manages the wg0 WireGuard interface used by the remote
// collector to reach the Anthrimon hub.  It shells out to wireguard-tools
// (`wg`) and iproute2 (`ip`) which must be installed on the host.
package tunnel

import (
	"fmt"
	"os/exec"
	"strings"

	"github.com/purpledurpl075/anthri-mon/collectors/remote/internal/state"
)

const wgInterface = "wg0"

// Setup brings up the wg0 interface using the credentials in st.
// It is idempotent — if the interface already exists the `ip link add` step is
// silently ignored.
func Setup(st *state.State) error {
	// 1. Create the interface (ignore EEXIST).
	_ = runCmd("ip", "link", "add", wgInterface, "type", "wireguard")

	// 2. Set private key via stdin — no temp file, key never touches disk.
	if err := setWGPrivateKey(wgInterface, st.WGPrivateKey); err != nil {
		return fmt.Errorf("wg set private-key: %w", err)
	}

	// 3. Configure the hub peer.
	if err := runCmd("wg", "set", wgInterface,
		"peer", st.WGHubPubkey,
		"allowed-ips", "0.0.0.0/0",
		"endpoint", st.WGHubEndpoint,
		"persistent-keepalive", "25",
	); err != nil {
		return fmt.Errorf("wg set peer: %w", err)
	}

	// 4. Assign the WireGuard IP (ignore EEXIST).
	_ = runCmd("ip", "addr", "add", st.WGAssignedIP+"/32", "dev", wgInterface)

	// 5. Bring the interface up.
	if err := runCmd("ip", "link", "set", wgInterface, "up"); err != nil {
		return fmt.Errorf("ip link set %s up: %w", wgInterface, err)
	}

	// 6. Add host route to the hub through the tunnel (ignore EEXIST).
	_ = runCmd("ip", "route", "add", "10.100.0.1/32", "dev", wgInterface)

	return nil
}

// Teardown removes the wg0 interface.
func Teardown() error {
	if err := runCmd("ip", "link", "del", wgInterface); err != nil {
		return fmt.Errorf("ip link del %s: %w", wgInterface, err)
	}
	return nil
}

// IsUp returns true when wg0 exists and is in the UP state.
func IsUp() bool {
	out, err := exec.Command("ip", "link", "show", wgInterface).Output()
	if err != nil {
		return false
	}
	return strings.Contains(string(out), "UP")
}

// setWGPrivateKey configures the WireGuard private key for iface without
// writing it to disk.  The key is passed through the process's stdin using
// /proc/self/fd/0 so wg reads it directly — no temp file, no race window.
func setWGPrivateKey(iface, privKey string) error {
	cmd := exec.Command("wg", "set", iface, "private-key", "/proc/self/fd/0")
	cmd.Stdin = strings.NewReader(privKey + "\n")
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("wg set %s private-key: %w — %s",
			iface, err, strings.TrimSpace(string(out)))
	}
	return nil
}

// runCmd executes a command and returns a combined-output error on failure.
func runCmd(name string, args ...string) error {
	out, err := exec.Command(name, args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s %s: %w — %s", name, strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return nil
}
