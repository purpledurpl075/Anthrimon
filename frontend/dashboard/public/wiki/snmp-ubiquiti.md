# SNMP Setup — Ubiquiti

## UniFi (via UniFi Network Application)

Go to **Settings** → **System** → **SNMP** and enable SNMP. Set the community string. The SNMP agent runs on each UniFi gateway (UDM, UDM-Pro, USG).

Alternatively via SSH on the gateway:

```bash
set service snmp community <community-string> authorization read-only
set service snmp community <community-string> client <collector-ip>
commit
save
```

## EdgeOS (EdgeRouter) — SNMPv2c

```
set service snmp community <community-string> authorization read-only
set service snmp community <community-string> client <collector-ip>
set service snmp contact <contact>
set service snmp location <location>
commit
save
```

## EdgeOS — SNMPv3

```
set service snmp v3 group MONITOR mode read-only
set service snmp v3 group MONITOR seclevel priv
set service snmp v3 user <username> group MONITOR
set service snmp v3 user <username> auth plaintext-password <auth-password>
set service snmp v3 user <username> auth type sha
set service snmp v3 user <username> privacy plaintext-password <priv-password>
set service snmp v3 user <username> privacy type aes
commit
save
```

## Verify

```
show service snmp
```

From the hub:

```bash
snmpwalk -v2c -c <community-string> <device-ip> 1.3.6.1.2.1.1.1.0
```

## Notes

- Ubiquiti UniFi APs do not support SNMP on the AP itself; metrics come from the controller
- EdgeOS uses VyOS-style configuration; always `commit` and `save` after changes
- The SNMP client restriction (`client <ip>`) acts as an ACL and is strongly recommended
