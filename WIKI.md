# Anthrimon — Platform Wiki

Complete reference for installation, configuration, operation, and extension of the Anthrimon network monitoring platform.

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Installation](#installation)
4. [First Steps](#first-steps)
5. [Dashboards](#dashboards)
6. [SNMP Monitoring](#snmp-monitoring)
7. [Alerting](#alerting)
8. [Flow Monitoring](#flow-monitoring)
9. [Syslog](#syslog)
10. [SNMP Traps](#snmp-traps)
11. [BGP Monitoring](#bgp-monitoring)
12. [Config Management](#config-management)
13. [Topology](#topology)
14. [Remote Collectors](#remote-collectors)
15. [Administration](#administration)
16. [API Reference](#api-reference)
17. [Troubleshooting](#troubleshooting)
18. [Data Retention](#data-retention)

---

## Overview

Anthrimon is a self-hosted network monitoring and orchestration platform. It provides:

- **Custom dashboards** — drag-and-drop widget grid with shared/private dashboards and kiosk mode
- **Deep SNMP polling** — interfaces, health metrics, optical power, neighbors, routes, VLANs, STP, IS-IS
- **Flow analysis** — NetFlow v5/v9, IPFIX, sFlow v5 with top-talkers and per-interface breakdown
- **Syslog ingest** — RFC 3164/5424, severity analysis, pattern-match alerts
- **SNMP traps** — v1/v2c/v3 authPriv, vendor-aware classification, hub and remote-site collection
- **Config management** — SSH backup, diff viewer, compliance policies, golden config, multi-device deploy
- **Alerting** — 23 metric types, email/Slack/Teams/PagerDuty/webhook notifications, maintenance windows, syslog correlation
- **BGP monitoring** — session state, prefix counts, flap detection, prefix-drop baselines
- **Topology** — live L2/L3 map from LLDP/CDP with bandwidth sparklines
- **Path trace** — hop-by-hop network path visualization
- **Remote collectors** — WireGuard-tunnelled distributed polling agents with local trap collection
- **Multi-tenancy** — tenant isolation with platform admin cross-tenant switching
- **Audit log** — full change tracking for compliance

### Default credentials

| Field | Value |
|---|---|
| Username | `admin` |
| Password | `admin` |

**Change the password immediately** after first login: **Users** (Admin section in the sidebar).

---

## Architecture

```
Browser ──HTTPS:443──▶ nginx ──▶ /dist (React SPA)
                             └──▶ :8001 (FastAPI/uvicorn)
                                       │
                    ┌──────────────────┼──────────────────┐
                    ▼                  ▼                   ▼
              PostgreSQL        VictoriaMetrics        ClickHouse
           (config, alerts)    (SNMP time-series)  (flows, syslog, traps)

Network devices (hub site):
  SNMP ◀────── snmp-collector (Go)              polls every 60s
  Flow ───────▶ flow-collector (Go)             :2055 NetFlow, :6343 sFlow
  Syslog ─────▶ syslog-collector (Go)          :514 UDP/TCP
  Traps ──────▶ anthrimon-trap-receiver (Go)   :162 UDP

Remote sites (WireGuard 10.100.0.0/24):
  wg0:10.100.0.1 ◀── anthrimon-collector (Go)  SNMP + flow + syslog + trap forwarding
                 ◀── snmptrapd + anthrimon-traphandler  trap collection from local devices
```

### Component versions

| Component | Version |
|---|---|
| Python / FastAPI | 3.12 / 0.115 |
| React | 19 |
| PostgreSQL | 14 |
| VictoriaMetrics | 1.96 |
| ClickHouse | 26.x |
| Go collectors | 1.22 |
| nginx | system |

### Database schema

- **PostgreSQL** — 22 migrations (`storage/migrations/postgres/`): tenants, users, devices, interfaces, alerts, credentials, config backups, sites, remote collectors, and more
- **ClickHouse** — 3 migrations (`storage/migrations/clickhouse/`): flow_records + 4 aggregate views, syslog_messages + hourly aggregate, trap_events

---

## Installation

### Requirements

- Ubuntu 22.04 or 24.04 LTS
- 2+ CPU cores, 4 GB RAM (8 GB recommended)
- Outbound internet for the installer

### Install

```bash
git clone https://github.com/purpledurpl075/Anthri-mon.git
cd Anthri-mon
sudo bash infra/scripts/install.sh
```

The installer prompts for database credentials, public URL, and flow/syslog ports, then installs all services automatically.

### What the installer does

1. System packages (nginx, wireguard-tools, snmp, snmptrapd, Go, Node.js, Python)
2. PostgreSQL 14 — creates role, database, runs all migrations
3. ClickHouse — installs, runs all ClickHouse migrations
4. VictoriaMetrics — installs binary, creates systemd service
5. Builds SNMP, flow, and syslog collectors (Go)
6. Builds the remote collector binary for amd64 and arm64 (`anthrimon-remote-collector-linux-{arch}`)
7. Builds the trap handler binary for amd64 and arm64 (`anthrimon-trap-handler-linux-{arch}`)
8. Builds the hub trap receiver binary (`anthrimon-trap-receiver`)
9. Builds the React frontend production bundle
10. Generates self-signed TLS CA + server certificate
11. Configures nginx with HTTPS (port 443, port 80 redirects)
12. Sets up WireGuard hub interface (wg0 at 10.100.0.1/24)
13. Installs all systemd units
14. Seeds platform settings (base_url)

### Systemd services

```bash
systemctl status anthrimon-api            # FastAPI backend
systemctl status snmp-collector           # SNMP polling
systemctl status flow-collector           # NetFlow/sFlow
systemctl status syslog-collector         # Syslog
systemctl status anthrimon-trap-receiver  # SNMP trap receiver (:162 UDP)
systemctl status nginx                    # HTTPS reverse proxy
systemctl status victoria-metrics         # Time-series
systemctl status clickhouse-server        # Analytics
systemctl status postgresql               # Relational DB
systemctl status wg-quick@wg0             # WireGuard hub
```

### TLS

Self-signed CA lives at `/etc/anthrimon/tls/ca.crt`. Distribute to browsers/collectors to avoid certificate warnings.

```bash
# Add CA to your OS trust store (Linux)
sudo cp /etc/anthrimon/tls/ca.crt /usr/local/share/ca-certificates/anthrimon-ca.crt
sudo update-ca-certificates

# Renew server cert (CA is preserved)
sudo bash scripts/setup-tls.sh
```

---

## First Steps

### Add your first device

1. Navigate to **Devices → Add device**
2. Enter hostname, management IP, select vendor and device type
3. Assign an SNMP credential (create one first under **Credentials**)
4. The SNMP collector will begin polling on its next cycle (default 60s)

### Create an SNMP credential

1. Navigate to **Credentials → New**
2. Select type: **SNMP v2c** (community string) or **SNMP v3**
3. Assign the credential to your device in the Device Settings drawer (gear icon) → **Credentials** section

### Create your first alert rule

1. Navigate to **Alert Rules → New rule**
2. Select a metric (e.g. CPU utilisation %)
3. Set threshold, duration, severity
4. Assign a notification channel
5. The engine evaluates every 15 seconds

---

## Dashboards

Dashboards is the home page. Create custom widget-based dashboards with drag-and-drop layout.

### Widget types

Stat cards, metric gauges, metric graphs, time-series charts, alert severity bars, alert timelines, open alerts, problem devices, top bandwidth, top CPU, top memory, syslog feed, syslog heatmap, syslog rate, BGP summary, BGP flap log, BGP prefix totals, OSPF areas, routing health, interface health, collector status, config changes, device type grid, text notes, and more.

### Features

- **Shared / private** — dashboards can be shared with all users or kept private
- **Default dashboard** — one dashboard can be marked as the default home page (star icon)
- **Quick access** — the sidebar shows a collapsible list of dashboards for fast navigation
- **Kiosk mode** — full-screen auto-rotating display for NOC screens (`/dashboards/kiosk`)

---

## SNMP Monitoring

### What is collected

| Category | OIDs / MIBs |
|---|---|
| Interface counters | ifTable, ifXTable |
| Interface status | ifOperStatus, ifAdminStatus |
| Interface IPs | ipAddrTable |
| Device health | sysUpTime, hrProcessorLoad, hrStorage |
| Temperature | entSensorValue (ENTITY-SENSOR-MIB type 8) |
| DOM optical power | ENTITY-SENSOR-MIB type 6 (watts→dBm) |
| LLDP neighbors | IEEE + IETF OID spaces |
| CDP neighbors | CISCO-CDP-MIB |
| OSPF neighbors | ospfNbrTable |
| IS-IS neighbors | ISIS-MIB isisSysTable |
| ARP table | ipNetToMediaTable |
| MAC forwarding | dot1dTpFdbTable |
| Routing table | ipCidrRouteTable |
| VLANs | dot1qVlanStaticTable + port bitmaps |
| STP | dot1dStpPortTable |
| BGP | bgpPeerTable (RFC 1657); Aruba CX via REST API |

### Polling intervals

Default: 60 seconds per device. Adjustable per device in the Device Settings drawer → SNMP section. The health metrics multiplier (default 1x) controls how often health metrics are collected vs interface counters.

### Vendor support

| Vendor | Notes |
|---|---|
| Arista EOS | Full support, DOM power |
| Cisco IOS/IOS-XE/IOS-XR/NX-OS | Full support |
| Juniper | Full support |
| Aruba CX | Full support |
| HP ProCurve | ICF MIBs, partial DOM |
| FortiGate | Health + interfaces |
| Ubiquiti UniFi/UBNT | Basic health + interfaces |
| Aruba AP | ArubaOS WLSX-SYSTEMEXT-MIB |

### Metrics in VictoriaMetrics

All SNMP metrics are stored with these label dimensions:
- `device_id` — UUID of the device
- `if_index` — interface index (interface metrics only)
- `if_name` — interface name
- `vendor` — vendor string

Example metric names: `anthrimon_if_in_octets_total`, `anthrimon_cpu_util_pct`, `anthrimon_mem_util_pct`

---

## Alerting

### Alert engine

Runs every 15 seconds. Evaluates all enabled alert rules against all active devices. Supports:

- **Duration gating** — condition must hold for N seconds before firing
- **Flap suppression** — rate-limit repeated transitions
- **Severity escalation** — promote from warning → critical after sustained breach
- **Correlated suppression** — suppress child device alerts when parent is down
- **Manual-resolve suppression** — don't re-fire until condition clears after manual resolve
- **Storm protection** — max N alerts per device per hour
- **Maintenance windows** — suppress alerts on schedule (one-time or recurring cron)

### Supported metrics

| Metric | Description |
|---|---|
| `cpu_util_pct` | CPU utilisation % |
| `mem_util_pct` | Memory utilisation % |
| `device_down` | Device unreachable via SNMP |
| `device_latency` | Device latency (ping RTT) above threshold |
| `interface_down` | Interface operationally down (admin up) |
| `interface_flap` | Interface state changes within window |
| `interface_errors` | Interface error count (5-min window) |
| `interface_discards` | Interface discard count (5-min window) |
| `interface_util_pct` | Interface bandwidth utilisation % |
| `uptime` | Device rebooted (uptime below threshold) |
| `temperature` | Temperature sensor above threshold |
| `ospf_state` | OSPF neighbor not in Full state |
| `isis_state` | IS-IS adjacency not in Up state |
| `bgp_session_down` | BGP session dropped |
| `bgp_session_flapping` | BGP session flapping within window |
| `bgp_prefix_drop` | BGP prefix count dropped by threshold % |
| `route_missing` | Specific route prefix absent from routing table |
| `flow_bandwidth` | Flow bandwidth bytes/s above threshold |
| `syslog_match` | Syslog message matches RE2 regex |
| `config_change` | Device running config hash changed |
| `snmp_trap` | SNMP trap received from device |
| `collector_offline` | Remote collector heartbeat timeout (system) |
| `custom_oid` | Arbitrary OID value threshold |

### Alert states

`open` → `acknowledged` → `resolved` / `expired` / `suppressed`

### Email notifications

Configure SMTP under **Administration** → **SMTP Server** tab. Create channels under **Administration** → **Channels** tab. Assign channels to alert rules.

Email templates are fully customizable per alert type — **Administration** → **Email Template** tab.

### Maintenance windows

Create under **Maintenance**. Supports:
- One-time windows (start/end datetime)
- Recurring windows (cron expression, e.g. `0 2 * * 0` for every Sunday at 2am)
- Device scope: all devices, specific device, by vendor, by tag

---

## Flow Monitoring

### Supported protocols

| Protocol | Port | Notes |
|---|---|---|
| NetFlow v5 | :2055 UDP | Full parse |
| NetFlow v9 | :2055 UDP | Full parse, template cache |
| IPFIX | :2055 UDP | Full parse, template cache |
| sFlow v5 | :6343 UDP | Flow + extended records |

### ClickHouse tables

| Table | TTL | Contents |
|---|---|---|
| `flow_records` | 90 days | Raw flow records |
| `flow_agg_1min` | 1 year | Per-minute src/dst IP pair totals |
| `flow_agg_proto_5min` | 2 years | Per-5min protocol breakdown |
| `flow_agg_asn_5min` | 2 years | Per-5min ASN totals |
| `flow_agg_iface_1hr` | 3 years | Per-hour interface utilisation |

### Configuring Arista to send sFlow

```
sflow sample 1024
sflow polling-interval 30
sflow destination <anthrimon-ip> 6343
sflow source-interface <mgmt-interface>
sflow enable
```

### Flow alerts

Create a rule with metric **Flow bandwidth**. Optional filters: src IP, dst IP, protocol. Threshold is in bytes/s (e.g. 10 Mbps = 1,250,000 B/s). Evaluated against 5-minute average.

---

## Syslog

### Supported formats

- RFC 3164 (BSD syslog) — used by most network devices
- RFC 5424 (modern syslog)
- Both UDP and TCP, port 514
- TCP supports both newline-framed and octet-count framing (RFC 6587)

### ClickHouse tables

| Table | TTL | Contents |
|---|---|---|
| `syslog_messages` | 90 days | Raw parsed messages |
| `syslog_agg_1hr` | 1 year | Hourly severity counts per device |

### Configuring Arista to send syslog

```
logging host <anthrimon-ip>
logging trap informational
```

### Syslog-match alerts

Create a rule with metric **Syslog pattern match**. The pattern is a RE2 regular expression matched against the message field. Quick-pick patterns available in the UI:

| Pattern | Matches |
|---|---|
| `Interface.*down\|link.*down` | Interface down events |
| `OSPF.*[Nn]eighbor\|OSPF.*[Ss]tate` | OSPF state changes |
| `authentication.*fail\|Invalid user\|Failed password` | Auth failures |
| `SYS-5-CONFIG_I\|PARSER-5-CFG_SAVD` | Config changes |
| `BGP.*[Dd]own\|BGP-5` | BGP events |

### Alert correlation

Every new alert automatically captures the last 5 syslog messages from the affected device (10-minute window). Displayed in the alert detail page as **Related syslog events**.

---

## SNMP Traps

### Hub trap receiver

The hub runs `anthrimon-trap-receiver` which listens on **UDP 162** for traps from all hub-site devices. Traps are classified by OID, mapped to a severity, and stored in ClickHouse `trap_events`.

### Remote site trap collection

Remote collectors run `snmptrapd` alongside the main collector process. The trap handler binary (`anthrimon-traphandler`) is automatically downloaded from the hub on collector startup. Traps received by snmptrapd are forwarded to the hub API over the WireGuard tunnel.

### SNMPv3 trap authentication

When an SNMPv3 credential is linked to a device, the hub automatically pushes the v3 user keys to the remote collector responsible for that device's site. The collector reconfigures `snmptrapd` so that `authPriv` traps from the device are accepted — no manual snmptrapd configuration needed.

### Trap classification

| OID prefix | Type | Severity |
|---|---|---|
| 1.3.6.1.6.3.1.1.5.3 | linkDown | critical |
| 1.3.6.1.6.3.1.1.5.4 | linkUp | info |
| 1.3.6.1.6.3.1.1.5.1 | coldStart | warning |
| 1.3.6.1.6.3.1.1.5.2 | warmStart | info |
| 1.3.6.1.6.3.1.1.5.5 | authenticationFailure | warning |
| 1.3.6.1.4.1.9.9.187.* | cisco.bgpBackwardTransition | critical |
| 1.3.6.1.4.1.9.* | cisco.trap | info |
| 1.3.6.1.4.1.30065.3.9 | arista.bgpPeerStateChange | warning |
| 1.3.6.1.4.1.30065.3.10 | arista.linkStateChange | warning |
| 1.3.6.1.4.1.30065.* | arista.trap | info |
| 1.3.6.1.4.1.47196.4.1.1.3.20 | aruba_cx.linkStateChange | warning |
| 1.3.6.1.4.1.47196.* | aruba_cx.trap | info |
| 1.3.6.1.4.1.11.2.14.12.1 | hp.linkChange | warning |
| 1.3.6.1.4.1.11.2.* | hp.trap | info |
| 1.3.6.1.4.1.2636.* | juniper.trap | info |

Longest-prefix match wins. SNMPv1 traps are normalised to v2c format by snmptrapd.

---

## BGP Monitoring

### What is collected

BGP session state, peer IP, remote AS, received prefix counts, and UPDATE message counts are collected via SNMP (BGP4-MIB, RFC 4273). Session history and prefix counts are stored in VictoriaMetrics as time-series data.

### Alert rules

| Metric | Description |
|---|---|
| `bgp_session_down` | BGP session leaves Established state |
| `bgp_session_flapping` | Session up/down more than N times within a window |
| `bgp_prefix_drop` | Received prefix count drops by more than threshold % from 24h average |

### Viewing BGP data

- **Routing page** (Analysis section in sidebar) — all peers across all devices, session state timeline, prefix count charts
- **Device detail → BGP tab** — per-device peer list, session events, prefix history

### Full-table analysis

For devices receiving a full BGP routing table, the prefix count baseline adapts to gradual growth using a rolling Welford mean/stddev. Sudden large drops trigger `bgp_prefix_drop` once at least 50 historical samples exist (~25 minutes).

---

## Config Management

### How it works

1. The hub SSHes into each device hourly (configurable)
2. Runs the appropriate `show running-config` command (vendor-specific)
3. Computes SHA-256 hash — skips if unchanged
4. Stores full config text in PostgreSQL with unified diff
5. Fires a `config_change` alert if a change is detected

### Supported vendors (SSH)

| Vendor | Method | Command |
|---|---|---|
| Arista EOS | Netmiko (arista_eos) | `show running-config` |
| Cisco IOS/XE | Netmiko (cisco_ios) | `show running-config` |
| Cisco IOS-XR | Netmiko (cisco_xr) | `show running-config all` |
| Cisco NX-OS | Netmiko (cisco_nxos) | `show running-config` |
| Juniper | Netmiko (juniper_junos) | `show configuration \| display set` |
| HP ProCurve | paramiko (invoke_shell) | `show running-config` |
| Aruba CX | Netmiko (aruba_aoscx) | `show running-config` |
| FortiGate | Netmiko (fortinet) | `show full-configuration` |

ProCurve uses direct paramiko `invoke_shell` because Netmiko's hp_procurve driver sends `terminal width 511` which ProCurve 2920 rejects.

### SSH credentials

Assign an SSH credential to the device in the Device Settings drawer (gear icon) → **Credentials** section. The credential type must be `ssh` with `username` and `password` fields. Optional: `enable_secret` for Cisco enable mode.

### Compliance policies

Create policies under **Policies** (Analysis section in the sidebar). Each policy has N rules:

| Rule type | Description |
|---|---|
| `regex_present` | Config must match pattern |
| `regex_absent` | Config must NOT match pattern |
| `contains` | Config must contain literal string |
| `not_contains` | Config must not contain literal string |

Run policies manually or wait for the next collection cycle.

### Config deploy

The **Deploy** tab on each device allows pushing config snippets via SSH. Commands wrap in vendor-appropriate `configure terminal` / `end` automatically. Template variables supported: `{{hostname}}`, `{{mgmt_ip}}`, `{{ntp_server}}`, etc.

For multi-device deploy: **Config → Deploy** tab — target by vendor, tag, or specific device selection.

---

## Topology

### How it works

LLDP and CDP neighbor data is collected each poll cycle. The topology endpoint computes the graph from the `lldp_neighbors` and `cdp_neighbors` tables and persists edges to `topology_links`.

### Layout

The topology uses a hierarchical BFS layout. Drag nodes to reposition — positions are saved per-session. Click an edge to open the link panel showing port names, speed, and 30-minute bandwidth sparkline.

---

## Remote Collectors

### Architecture

```
Remote site                    Hub
────────────                   ────────────────────────
[collector]                    [wg0: 10.100.0.1/24]
wg0: 10.100.0.X ──UDP 51820──▶ hub WireGuard endpoint
                 ──HTTPS──────▶ 10.100.0.1:443
```

### Bootstrap flow

1. Admin creates collector in UI → registration token generated (24h, single-use)
2. On remote server: set `ANTHRIMON_HUB` and `ANTHRIMON_TOKEN` env vars
3. Collector generates WireGuard keypair on first run
4. Calls `POST /api/v1/collectors/bootstrap` over HTTPS (validates CA cert)
5. Hub adds WireGuard peer, assigns IP from 10.100.0.0/24 pool
6. Hub returns: API key, WireGuard peer config, CA cert
7. Collector configures wg0, brings up tunnel
8. All subsequent traffic through the tunnel

### Deploying a collector

1. In the Anthrimon UI go to **Collectors** (Admin section in the sidebar) → **Add Collector**
2. Complete the setup wizard — name the collector and select the site
3. Download the deployment package (`anthrimon-remote-collector-linux-amd64.zip`)
4. On the remote server:

```bash
unzip anthrimon-remote-collector-linux-amd64.zip
sudo bash install.sh
```

The install script handles everything: installs `wireguard-tools` and `snmptrapd`, copies the binary, config, and hub CA cert, configures capability overrides for port 162 binding, and starts `anthrimon-collector.service`.

The collector self-registers over HTTPS, establishes the WireGuard tunnel, downloads the trap handler binary, and appears **online** in the UI within seconds.

### Device assignment

Assign devices to a remote collector in the Device Settings drawer (gear icon) → **Collector** section. The dropdown shows all active collectors with their WireGuard IP and online/offline status. Select "Hub (local)" to revert to direct polling.

### Collector health

The hub monitors each collector's heartbeat (sent every 30s). If no heartbeat is received for 90 seconds, the collector is marked offline and a **major** alert fires. It auto-resolves when the collector reconnects.

### Mini HTTP server

Each collector exposes a tiny HTTP server on its WireGuard IP (port 9090):

```
GET  http://10.100.0.X:9090/health   → status JSON
POST http://10.100.0.X:9090/refresh  → force device config reload
```

---

## Administration

### Users and roles

| Role | Capabilities |
|---|---|
| `readonly` | View everything, no changes |
| `operator` | Acknowledge alerts, trigger collections, run compliance |
| `admin` | Full access except user management |
| `superadmin` | Full access including user management |

### Platform settings

Under **Administration** (Admin section in the sidebar) → **Alerting** tab:

- Timezone (affects business hours gating for alerts)
- Session timeout
- Alert evaluation interval (default 15s)
- Global notification pause
- Business hours — only send notifications during work hours
- Storm protection — max alerts per device per hour
- Alert retention — auto-close resolved alerts after N days

### Data retention

Configured under **Platform Admin** (platform admins only) or **Administration** → data settings:

| Data | Default | Location |
|---|---|---|
| Alerts | 90 days (auto-close) | PostgreSQL |
| Flow records | 90 days | ClickHouse TTL |
| Flow aggregates | 1–3 years | ClickHouse TTL |
| Syslog messages | 90 days | ClickHouse TTL |
| Config backups | Unlimited | PostgreSQL |

Changing ClickHouse TTLs takes effect on next background merge.

---

## API Reference

All endpoints are under `/api/v1/`. Authentication: `Authorization: Bearer <jwt>` (obtain via `POST /api/v1/auth/login`).

### Key endpoint groups

| Prefix | Description |
|---|---|
| `/auth` | Login, me, refresh |
| `/devices` | CRUD, health, interfaces, neighbors, routes, VLANs, STP |
| `/interfaces` | Interface detail, live SSE stream |
| `/alerts` | CRUD, acknowledge, resolve, comments |
| `/alert-rules` | CRUD alert rules |
| `/maintenance-windows` | Maintenance window CRUD |
| `/credentials` | Credential CRUD + device assignment |
| `/channels` | Notification channel CRUD + test |
| `/overview` | Dashboard summary, top bandwidth |
| `/flow` | Flow summary, top talkers, ports, protocol breakdown, search |
| `/syslog` | Syslog summary, messages, rate, programs |
| `/config` | Backups, diffs, compliance policies, deploy |
| `/collectors` | Remote collector registration, bootstrap, data ingest |
| `/admin` | Platform settings, SMTP, email templates, data management |
| `/topology` | Topology graph |

### Interactive docs

Available at `https://<your-server>/api/docs` (Swagger UI) and `/api/redoc`.

---

## Troubleshooting

### Device shows as unreachable

1. Verify SNMP is enabled on the device and the community string / v3 credentials are correct
2. Check the SNMP credential is assigned to the device
3. Run **Device → Settings → SNMP Diagnostic** for detailed output
4. Confirm UDP port 161 is reachable from the server: `snmpwalk -v2c -c <community> <device-ip>`

### No flow data

1. Verify the device is exporting to the correct IP and port (2055 for NetFlow, 6343 for sFlow)
2. Check `systemctl status flow-collector` — confirm both listeners are bound
3. Run `sudo tcpdump -n -i any udp port 2055 -c 5` to confirm packets are arriving
4. For sFlow on Arista: `show sflow` — verify "Send Datagrams: Yes" and source IP is set

### No syslog messages

1. Verify `systemctl status syslog-collector` — both UDP and TCP listeners should be ready
2. Check that `rsyslog` is not consuming port 514: `systemctl status rsyslog`; if active, disable it
3. Run `sudo tcpdump -n -i any udp port 514 -c 5` to verify packets arrive
4. Confirm the device has a valid source IP configured (Arista: `sflow source-interface <iface>`)

### Config collection fails

1. Check the device has an SSH credential assigned (type `ssh`)
2. Test SSH manually: `ssh <username>@<device-ip>`
3. For ProCurve: ensure the user has manager privileges
4. For Arista: user needs privilege 15 or enable secret configured in the credential

### Alert engine errors

Check `journalctl -u anthrimon-api -n 50 | grep rule_eval_error` for per-rule evaluation failures. Common causes:
- Missing `import math` (fixed in current version)
- ClickHouse unavailable for `flow_bandwidth` metric
- Invalid regex in `syslog_match` rule

### Remote collector won't bootstrap

1. Verify the registration token hasn't expired (24h TTL) — regenerate if needed
2. Confirm `ANTHRIMON_HUB` URL is reachable and the CA cert is trusted
3. Check that `wg` and `ip` commands are available on the collector host
4. Verify UDP 51820 is open inbound on the hub server
5. Check `journalctl -u anthrimon-collector` for error details

### ClickHouse queries return 0 rows

**Known issue in ClickHouse 26.x:** `toString(device_id) AS device_id` aliases the UUID column in the WHERE clause, causing 0-row results. All Anthrimon ClickHouse queries use `device_uuid` as the alias to work around this.

If writing custom queries: never alias a column with the same name as the original column.

---

## Data Retention

### Changing retention

**Alerts** — via Administration → Data → Alerts retention (days). Changes platform settings; housekeeping runs every 5 minutes.

**Flow / Syslog** — via Administration → Data → Flow / Syslog retention. Calls `ALTER TABLE ... MODIFY TTL`. Changes take effect on next ClickHouse background merge (may take minutes to hours depending on data volume).

**Config backups** — no automatic retention. Delete old backups manually via the Config tab on each device.

### Disk estimation

| Data | Per device/day | 10 devices, 90 days |
|---|---|---|
| SNMP metrics (VictoriaMetrics) | ~5 MB | ~4.5 GB |
| Syslog (ClickHouse) | ~10 MB | ~9 GB |
| Flow records | varies | ~4 GB per 1k flows/s/day |
| Config backups (PostgreSQL) | ~100 KB/backup | negligible |

VictoriaMetrics compresses aggressively — real usage is typically 30–50% lower.

---

*This wiki covers Anthrimon as of Phase 11 (custom dashboards) complete.*
