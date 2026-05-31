# SNMP Setup — Arista EOS

## SNMPv2c

```
snmp-server community <community-string> ro
snmp-server contact <contact>
snmp-server location <location>
```

### Restrict by source IP

```
ip access-list SNMP-ACL
   permit ip <collector-ip>/32 any

snmp-server community <community-string> ro SNMP-ACL
```

## SNMPv3

```
snmp-server group MONITOR v3 priv
snmp-server user <username> MONITOR v3 auth sha <auth-password> priv aes <priv-password>
```

## Management VRF

Most Arista platforms use a `management` VRF for the Management interface. Bind SNMP to it:

```
snmp-server vrf management community <community-string> ro
```

Or for SNMPv3:

```
snmp-server vrf management
```

Ensure the SNMP credential in Anthrimon uses the Management IP (not a data-plane IP) and that the collector can reach it.

## Verify

```
show snmp community
show snmp user
show snmp
```

## Source interface

```
snmp-server source-interface Management1
```

## Notes

- Arista also supports eAPI for richer data collection. To enable both SNMP and eAPI, add an `api_token` or `eapi` credential type alongside the SNMP credential
- See [Configuring SNMP Credentials](snmp-credentials) for credential setup in Anthrimon
