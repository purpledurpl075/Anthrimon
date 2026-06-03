# Deploying Remote Collectors

Remote collectors run at remote sites and push metrics back to the hub over a WireGuard VPN tunnel.

## Prerequisites

- WireGuard installed on the remote host (`apt install wireguard`)
- The remote host can reach the hub on UDP port 51820
- Root or sudo access on the remote host

## Deployment

1. Go to **Collectors** → **Add Collector** in the UI
2. Work through the setup wizard — at the end it will prompt you to download a package
3. Download the package to the remote host
4. Unzip it:
   ```bash
   unzip anthrimon-remote-collector-linux-amd64.zip
   ```
5. Run the install script:
   ```bash
   sudo bash install.sh
   ```

The script installs the collector binary, `snmptrapd` (for SNMP trap collection), configures WireGuard (`wg0`), writes the config file with the issued API key and hub CA certificate, and starts the systemd service.

## After installation

The collector appears in **Collectors** with status **online** within a few seconds. Devices assigned to it will be polled from the remote site. The trap handler binary (`/usr/local/bin/anthrimon-traphandler`) is downloaded from the hub automatically on first start.

## Updating the collector binary

Use the **Hot Patch** button on the Collectors page. This builds the latest binary on the hub and pushes it to the collector over WireGuard without requiring SSH access to the remote host.

## SNMP trap collection

The remote collector receives SNMP traps from devices on the local site via `snmptrapd` (installed automatically by `install.sh`). When you save SNMP v3 credentials for a device on the hub, the hub automatically pushes a trap configuration to the collector, which restarts `snmptrapd` with the updated v3 user keys.

Traps received by the collector are forwarded to the hub in real time and appear under **Logging → Traps**.

### Manual snmptrapd notes

- The trap handler binary lives at `/usr/local/bin/anthrimon-traphandler` and is refreshed automatically on each collector start and on hot-patch
- The hub CA certificate is at `/etc/anthrimon/ca.crt` (must be world-readable — `chmod 644`; the installer sets this correctly)
- The collector state file at `/etc/anthrimon/collector-state.json` must be readable by the `Debian-snmp` group:
  ```bash
  sudo chown root:Debian-snmp /etc/anthrimon/collector-state.json
  sudo chmod 640 /etc/anthrimon/collector-state.json
  ```
  The collector sets these permissions on write, but check this if the trap handler logs authentication errors.

## Troubleshooting

**Collector shows offline:**
- Check WireGuard: `sudo wg show`
- Check the collector service: `sudo systemctl status anthrimon-collector`
- Verify the hub is reachable over WireGuard: `curl https://<hub-wg-ip>/api/v1/health`

**Collector won't start after install:**
- Check logs: `journalctl -u anthrimon-collector -n 50 --no-pager`
- Ensure WireGuard is running: `sudo systemctl status wg-quick@wg0`

**Traps not appearing:**
- Verify `snmptrapd` is running: `sudo systemctl status snmptrapd`
- Check `snmptrapd` logs: `journalctl -u snmptrapd -n 30`
- Confirm the device is sending to the correct IP (the collector's LAN interface, not the WireGuard IP)
- On Ubuntu 24.04, ensure `snmptrapd.socket` is disabled (the installer handles this; verify with `systemctl is-enabled snmptrapd.socket`)

See [Remote Collector Offline](troubleshoot-remote-collector-offline) for a full diagnostic guide.
