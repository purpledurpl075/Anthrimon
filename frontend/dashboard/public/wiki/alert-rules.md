# Creating Alert Rules

## Rule structure

Each rule has:
- **Metric** — what to monitor (CPU, interface down, BGP session, etc.)
- **Threshold** — the value that triggers the alert
- **Severity** — `critical`, `warning`, or `info`
- **Policy** — which notification channels to use

## Supported metrics

### Device

| Metric | Description | Threshold |
|--------|-------------|-----------|
| `device_down` | Device unreachable for 2.5× poll interval | — |
| `device_latency` | ICMP RTT or packet loss above threshold | RTT in ms or loss % |
| `uptime` | Device uptime drops below threshold (reboot detection) | seconds |
| `temperature` | Any sensor temperature exceeds threshold | °C |

### Interfaces

| Metric | Description | Threshold |
|--------|-------------|-----------|
| `interface_down` | Interface transitions to operationally down | — |
| `interface_flap` | Interface flaps more than N times within a time window | flap count |
| `interface_util_pct` | Interface bandwidth utilisation exceeds threshold | % |
| `interface_errors` | Interface error rate exceeds threshold | errors/sec |

### Routing

| Metric | Description | Threshold |
|--------|-------------|-----------|
| `ospf_state` | OSPF neighbour adjacency lost or in non-Full state | — |
| `bgp_session_down` | BGP session drops | — |
| `bgp_session_flapping` | BGP session flaps more than N times in a window | flap count |
| `bgp_prefix_drop` | BGP received prefix count drops by more than threshold% | % drop |
| `route_missing` | A specific prefix disappears from the routing table | prefix (CIDR) |

### Traffic & Logs

| Metric | Description | Threshold |
|--------|-------------|-----------|
| `flow_bandwidth` | Flow traffic on an interface exceeds threshold | bps |
| `syslog_match` | Syslog message matches a regex pattern | regex string |

### Custom

| Metric | Description | Threshold |
|--------|-------------|-----------|
| `cpu_util_pct` | CPU utilisation above threshold | % |
| `mem_util_pct` | Memory utilisation above threshold | % |
| `custom_oid` | Any SNMP OID value compared against a threshold | numeric value |

## Creating a rule

1. Go to **Alert Rules** → **New Rule**
2. Select the metric type
3. Set the threshold (e.g., CPU > 90%)
4. Choose severity
5. Assign a policy for notifications
6. Optionally scope to specific devices or interfaces

## Notes on specific metrics

### `device_latency`
Fires on high RTT or packet loss from ICMP probing. **Never implies the device is down** — it fires a separate latency alert only. Requires CAP_NET_RAW on the collector for ICMP to work.

### `interface_flap`
Counts state changes within a sliding window. Threshold is the number of flaps; configure the window in seconds. Useful for detecting oscillating links without alerting on a single clean bounce.

### `bgp_prefix_drop`
Fires when the received prefix count falls below `(baseline − threshold%)`. Requires at least 50 historical samples before the baseline is established.

### `bgp_session_flapping`
Similar to `interface_flap` — counts BGP session state changes within a window rather than alerting on a single drop/restore cycle.

### `custom_oid`
Polls any SNMP OID and compares the value to a threshold using `gt`, `gte`, `lt`, or `lte`. The OID config is a JSON object: `{"oid": "1.3.6.1...", "condition": "gt"}`.

### `route_missing`
Checks the routing table for a specific prefix (e.g., `10.0.0.0/8`). Fires if the prefix is absent. Useful for monitoring critical static or redistributed routes.

### `syslog_match`
Matches syslog messages against a regex. Scope it to specific devices and set a severity. Useful for alerting on interface errors, authentication failures, or hardware events logged via syslog.

## Baselines

For `cpu_util_pct`, `mem_util_pct`, and `bgp_prefix_drop`, the system builds a 14-day rolling baseline. Rules can alert when the value exceeds **mean + 3σ** rather than a fixed threshold.

View baselines per device on the **Health** tab of the device detail page.

## Suppression

Rules are suppressed during active **Maintenance Windows**. Create windows under **Maintenance** before planned changes to avoid alert noise.

To permanently suppress a rule for a device, use **Alert Exclusions** on the device detail page.
