# Deploying Remote Collectors

Remote collectors run at remote sites and push metrics back to the hub over a WireGuard VPN tunnel.

## Prerequisites

- WireGuard installed on the remote host (`apt install wireguard`)
- The remote host can reach the hub on UDP port 51820
- Root or sudo access on the remote host
- Root or `CAP_NET_RAW` capability for ICMP probing (optional — SNMP works without it)

## Deployment

1. Go to **Collectors** → **Add Collector** in the UI
2. Work through the setup wizard — at the end it will prompt you to download a package
3. Download the package to the remote host
4. Unzip it:
   ```bash
   unzip anthrimon-collector-*.zip
   ```
5. Run the install script:
   ```bash
   sudo bash install.sh
   ```

The script installs the collector binary, configures WireGuard (`wg0`), writes the config file with the issued API key and hub CA certificate, and starts the systemd service.

## After installation

The collector appears in **Collectors** with status **online** within a few seconds. Devices assigned to it will be polled from the remote site.

## Updating the collector binary

Use the **Hot Patch** button on the Collectors page. This builds the latest binary on the hub and pushes it to the collector over WireGuard without requiring SSH access to the remote host.

## ICMP probing

The remote collector probes assigned devices with ICMP ping every 30 seconds. This requires `CAP_NET_RAW`:

```bash
sudo setcap cap_net_raw+ep /usr/local/bin/anthrimon-remote-collector
```

Or run the service as root. Without this capability, SNMP collection still works — only ping probing is disabled.

## Troubleshooting

**Collector shows offline:**
- Check WireGuard: `sudo wg show`
- Check the collector service: `sudo systemctl status anthrimon-remote-collector`
- Verify the hub is reachable over WireGuard: `curl https://<hub-wg-ip>/api/v1/health`

**Collector won't start after install:**
- Check logs: `journalctl -u anthrimon-remote-collector -n 50 --no-pager`
- Ensure WireGuard is running: `sudo systemctl status wg-quick@wg0`

See [Remote Collector Offline](troubleshoot-remote-collector-offline) for a full diagnostic guide.
