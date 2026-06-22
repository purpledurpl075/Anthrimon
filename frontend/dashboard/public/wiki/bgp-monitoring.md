# BGP Monitoring

Anthrimon collects BGP session state and prefix counts via SNMP (BGP4-MIB) and tracks them over time in VictoriaMetrics.

## What is collected

| Data | Source | Where it appears |
|------|--------|-----------------|
| Session state (Established / Idle / Active / etc.) | SNMP BGP4-MIB | Routing → BGP tab |
| Peer IP and remote AS | SNMP | BGP tab |
| Prefixes received | SNMP | BGP tab + chart |
| In/out UPDATE counts | SNMP | BGP charts |
| Session flap history | SNMP delta | BGP tab |
| Prefix count history | VictoriaMetrics | BGP prefix chart |

## Requirements

- SNMP must be working on the device
- The device must support **BGP4-MIB** (RFC 4273) — supported by Cisco IOS/IOS-XE/IOS-XR/NX-OS, Arista, Juniper, and most major platforms
- For Arista, eAPI collection supplements SNMP and provides additional detail

## BGP alert rules

### Session down

`bgp_session_down` fires when any BGP session on the device leaves the `Established` state. No threshold — fires immediately.

### Session flapping

`bgp_session_flapping` fires when a session goes up/down more than N times within a configurable window. Useful for detecting unstable peers without alerting on clean failovers.

### Prefix drop

`bgp_prefix_drop` fires when received prefixes from a peer drop by more than a threshold percentage from the baseline. Requires at least **50 historical samples** (~25 minutes at a 30-second poll interval) before the baseline is established.

Configure the threshold as a percentage, e.g. `20` = alert if prefix count drops by more than 20%.

## Prefix history

The **Routing** page shows a chart of received prefix counts over time per peer. This is useful for:

- Detecting route leaks (sudden spike)
- Detecting partial prefix withdrawal (gradual drop)
- Confirming expected prefix counts after a peering change

## Full-table analysis

For devices receiving a full BGP routing table, the prefix count baseline adapts to gradual growth. The alerting engine uses a rolling Welford mean/stddev. Sudden large drops (route leak cleanup, peer reset) will still trigger `bgp_prefix_drop` once the baseline is established.

## Viewing BGP data

Go to **Routing** and select a device. The **BGP** section shows:

- All peers with current state and uptime
- Session history timeline
- Prefix count chart per peer

For a device-specific view, open the device detail page → **BGP** tab.
