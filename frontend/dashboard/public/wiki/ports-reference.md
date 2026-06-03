# Ports and Protocols Reference

## Inbound to the hub (must be open)

| Port | Protocol | Service | Source |
|------|----------|---------|--------|
| 443 | TCP | HTTPS — web UI and API | Browsers, remote collectors, API clients |
| 162 | UDP | SNMP traps (anthrimon-trap-receiver) | Network devices |
| 514 | UDP | Syslog (RFC 3164 + 5424) | Network devices |
| 514 | TCP | Syslog (reliable delivery) | Network devices |
| 2055 | UDP | NetFlow v5 / v9 / IPFIX | Network devices |
| 6343 | UDP | sFlow v5 | Network devices |
| 51820 | UDP | WireGuard VPN | Remote collector hosts |

## Outbound from the hub

| Port | Protocol | Destination | Purpose |
|------|----------|-------------|---------|
| 161 | UDP | Network devices | SNMP polling |
| 22 | TCP | Network devices | SSH config collection |
| 443 | TCP | Network devices (Arista, Aruba CX) | eAPI / REST config collection |
| 587 / 465 | TCP | SMTP server | Email alert notifications |
| 443 | TCP | External (Slack, PagerDuty, Teams, Webhook) | Alert notifications |

## Internal (loopback only)

| Port | Protocol | Service |
|------|----------|---------|
| 8001 | TCP | Anthrimon API (uvicorn) |
| 8428 | TCP | VictoriaMetrics HTTP API |
| 5432 | TCP | PostgreSQL |
| 9000 | TCP | ClickHouse (native protocol) |
| 9440 | TCP | ClickHouse (HTTPS) |

## Remote collector

The remote collector connects **outbound** to the hub only. For SNMP trap collection, it also receives inbound UDP 162 from devices at the local site.

| Connection | Port | Protocol | Direction |
|-----------|------|----------|-----------|
| WireGuard to hub | 51820 | UDP | Outbound from remote host |
| API calls to hub (via WireGuard) | 443 | TCP | Outbound over wg0 |
| SNMP polling to devices | 161 | UDP | Outbound to devices at the remote site |
| SSH to devices | 22 | TCP | Outbound to devices at the remote site |
| SNMP trap reception (snmptrapd) | 162 | UDP | Inbound from devices at the remote site |

The collector's local HTTP server (used for hot-patch and health checks) listens on `wg0` only — not the public interface.
