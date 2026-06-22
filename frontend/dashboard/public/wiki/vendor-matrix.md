# Supported Vendor Matrix

## Feature support by vendor

| Vendor | SNMP | Config (SSH) | eAPI / REST | sFlow | NetFlow / IPFIX | Syslog | Traps |
|--------|------|-------------|-------------|-------|----------------|--------|-------|
| Cisco IOS / IOS-XE | ✓ | ✓ | — | — | ✓ v5/v9 | ✓ | ✓ |
| Cisco IOS-XR | ✓ | ✓ | — | — | ✓ v9/IPFIX | ✓ | ✓ |
| Cisco NX-OS | ✓ | ✓ | — | — | ✓ v9 | ✓ | ✓ |
| Arista EOS | ✓ | ✓ | ✓ (eAPI) | ✓ | — | ✓ | ✓ |
| Juniper JunOS | ✓ | ✓ | — | — | ✓ IPFIX/J-Flow | ✓ | ✓ |
| HP ProCurve | ✓ | ✓ (invoke_shell) | — | ✓ | — | ✓ (UDP only) | ✓ |
| Aruba CX | ✓ | ✓ (REST) | ✓ | ✓ | — | ✓ | ✓ |
| Fortinet FortiOS | ✓ | ✓ | — | — | ✓ v9 | ✓ | ✓ |
| Ubiquiti EdgeOS | ✓ | ✓ | — | — | ✓ v9 | ✓ | ✓ |
| Ubiquiti UniFi | ✓ | — | — | — | ✓ | ✓ | ✓ |
| Ubiquiti AirOS | — | — | — | — | — | ✓ | — |
| Aruba AP | ✓ (limited) | — | — | — | — | — | — |

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
| SNMPv1 | ✓ (normalised to v2c by snmptrapd) |
| SNMPv2c | ✓ |
| SNMPv3 (authPriv) | ✓ |

### SNMP trap classification by vendor

| OID prefix | Trap type | Severity |
|-----------|-----------|---------|
| 1.3.6.1.6.3.1.1.5.1 | coldStart | warning |
| 1.3.6.1.6.3.1.1.5.2 | warmStart | info |
| 1.3.6.1.6.3.1.1.5.3 | linkDown | critical |
| 1.3.6.1.6.3.1.1.5.4 | linkUp | info |
| 1.3.6.1.6.3.1.1.5.5 | authenticationFailure | warning |
| 1.3.6.1.4.1.30065.3.9 | arista.bgpPeerStateChange | warning |
| 1.3.6.1.4.1.30065.3.10 | arista.linkStateChange | warning |
| 1.3.6.1.4.1.30065. | arista.trap | info |
| 1.3.6.1.4.1.47196.4.1.1.3.20 | aruba_cx.linkStateChange | warning |
| 1.3.6.1.4.1.47196. | aruba_cx.trap | info |
| 1.3.6.1.4.1.11.2.14.12.1 | hp.linkChange | warning |
| 1.3.6.1.4.1.11.2. | hp.trap | info |
| 1.3.6.1.4.1.9.9.187. | cisco.bgpBackwardTransition | critical |
| 1.3.6.1.4.1.9. | cisco.trap | info |
| 1.3.6.1.4.1.2636. | juniper.trap | info |

## Notes

- **Config (invoke_shell)** — ProCurve switches require an interactive terminal session; collection is slower but fully supported
- **Arista eAPI** — supplements SNMP with richer BGP, IS-IS, and LLDP data; requires an `api_token` credential
- **Aruba CX REST** — config collection uses the REST API; link an `api_token` credential
- **FortiOS config** — SSH-based config collection runs `show full-configuration` via Netmiko (`fortinet` driver)
- **UniFi** — metrics come from the gateway (UDM/USG), not individual APs
- **Traps (hub)** — the hub receives traps directly via `anthrimon-trap-receiver` on UDP 162
- **Traps (remote collector)** — the remote collector uses `snmptrapd` + `anthrimon-traphandler`; v3 user keys are pushed automatically from the hub when credentials are saved
