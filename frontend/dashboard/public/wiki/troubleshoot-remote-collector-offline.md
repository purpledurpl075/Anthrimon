# Remote Collector Offline

## 1. Check the collector service on the remote host

SSH to the remote host and check the service:

```bash
sudo systemctl status anthrimon-remote-collector
journalctl -u anthrimon-remote-collector -n 50 --no-pager
```

## 2. Check the WireGuard tunnel

```bash
sudo wg show
```

The output should show the hub as a peer with a recent `latest handshake` (within the last few minutes). If the last handshake is old or missing:

- Verify the hub is reachable on **UDP 51820** from the remote host:
  ```bash
  nc -zu <hub-ip> 51820
  ```
- Check the hub's WireGuard interface is up: `sudo wg show` on the hub
- Restart WireGuard on the remote host: `sudo systemctl restart wg-quick@wg0`

## 3. Check the API key is still valid

The collector authenticates to the hub using an API key. If the key was revoked:

1. Go to **Collectors** on the hub
2. Find the collector — if it shows `key_revoked`, regenerate the key
3. On the remote host, update `/etc/anthrimon-collector/config.yaml` with the new key and restart the service

## 4. Re-installing the collector

If the collector needs to be reinstalled, go to **Collectors** → **Add Collector**, run through the setup wizard, download a fresh package, and re-run `install.sh` on the remote host. See [Deploying Remote Collectors](remote-collectors).

## 5. Hub certificate issues

The remote collector validates the hub's TLS certificate. If the cert was replaced:

- Update the CA cert on the remote host at the path specified in `/etc/anthrimon-collector/config.yaml`
- Restart the collector

## 6. Collector heartbeat

The hub marks a collector offline if it has not sent a heartbeat in the last 90 seconds. The collector sends a heartbeat every 30 seconds. If the WireGuard tunnel is up but the collector is still offline in the UI:

```bash
journalctl -u anthrimon-remote-collector -n 20 --no-pager | grep -i "heartbeat\|health\|error"
```

Look for HTTP errors posting to the hub API — this indicates the WireGuard tunnel is up but the API is not responding or is returning auth errors.

## 7. Collector version mismatch

If the hub was updated and the collector binary is very old, the API may reject requests. Use the **Hot Patch** button on the Collectors page to push the latest binary.
