# Anthrimon



Anthrimon combines deep SNMP polling, NetFlow/sFlow analysis, syslog ingest, device configuration management, and distributed remote collection into a single, self-hosted platform with a modern React dashboard.

---

## Features

| Capability | Details |
|---|---|
| **SNMP monitoring** | Interface counters, CPU/memory/temperature/uptime, DOM optical power, ARP/MAC tables, LLDP/CDP neighbors, OSPF, STP, VLANs, routing table |
| **Flow monitoring** | NetFlow v5/v9, IPFIX, sFlow v5 — top talkers, protocol breakdown, interface-level analysis, flow alerts |
| **Syslog** | RFC 3164 + RFC 5424, UDP/TCP on :514, severity breakdown, pattern-match alerts, alert correlation |
| **Config management** | SSH backup (Netmiko), diff viewer, compliance policies, multi-device deploy with template variables |
| **Alerting** | 15-second evaluation, 13 metric types including flow bandwidth and syslog patterns, email notifications, maintenance windows |
| **Topology** | Live L2/L3 map from LLDP/CDP, bandwidth sparklines, persistent layout |
| **Remote collectors** | WireGuard-tunnelled distributed polling agents — one binary, three protocols |
| **Dashboard** | Customizable overview with drag-to-reorder widgets, dark mode, mobile layout |

### Vendor support
Arista EOS · Cisco IOS/IOS-XE/IOS-XR/NX-OS · Juniper · Aruba CX · HP ProCurve · FortiGate · Ubiquiti UniFi · Aruba AP

---
<table>
    <tr>
      <td><a href="https://github.com/user-attachments/assets/5e5bb9e7-3ce4-4724-bd35-4cb1be5e49c4" target="_blank"><img
   src="https://github.com/user-attachments/assets/5e5bb9e7-3ce4-4724-bd35-4cb1be5e49c4" alt="Overview"
  width="100%"/></a><br/><sub><b>Overview dashboard</b></sub></td>
      <td><a href="https://github.com/user-attachments/assets/7e5b331e-880f-4a92-b959-3ed839b3f9a4" target="_blank"><img
   src="https://github.com/user-attachments/assets/7e5b331e-880f-4a92-b959-3ed839b3f9a4" alt="Devices"
  width="100%"/></a><br/><sub><b>Topology</b></sub></td>
    </tr>
    <tr>
      <td><a href="https://github.com/user-attachments/assets/40c44dd3-77b1-420a-975f-86b50a88b423" target="_blank"><img
   src="https://github.com/user-attachments/assets/40c44dd3-77b1-420a-975f-86b50a88b423" alt="Topology"
  width="100%"/></a><br/><sub><b>Logging</b></sub></td>
      <td><a href="https://github.com/user-attachments/assets/32711003-dc57-4f34-bfac-c9c929ae4803" target="_blank"><img
   src="https://github.com/user-attachments/assets/32711003-dc57-4f34-bfac-c9c929ae4803" alt="Flow"
  width="100%"/></a><br/><sub><b>Flow monitoring</b></sub></td>
    </tr>
    <tr>
      <td><a href="https://github.com/user-attachments/assets/872a551c-7090-4cda-bc7e-7a048e23293b" target="_blank"><img
   src="https://github.com/user-attachments/assets/872a551c-7090-4cda-bc7e-7a048e23293b" alt="Alerts"
  width="100%"/></a><br/><sub><b>MAC & ARP Search</b></sub></td>
      <td><a href="https://github.com/user-attachments/assets/8915293a-bb42-488b-9d0f-9ece5424958f" target="_blank"><img
   src="https://github.com/user-attachments/assets/8915293a-bb42-488b-9d0f-9ece5424958f" alt="Config"
  width="100%"/></a><br/><sub><b>Device Health Metrics</b></sub></td>
    </tr>
    <tr>
      <td colspan="2"><a href="https://github.com/user-attachments/assets/68de9a97-1a2e-4cb3-b8ed-0fe2820e958e"
  target="_blank"><img src="https://github.com/user-attachments/assets/68de9a97-1a2e-4cb3-b8ed-0fe2820e958e"
  alt="Syslog" width="100%"/></a><br/><sub><b>Configuration Management & Compliance</b></sub></td>
    </tr>
  </table>
## Requirements

- Ubuntu 22.04 or 24.04 LTS (bare metal or VM)
- 2+ CPU cores, 4 GB RAM minimum (8 GB recommended)
- Outbound internet access for the installer (downloads packages)

The installer handles everything else.

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

It installs all dependencies, creates the database, runs all migrations, builds Go collectors and the React frontend, generates TLS certificates, configures nginx with HTTPS, sets up the WireGuard hub interface, and registers all systemd services.

### First login

Navigate to `https://<your-server-ip>/` and sign in with the default superadmin account:

| Field | Value |
|---|---|
| Username | `admin` |
| Password | `admin` |

> **Change this password immediately** after first login via **Administration → Users**.

---

## Port reference

Open these ports inbound on your server firewall / cloud security group:

| Port | Protocol | Required | Purpose |
|---|---|---|---|
| 443 | TCP | Yes | HTTPS — dashboard and API |
| 51820 | UDP | Remote collectors only | WireGuard VPN tunnel |
| 2055 | UDP | Configurable | NetFlow v5/v9 / IPFIX from network devices |
| 6343 | UDP | Configurable | sFlow from network devices |
| 514 | UDP + TCP | Configurable | Syslog from network devices |

Ports 2055, 6343, and 514 only need to be reachable from your network devices. Port 51820 only needs to be reachable from remote collector hosts.

The API (8001), VictoriaMetrics (8428), ClickHouse (8123/9000), and PostgreSQL (5432) all bind to localhost and are not exposed externally.

---

## Disk space

Rough estimates for 90-day retention defaults:

| Data type | Per device/day | 10 devices, 90 days |
|---|---|---|
| SNMP metrics (VictoriaMetrics) | ~5 MB | ~4.5 GB |
| Flow records (ClickHouse) | ~50 MB at 1k flows/s | varies greatly |
| Syslog (ClickHouse) | ~10 MB | ~9 GB |
| Config backups (PostgreSQL) | ~100 KB/backup | negligible |

Flow data dominates. A quiet network exporting at 1,000 flows/second averages ~4 GB/day in ClickHouse. Reduce the ClickHouse TTL from the default 90 days in **Administration → Data** if disk is constrained.

VictoriaMetrics compresses time-series data aggressively — real usage is typically 30–50% lower than the estimate above.

---

## Stack

| Component | Technology |
|---|---|
| API | Python 3.12, FastAPI, SQLAlchemy, uvicorn |
| Frontend | React 19, Vite, Tailwind CSS v4, React Query |
| Time-series | VictoriaMetrics |
| Flow/Syslog storage | ClickHouse |
| Relational DB | PostgreSQL 14 |
| SNMP collector | Go 1.22 |
| Flow collector | Go 1.22 — NetFlow v5/v9, IPFIX, sFlow v5 |
| Syslog collector | Go 1.22 — RFC 3164 + RFC 5424 |
| Reverse proxy | nginx — HTTPS with self-signed CA |
| VPN | WireGuard — remote collector tunnels |

---

## Services

All services are managed by systemd:

```bash
systemctl status anthrimon-api       # FastAPI backend (127.0.0.1:8001)
systemctl status snmp-collector      # SNMP polling daemon
systemctl status flow-collector      # NetFlow/sFlow listener (:2055, :6343)
systemctl status syslog-collector    # Syslog listener (:514 UDP/TCP)
systemctl status nginx               # HTTPS frontend + API proxy (:443)
systemctl status victoria-metrics    # Time-series store (:8428)
systemctl status clickhouse-server   # Flow/syslog analytics store
systemctl status postgresql          # Relational database
systemctl status wg-quick@wg0        # WireGuard hub interface
```

---

## Architecture

```
                    HTTPS :443
Browser ──────────────────────────▶ nginx ──▶ dist/ (React SPA)
                                          └──▶ :8001 (FastAPI)
                                                    │
                              ┌─────────────────────┼────────────────────┐
                              ▼                     ▼                    ▼
                        PostgreSQL          VictoriaMetrics          ClickHouse
                      (alerts, cfg)          (SNMP metrics)       (flows, syslog)

Network devices
  SNMP polling  ◀────── snmp-collector (Go)
  NetFlow/sFlow ───────▶ flow-collector (Go)     :2055 / :6343
  Syslog        ───────▶ syslog-collector (Go)   :514

Remote sites (WireGuard tunnel 10.100.0.0/24)
  wg0: 10.100.0.1 ◀──── collector binary         SNMP + flow + syslog
                        (polls local devices, forwards data to hub)
```

---

## Remote Collectors

For devices at remote sites that can't reach the hub directly, deploy a lightweight collector binary that tunnels home over WireGuard.

**Hub setup** (runs automatically during installation):
```bash
sudo bash scripts/setup-wireguard.sh   # creates wg0 at 10.100.0.1/24
```

**Register a collector** — in the Anthrimon UI:
1. Go to **Configuration → Collectors → New collector**
2. Save the registration token and CA cert shown (one-time display)
3. On the remote server:
```bash
export ANTHRIMON_HUB=https://<hub-ip>
export ANTHRIMON_TOKEN=<registration-token>
export ANTHRIMON_CA=/etc/anthrimon/ca.crt
anthrimon-collector
```

The collector generates a WireGuard keypair, bootstraps the peer via HTTPS, then all subsequent communication goes through the encrypted tunnel. Devices in the hub UI can be assigned to a specific collector.

---

## TLS

The installer generates a self-signed CA and server certificate. The CA cert lives at `/etc/anthrimon/tls/ca.crt`.

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

## Upgrading

```bash
git pull
sudo bash infra/scripts/install.sh
```

The installer is idempotent — it skips steps already complete (existing CA, existing WireGuard config, already-applied migrations).

---

## Project layout

```
collectors/
  snmp/           Go SNMP polling daemon
  flow/           Go NetFlow/sFlow collector
  syslog/         Go syslog collector
api/
  backend/
    routers/      FastAPI endpoints
    models/       SQLAlchemy models
    alerting/     Alert engine + evaluators
    configmgmt/   Config backup/deploy engine
frontend/
  dashboard/      React 19 + Vite frontend
storage/
  migrations/
    postgres/     PostgreSQL schema migrations (021 files)
    clickhouse/   ClickHouse schema migrations (003 files)
scripts/
  setup-tls.sh           Generate self-signed CA + server cert, configure nginx HTTPS
  setup-wireguard.sh     Set up WireGuard hub interface (wg0, 10.100.0.1/24)
infra/
  scripts/
    install.sh       Full installer — prompts for config, installs everything
```

---

## License

MIT
