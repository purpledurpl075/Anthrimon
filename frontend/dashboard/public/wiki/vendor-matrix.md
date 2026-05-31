# Supported Vendor Matrix

## Feature support by vendor

| Vendor | SNMP | Config (SSH) | eAPI / REST | sFlow | NetFlow / IPFIX | Syslog |
|--------|------|-------------|-------------|-------|----------------|--------|
| Cisco IOS / IOS-XE | ✓ | ✓ | — | — | ✓ v5/v9 | ✓ |
| Cisco IOS-XR | ✓ | ✓ | — | — | ✓ v9/IPFIX | ✓ |
| Cisco NX-OS | ✓ | ✓ | — | — | ✓ v9 | ✓ |
| Arista EOS | ✓ | ✓ | ✓ (eAPI) | ✓ | — | ✓ |
| Juniper JunOS | ✓ | ✓ | — | — | ✓ IPFIX/J-Flow | ✓ |
| HP ProCurve | ✓ | ✓ (invoke_shell) | — | ✓ | — | ✓ (UDP only) |
| Aruba CX | ✓ | ✓ (REST) | ✓ | ✓ | — | ✓ |
| Fortinet FortiOS | ✓ | — | — | — | ✓ v9 | ✓ |
| Ubiquiti EdgeOS | ✓ | ✓ | — | — | ✓ v9 | ✓ |
| Ubiquiti UniFi | ✓ | — | — | — | ✓ | ✓ |
| Ubiquiti AirOS | — | — | — | — | — | ✓ |
| Aruba AP | ✓ (limited) | — | — | — | — | — |

## Protocol support summary

### Flow protocols

| Protocol | Port | Supported versions |
|----------|------|--------------------|
| NetFlow | UDP 2055 | v5, v9 |
| IPFIX | UDP 2055 | RFC 7011 |
| sFlow | UDP 6343 | v5 |

### Syslog formats

| Format | Port | Transport |
|--------|------|-----------|
| RFC 3164 (BSD syslog) | 514 | UDP, TCP |
| RFC 5424 | 514 | UDP, TCP |

### SNMP versions

| Version | Supported |
|---------|-----------|
| SNMPv1 | ✓ |
| SNMPv2c | ✓ |
| SNMPv3 (auth+priv) | ✓ |

## Notes

- **Config (invoke_shell)** — ProCurve switches require an interactive terminal session; collection is slower but fully supported
- **Arista eAPI** — supplements SNMP with richer BGP, IS-IS, and LLDP data; requires an `eapi` credential type
- **Aruba CX REST** — config collection uses the REST API; link an `api_token` credential
- **FortiOS config** — SSH-based config collection is not yet implemented; use the Fortinet CLI backup export as a workaround
- **UniFi** — metrics come from the gateway (UDM/USG), not individual APs
