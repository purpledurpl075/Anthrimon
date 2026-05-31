# SNMP Setup — HP ProCurve / Aruba

## ProCurve (older firmware)

```
snmp-server community <community-string> operator restricted
```

`operator` = read-only. `manager` = read-write (do not use for monitoring).

### Restrict by source IP

```
snmp-server community <community-string> operator restricted <collector-ip>
```

### Verify

```
show snmp-server
```

## Aruba CX (ArubaOS-CX)

### SNMPv2c

```
snmp-server community <community-string>
snmp-server vrf mgmt
```

### SNMPv3

```
snmp-server user <username> auth sha auth-pass <auth-password> priv aes priv-pass <priv-password>
snmp-server group MONITOR v3 priv
snmp-server user <username> group MONITOR
```

### Verify

```
show snmp community
show snmp user
```

## Notes

- ProCurve switches support SNMPv2c and v3; older models (2500 series) may only support v1/v2c
- The source IP used for SNMP responses is the outbound interface IP — ensure this matches the management IP registered in Anthrimon
- ProCurve models 2920 and newer support up to v3 with AES128
- Aruba CX uses REST API for config collection in addition to SNMP for metrics; see [Config Management Setup](config-management)
