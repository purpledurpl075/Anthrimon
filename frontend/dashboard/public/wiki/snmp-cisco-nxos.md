# SNMP Setup — Cisco NX-OS

## SNMPv2c

```
snmp-server community <community-string> ro
snmp-server contact <contact>
snmp-server location <location>
```

### Restrict to collector IP

```
ip access-list SNMP-ACL
  permit ip <collector-ip>/32 any

snmp-server community <community-string> ro use-acl SNMP-ACL
```

## SNMPv3

```
snmp-server user <username> network-monitor auth sha <auth-password> priv aes-128 <priv-password>
snmp-server group network-monitor v3 priv
```

## Management VRF

NX-OS management interfaces are typically in the `management` VRF. The SNMP collector needs to reach the device via the mgmt VRF:

```
snmp-server host <collector-ip> use-vrf management
```

And ensure the community or user is accessible from the management VRF:

```
snmp-server community <community-string> ro use-vrf management
```

## Verify

```
show snmp community
show snmp user
show snmp host
```

## Feature enable

SNMP is enabled by default on NX-OS. If it was disabled:

```
feature snmp
```
