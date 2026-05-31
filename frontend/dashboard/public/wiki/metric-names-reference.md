# Metric Names Reference

All metrics are stored in VictoriaMetrics and queryable via the MetricsQL API at `http://localhost:8428`.

## Common labels

| Label | Description |
|-------|-------------|
| `device_id` | UUID of the device |
| `if_index` | SNMP interface index |
| `if_name` | Interface name (e.g. `GigabitEthernet0/1`) |

---

## Device health

| Metric | Type | Description |
|--------|------|-------------|
| `anthrimon_device_cpu_util_pct` | Gauge | CPU utilisation %. Label: `cpu_index` |
| `anthrimon_device_mem_total_bytes` | Gauge | Total memory in bytes. Label: `mem_type` |
| `anthrimon_device_mem_used_bytes` | Gauge | Used memory in bytes. Label: `mem_type` |
| `anthrimon_device_temp_celsius` | Gauge | Temperature sensor reading. Label: `sensor` |
| `anthrimon_device_uptime_seconds` | Gauge | Device uptime in seconds |

## Interface metrics

| Metric | Type | Description |
|--------|------|-------------|
| `anthrimon_if_in_octets_total` | Counter | Inbound bytes (ifHCInOctets) |
| `anthrimon_if_out_octets_total` | Counter | Outbound bytes (ifHCOutOctets) |
| `anthrimon_if_in_errors_total` | Counter | Inbound errors |
| `anthrimon_if_out_errors_total` | Counter | Outbound errors |
| `anthrimon_if_in_discards_total` | Counter | Inbound discards |
| `anthrimon_if_out_discards_total` | Counter | Outbound discards |
| `anthrimon_if_speed_bps` | Gauge | Interface speed in bits per second |
| `anthrimon_if_oper_status` | Gauge | Operational status (1 = up, 0 = down) |

## Optical / DOM

| Metric | Type | Description |
|--------|------|-------------|
| `anthrimon_if_dom_rx_power_dbm` | Gauge | DOM Rx optical power in dBm. Label: `if_name` |
| `anthrimon_if_dom_tx_power_dbm` | Gauge | DOM Tx optical power in dBm. Label: `if_name` |

## BGP

| Metric | Type | Description |
|--------|------|-------------|
| `anthrimon_bgp_prefixes_received` | Gauge | Prefixes received from peer. Labels: `peer_ip`, `remote_as` |
| `anthrimon_bgp_in_updates_total` | Counter | BGP UPDATE messages received |
| `anthrimon_bgp_out_updates_total` | Counter | BGP UPDATE messages sent |
| `anthrimon_bgp_flap_count_total` | Counter | Cumulative session flap count |

## ICMP probe

| Metric | Type | Description |
|--------|------|-------------|
| `anthrimon_device_rtt_ms` | Gauge | ICMP round-trip time in ms. Label: `stat` = `min`/`avg`/`max` |
| `anthrimon_device_loss_pct` | Gauge | ICMP packet loss percentage (0–100) |

---

## Example queries (MetricsQL)

Bandwidth utilisation on an interface in Mbps:

```
rate(anthrimon_if_in_octets_total{device_id="<uuid>", if_name="GigabitEthernet0/1"}[5m]) * 8 / 1e6
```

Average CPU across all devices:

```
avg(anthrimon_device_cpu_util_pct)
```

Devices with packet loss > 0:

```
anthrimon_device_loss_pct > 0
```
