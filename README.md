<div align="center">
  <img src="https://raw.githubusercontent.com/purpledurpl075/Anthri-mon/main/logos/05-banner-hero.svg"
       alt="Anthrimon — Network Monitoring Platform" width="100%">
</div>

<br>

<div align="center">

[![Ubuntu](https://img.shields.io/badge/Ubuntu-22.04%20|%2024.04%20|%2026.04-E95420?style=flat-square&logo=ubuntu&logoColor=white)](https://ubuntu.com)
[![Python](https://img.shields.io/badge/Python-3.12+-3776AB?style=flat-square&logo=python&logoColor=white)](https://python.org)
[![Go](https://img.shields.io/badge/Go-1.26-00ADD8?style=flat-square&logo=go&logoColor=white)](https://go.dev)
[![React](https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=black)](https://react.dev)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-14-4169E1?style=flat-square&logo=postgresql&logoColor=white)](https://postgresql.org)
[![ClickHouse](https://img.shields.io/badge/ClickHouse-26.x-FFCC01?style=flat-square&logo=clickhouse&logoColor=black)](https://clickhouse.com)
[![WireGuard](https://img.shields.io/badge/WireGuard-VPN-88171A?style=flat-square&logo=wireguard&logoColor=white)](https://wireguard.com)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-5cb85c?style=flat-square)](LICENSE)

</div>

<br>

<p align="center">
  Self-hosted network monitoring — deep SNMP polling, NetFlow/sFlow analytics, syslog ingest,<br>
  SNMP traps, config management with rollback, alerting with anomaly detection, topology mapping,<br>
  BGP/OSPF/IS-IS routing analysis, and distributed remote collectors over WireGuard.
</p>

<p align="center">
  <a href="https://demo.anthrimon.com"><strong>Live Demo</strong></a> — explore a fully populated instance with 28 devices, real topology, flow analytics, and alerting
</p>

---

## Features

| | Capability | Details |
|:---:|:---|:---|
| 📡 | **SNMP monitoring** | Interface counters (HC 64-bit) · CPU/memory/temperature/uptime · DOM optical power · TCAM/FIB utilisation · ARP/MAC tables · LLDP/CDP neighbors · OSPF/IS-IS/BGP · STP · VLANs · routing table · vendor-specific (Arista TCAM, Cisco CoPP, Aruba CX VSX/loop-protect) |
| 🌊 | **Flow analytics** | NetFlow v5/v9, IPFIX, sFlow v5 — 15 analysis dimensions: top talkers, ASN, geo, threats (AbuseIPDB), applications, elephant flows, TCP flags, subnet breakdown |
| 📋 | **Syslog** | RFC 3164 + RFC 5424 · UDP/TCP :514 · severity/facility breakdown · pattern-match alerts · alert correlation · rate heatmaps |
| 🪤 | **SNMP traps** | v1/v2c/v3 authPriv · vendor-aware classification · hub and remote-site collection · automatic v3 key push |
| ⚙️ | **Config management** | SSH backup with git archive · unified diff viewer · compliance policies · golden config scoring · multi-device deploy with template variables · vendor-native rollback (7 platforms) · change approval workflow |
| 🔔 | **Alerting** | 15-second evaluation · 23 metric types · adaptive baselines (14-day rolling) · topology-aware cascade suppression · escalation · email/Slack/PagerDuty/Teams/webhook · maintenance windows · bulk ack/resolve |
| 🗺️ | **Topology** | Live L2/L3 map from LLDP/CDP · tier-band auto layout · link utilisation overlay · WAN cloud nodes · PNG export · OSPF area and IS-IS topology views |
| 📊 | **Routing analysis** | BGP sessions with prefix history and flap detection · OSPF neighbor and area topology · IS-IS adjacencies, circuit-levels, LSP database · IPv4 + IPv6 route table |
| 🛰️ | **Remote collectors** | WireGuard-tunnelled distributed polling — SNMP, flow, syslog, config backup/deploy/rollback, and trap collection at remote sites · self-update with SHA-256 verification |
| 🖥️ | **Dashboards** | 24 widget types · drag-and-drop grid · templates · kiosk mode · clone and share |
| 🔐 | **Security** | TOTP 2FA with backup codes · 3-tier RBAC (platform/tenant/site) · AES-256-GCM credential encryption · session revocation · API tokens with scopes · HMAC-signed webhooks |
| 📦 | **Multi-tenancy** | Native tenant isolation · cross-tenant platform admin · site-scoped roles · per-tenant alerting overrides |
| 📄 | **Export** | CSV export for devices and alerts · topology PNG · audit log CSV |


**Vendor support** — Arista EOS · Cisco IOS/IOS-XE/IOS-XR/NX-OS · Juniper · Aruba CX · HP ProCurve · FortiGate · Ubiquiti · Aruba AP

---

## Screenshots

<table>
  <tr>
    <td align="center" width="50%">
      <a href="https://github.com/user-attachments/assets/5e5bb9e7-3ce4-4724-bd35-4cb1be5e49c4" target="_blank">
        <img src="https://github.com/user-attachments/assets/5e5bb9e7-3ce4-4724-bd35-4cb1be5e49c4" alt="Overview dashboard" width="100%">
      </a>
      <br><sub><b>Overview dashboard</b></sub>
    </td>
    <td align="center" width="50%">
      <a href="https://github.com/user-attachments/assets/7e5b331e-880f-4a92-b959-3ed839b3f9a4" target="_blank">
        <img src="https://github.com/user-attachments/assets/7e5b331e-880f-4a92-b959-3ed839b3f9a4" alt="Topology" width="100%">
      </a>
      <br><sub><b>Topology</b></sub>
    </td>
  </tr>
  <tr>
    <td align="center">
      <a href="https://github.com/user-attachments/assets/40c44dd3-77b1-420a-975f-86b50a88b423" target="_blank">
        <img src="https://github.com/user-attachments/assets/40c44dd3-77b1-420a-975f-86b50a88b423" alt="Syslog" width="100%">
      </a>
      <br><sub><b>Syslog</b></sub>
    </td>
    <td align="center">
      <a href="https://github.com/user-attachments/assets/32711003-dc57-4f34-bfac-c9c929ae4803" target="_blank">
        <img src="https://github.com/user-attachments/assets/32711003-dc57-4f34-bfac-c9c929ae4803" alt="Flow monitoring" width="100%">
      </a>
      <br><sub><b>Flow analytics</b></sub>
    </td>
  </tr>
  <tr>
    <td align="center">
      <a href="https://github.com/user-attachments/assets/872a551c-7090-4cda-bc7e-7a048e23293b" target="_blank">
        <img src="https://github.com/user-attachments/assets/872a551c-7090-4cda-bc7e-7a048e23293b" alt="MAC and ARP Search" width="100%">
      </a>
      <br><sub><b>MAC &amp; ARP Search</b></sub>
    </td>
    <td align="center">
      <a href="https://github.com/user-attachments/assets/8915293a-bb42-488b-9d0f-9ece5424958f" target="_blank">
        <img src="https://github.com/user-attachments/assets/8915293a-bb42-488b-9d0f-9ece5424958f" alt="Device Health Metrics" width="100%">
      </a>
      <br><sub><b>Device Health Metrics</b></sub>
    </td>
  </tr>
  <tr>
    <td align="center" colspan="2">
      <a href="https://github.com/user-attachments/assets/68de9a97-1a2e-4cb3-b8ed-0fe2820e958e" target="_blank">
        <img src="https://github.com/user-attachments/assets/68de9a97-1a2e-4cb3-b8ed-0fe2820e958e" alt="Configuration Management and Compliance" width="100%">
      </a>
      <br><sub><b>Configuration Management &amp; Compliance</b></sub>
    </td>
  </tr>
</table>

---

## Requirements

- Ubuntu 22.04, 24.04, or 26.04 LTS (bare metal or VM)
- 2+ CPU cores · 4 GB RAM minimum (8 GB recommended)
- Outbound internet access for the installer (Go, Node.js, Python packages)

---

## Installation

```bash
git clone https://github.com/purpledurpl075/Anthri-mon.git
cd Anthri-mon
sudo bash infra/scripts/install.sh
```

The installer prompts for:

| Setting | Default | Notes |
|---|---|---|
| PostgreSQL role | `anthrimon` | |
| PostgreSQL database | `anthrimon` | |
| Database password | *(random)* | Leave blank to auto-generate |
| Public base URL | `https://<IP>` | Used in alert emails and collector configs |
| NetFlow/IPFIX port | `2055` | UDP |
| sFlow port | `6343` | UDP |

It installs all dependencies (including Python 3.12 on systems where the default is 3.14+), creates the database, runs all migrations, builds all Go collectors and the React frontend, generates TLS certificates, configures nginx with HTTPS + WebSocket support, sets up the WireGuard hub interface, and registers all systemd services.

### First login

Navigate to `https://<your-server-ip>/` and sign in with the default superadmin account:

| Field | Value |
|---|---|
| Username | `admin` |
| Password | `admin` |

> **Change this password immediately** after first login — **Administration → Users**.

---

## Updating

```bash
git pull
sudo bash infra/scripts/update.sh
```

The update script:
1. Stops all services (API, collectors, snmptrapd)
2. Updates Python dependencies
3. Applies any new database migrations (PostgreSQL + ClickHouse)
4. Rebuilds all Go collectors (hub + remote amd64/arm64)
5. Rebuilds the frontend (`npm install` + `npm run build`)
6. Restarts all services — only if all builds succeeded

---

## Architecture

```
                    HTTPS :443
Browser ──────────────────────────▶ nginx ──▶ dist/ (React SPA)
                                          └──▶ :8001 (FastAPI)
                                                    │
                              ┌─────────────────────┼─────────────────────┐
                              ▼                     ▼                     ▼
                        PostgreSQL          VictoriaMetrics           ClickHouse
                      (config, alerts,       (SNMP metrics)     (flows, syslog, traps)
                       routing, topology)

Network devices (hub site)
  SNMP polling  ◀────── snmp-collector (Go)
  NetFlow/sFlow ───────▶ flow-collector (Go)             :2055 / :6343
  Syslog        ───────▶ syslog-collector (Go)           :514 UDP/TCP
  SNMP traps    ───────▶ snmptrapd + anthrimon-traphandler  :162 UDP

Remote sites (WireGuard tunnel 10.100.0.0/24)
  wg0: 10.100.0.1 ◀──── anthrimon-collector (Go)          SNMP + flow + syslog + config + eAPI/REST
                   ◀──── snmptrapd + anthrimon-traphandler traps from local devices
```

---

## Stack

| Component | Technology |
|---|---|
| API | Python 3.12 · FastAPI · SQLAlchemy 2.0 · uvicorn |
| Frontend | React 19 · Vite 8 · Tailwind CSS v4 · TanStack Query |
| Time-series | VictoriaMetrics (12-month retention) |
| Flow/Syslog/Trap storage | ClickHouse (graded TTL: 90d raw → 3yr aggregated) |
| Relational DB | PostgreSQL 14 |
| SNMP collector | Go · gosnmp · LLDP/CDP/OSPF/IS-IS/BGP/STP/VLANs/routes |
| Flow collector | Go — NetFlow v5/v9, IPFIX, sFlow v5 |
| Syslog collector | Go — RFC 3164 + RFC 5424, UDP + TCP |
| Hub trap receiver | net-snmp `snmptrapd` (:162) → `anthrimon-traphandler` (Go) |
| Remote collector | Go — SNMP + flow + syslog + config backup/deploy/rollback + eAPI + REST + ICMP probe |
| Reverse proxy | nginx — TLS 1.2/1.3 with self-signed EC P-384 CA |
| VPN | WireGuard — remote collector tunnels (10.100.0.0/24) |
| Auth | JWT (HS256, 24h) · TOTP 2FA · bcrypt-12 · AES-256-GCM credentials |

---

## Services

```bash
systemctl status anthrimon-api            # FastAPI backend (127.0.0.1:8001)
systemctl status snmp-collector           # SNMP polling daemon
systemctl status flow-collector           # NetFlow/sFlow listener (:2055, :6343)
systemctl status syslog-collector         # Syslog listener (:514 UDP/TCP)
systemctl status snmptrapd                # SNMP trap receiver (:162 UDP) → anthrimon-traphandler
systemctl status nginx                    # HTTPS frontend + API proxy (:443)
systemctl status victoria-metrics         # Time-series store (:8428)
systemctl status clickhouse-server        # Flow/syslog/trap analytics store
systemctl status postgresql               # Relational database
systemctl status wg-quick@wg0             # WireGuard hub interface
```

---

## Ports

| Port | Protocol | Required | Purpose |
|:---:|:---:|:---:|---|
| 443 | TCP | Yes | HTTPS — dashboard and API |
| 162 | UDP | Configurable | SNMP traps from network devices |
| 51820 | UDP | Remote collectors only | WireGuard VPN tunnel |
| 2055 | UDP | Configurable | NetFlow v5/v9 / IPFIX from network devices |
| 6343 | UDP | Configurable | sFlow from network devices |
| 514 | UDP + TCP | Configurable | Syslog from network devices |

The API (:8001), VictoriaMetrics (:8428), ClickHouse (:8123/:9000), and PostgreSQL (:5432) bind to localhost only and are not exposed externally.

---

## Remote Collectors

For devices at remote sites that can't reach the hub directly, deploy a lightweight collector binary that tunnels home over WireGuard. The remote collector also runs `snmptrapd` for local trap collection — the trap handler binary and SNMPv3 keys are pushed automatically from the hub.

**Register a collector** — in the Anthrimon UI:

1. Go to **Admin → Collectors → New collector**
2. Complete the setup wizard and download the deployment package
3. On the remote server:

```bash
unzip anthrimon-remote-collector-linux-amd64.zip
sudo bash install.sh
```

The install script installs `wireguard-tools` and `snmptrapd`, copies the binary, config, and hub CA cert, configures capability overrides for port 162 binding, and starts `anthrimon-collector.service`. The collector self-registers over HTTPS, establishes the WireGuard tunnel, downloads the trap handler binary, and appears **online** in the UI within seconds.

The collector supports hot-patch self-updates — when you rebuild collector binaries on the hub, connected collectors download and apply the update automatically.

---

## TLS

The installer generates a self-signed EC P-384 CA (10-year) and server certificate (2-year). The CA cert lives at `/etc/anthrimon/tls/ca.crt`.

**Add to your browser** (removes the security warning):

```bash
scp <server>:/etc/anthrimon/tls/ca.crt ~/anthrimon-ca.crt
# macOS:   open ~/anthrimon-ca.crt → trust for all users
# Linux:   sudo cp ~/anthrimon-ca.crt /usr/local/share/ca-certificates/ && sudo update-ca-certificates
# Windows: double-click → Install → Trusted Root Certification Authorities
```

**Renew the server certificate** (CA is preserved, valid 2 years):

```bash
sudo bash scripts/setup-tls.sh
```

---

## Disk Space

Rough estimates for default retention:

| Data type | Per device/day | 10 devices, 90 days |
|---|---|---|
| SNMP metrics (VictoriaMetrics) | ~5 MB | ~4.5 GB |
| Flow records (ClickHouse) | ~50 MB at 1k flows/s | varies greatly |
| Syslog (ClickHouse) | ~10 MB | ~9 GB |
| Config backups (PostgreSQL) | ~100 KB/backup | negligible |

Flow data dominates. A quiet network exporting at 1,000 flows/second averages ~4 GB/day in ClickHouse. Adjust retention in **Administration → Data**.

VictoriaMetrics compresses time-series data aggressively — real usage is typically 30–50% lower than the estimate above.

---

<details>
<summary><b>Project layout</b></summary>

```
collectors/
  snmp/           Go SNMP polling daemon
  flow/           Go NetFlow/sFlow collector
  syslog/         Go syslog collector
  remote/
    cmd/
      remote-collector/   Remote collector agent (WireGuard + SNMP + flow + syslog + config + eAPI/REST)
      trap-handler/       snmptrapd exec handler (deployed to remote sites)
      trap-receiver/      Standalone UDP trap receiver (legacy — hub now uses snmptrapd)
api/
  backend/
    routers/      FastAPI endpoints (~280 endpoints across 31 routers)
    models/       SQLAlchemy ORM models
    schemas/      Pydantic request/response schemas
    alerting/     Alert engine + 23 evaluators + baselines + suppression
    configmgmt/   Config backup/deploy/rollback engine
    licensing/    Offline RS256 license verification + module loader
    intel/        GeoIP + AbuseIPDB threat intelligence
    services/     State writers (BGP, OSPF, IS-IS, routes)
frontend/
  dashboard/      React 19 + Vite 8 frontend (33 pages, 24 widget types)
storage/
  migrations/
    postgres/     PostgreSQL schema migrations (57 + seed)
    clickhouse/   ClickHouse schema migrations (5)
logos/            Branding assets (SVG)
infra/
  scripts/
    install.sh    Full installer — prompts for config, installs everything
    update.sh     Update script — stops services, rebuilds, restarts
scripts/
  setup-tls.sh       Generate self-signed CA + server cert, configure nginx HTTPS
  setup-wireguard.sh Set up WireGuard hub interface (wg0, 10.100.0.1/24)
  setup-nginx.sh     HTTP-only nginx config (standalone, not used by installer)
```

</details>

---

## Documentation

- **[API Reference](https://purpledurpl075.github.io/Anthri-mon/)** — interactive endpoint browser with request/response schemas, generated from the running API's OpenAPI 3.1 spec

## Contributing

Bug reports, feature requests, and pull requests are all welcome.

- **[CONTRIBUTING.md](CONTRIBUTING.md)** — how to get a dev environment, code style, PR process, DCO sign-off
- **[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)** — Contributor Covenant 2.1
- **[SECURITY.md](SECURITY.md)** — how to report vulnerabilities privately

## License

Anthrimon is licensed under the [Apache License 2.0](LICENSE). Third-party dependencies are listed in [NOTICE](NOTICE).

---

<div align="center">
  <img src="https://raw.githubusercontent.com/purpledurpl075/Anthri-mon/main/logos/04-icon-favicon.svg"
       alt="Anthrimon" width="56">
  <br><br>
  <sub>Apache License 2.0</sub>
</div>
