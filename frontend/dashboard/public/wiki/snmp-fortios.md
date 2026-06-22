# SNMP Setup — Fortinet FortiOS

## SNMPv2c via CLI

```
config system snmp community
    edit 1
        set name <community-string>
        set status enable
        config hosts
            edit 1
                set interface <mgmt-interface>
                set ip <collector-ip>/32
            next
        end
        set events cpu-high mem-low intf-ip vpn-tun-up vpn-tun-down ha-switch ha-hb-failure
    next
end
```

## SNMPv3 via CLI

```
config system snmp user
    edit <username>
        set status enable
        set auth-proto sha
        set auth-pwd <auth-password>
        set priv-proto aes
        set priv-pwd <priv-password>
        set notify-hosts <collector-ip>
    next
end
```

## GUI setup

Go to **System** → **SNMP** → **SNMP v1/v2c** or **SNMP v3** and add an entry with the collector IP as the allowed host.

## Source interface

To ensure SNMP replies come from the management interface, set:

```
config system snmp sysinfo
    set status enable
end
```

And configure the management interface IP as the device's management IP in Anthrimon.

## Verify

From the hub server:

```bash
snmpwalk -v2c -c <community-string> <fortigate-ip> 1.3.6.1.2.1.1.1.0
```

## Notes

- FortiOS supports SNMP across VDOMs; configure SNMP in each VDOM if needed
- The `hosts` list acts as an ACL — only listed IPs can query the device
- `events` in the community config controls which SNMP traps are sent to the hub on UDP 162; Anthrimon classifies traps automatically by OID
