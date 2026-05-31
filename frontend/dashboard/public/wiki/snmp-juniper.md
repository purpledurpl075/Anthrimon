# SNMP Setup — Juniper JunOS

## SNMPv2c

```
set snmp community <community-string> authorization read-only
set snmp contact <contact>
set snmp location <location>
set snmp description <hostname>
```

### Restrict by source IP

```
set snmp community <community-string> clients <collector-ip>/32
```

## SNMPv3

```
set snmp v3 usm local-engine user <username> authentication-sha authentication-password <auth-password>
set snmp v3 usm local-engine user <username> privacy-aes128 privacy-password <priv-password>
set snmp v3 vacm security-to-group security-model usm security-name <username> group MONITOR
set snmp v3 vacm access group MONITOR default-context-prefix security-model usm security-level privacy read-view all
set snmp v3 vacm access group MONITOR default-context-prefix security-model usm security-level privacy notify-view all
set snmp view all oid 1 include
```

## Routing instance (management VRF)

If using the `mgmt_junos` routing instance:

```
set snmp routing-instance-access
set snmp community <community-string> routing-instance mgmt_junos
```

## Verify

```
show snmp community
show snmp statistics
show snmp v3
```

## Notes

- JunOS SNMP is read-only by default — no `RO` keyword is needed
- The `clients` statement acts as an ACL; omit it to allow all sources (not recommended in production)
