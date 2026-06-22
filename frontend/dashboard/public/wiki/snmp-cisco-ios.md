# SNMP Setup — Cisco IOS / IOS-XE

## SNMPv2c (read-only)

```
snmp-server community <community-string> RO
snmp-server location <location>
snmp-server contact <contact>
```

### Restrict access by source IP (recommended)

```
ip access-list standard SNMP-ACL
 permit <collector-ip>
 deny any

snmp-server community <community-string> RO SNMP-ACL
```

## SNMPv3 (recommended for security)

```
snmp-server group MONITOR v3 priv
snmp-server user <username> MONITOR v3 auth sha <auth-password> priv aes 128 <priv-password>
```

To restrict by source IP with v3:

```
snmp-server group MONITOR v3 priv access SNMP-ACL
```

## Enable SNMP traps (optional)

Configure the device to send traps to the hub on UDP 162:

```
snmp-server enable traps
snmp-server host <anthrimon-ip> version 2c <community-string>
```

For SNMPv3 traps, use `version 3 priv <username>` instead. The hub receives traps via `anthrimon-trap-receiver` and classifies them automatically. See the [Supported Vendor Matrix](vendor-matrix) for trap classification details.

## Verify

```
show snmp community
show snmp user
show snmp group
```

Send a test:

```
show snmp
```

Check the `snmpInPkts` counter is incrementing as the collector polls.

## Source interface

Bind SNMP responses to a specific interface so reply packets come from the management IP:

```
snmp-server trap-source Loopback0
```

## Notes

- IOS-XE supports both v2c and v3 simultaneously
- The `RO` keyword is important — never use `RW` for monitoring credentials
- If using VRF-aware management, add `vrf <vrf-name>` to the community or group config
