# Restarting Services

## Service names

| Service | Unit |
|---------|------|
| API backend | `anthrimon-api` |
| SNMP collector | `snmp-collector` |
| Flow collector (NetFlow/sFlow) | `flow-collector` |
| Syslog collector | `syslog-collector` |
| Nginx (web frontend) | `nginx` |

## Restart a single service

```bash
sudo systemctl restart <service-name>
```

## Restart all Anthrimon services

```bash
sudo systemctl restart anthrimon-api snmp-collector flow-collector syslog-collector
```

## Check service status

```bash
sudo systemctl status anthrimon-api
```

## View live logs

```bash
journalctl -u anthrimon-api -f
journalctl -u snmp-collector -f
```

## After config file changes

If you edited a `.yaml` collector config or a systemd unit file:

```bash
# After editing a systemd unit:
sudo systemctl daemon-reload
sudo systemctl restart <service-name>

# After editing a collector YAML (no daemon-reload needed):
sudo systemctl restart <service-name>
```

## Remote collectors

Remote collectors are managed via the **Collectors** page in the UI. Use the hot-patch button to push a new binary without needing SSH access to the remote host.
