# SNMP Collection Failures

## Run the built-in diagnostic

On the device detail page, click the **gear icon** to open **Device Settings** and scroll to the **SNMP Diagnostic** section. Click **Run** to perform a live SNMP walk. This shows:
- Which credential succeeded or failed
- Response time
- Sample OID values returned

## Common failure causes

### Wrong community string (v2c)
The device returns no data or `No Such Object`. Verify the community string matches what's configured on the device.

**Cisco IOS:**
```
show snmp community
```

**HP ProCurve:**
```
show snmp-server
```

**Arista EOS:**
```
show snmp community
```

### SNMPv3 auth/priv mismatch
Verify the security level, auth protocol, and privacy protocol match the device config exactly. A mismatch typically results in a timeout or `Unknown security name` error.

### Access list blocking the collector

Many devices restrict SNMP access by source IP. Ensure the collector's management IP is permitted.

**Cisco IOS:**
```
show snmp community | include <community>
ip access-list standard SNMP-ACCESS
  permit <collector-ip>
```

### SNMP not enabled on the device

```bash
snmpwalk -v2c -c <community> <mgmt-ip> 1.3.6.1.2.1.1.1.0
```

If this times out from the hub server, SNMP is not reachable.

### Firewall blocking UDP 161

Check that UDP port 161 is open between the collector and the device. For remote-collector-managed devices, the firewall check should be done from the remote collector host, not the hub.

## Collector credential retry order

The SNMP collector tries credentials in ascending priority order (1 = first). If a higher-priority credential times out, it adds latency before falling back. Remove or lower-priority credentials that are no longer valid.

## Arista eAPI errors

Arista devices support both SNMP and eAPI. If eAPI collection is failing:
- Verify HTTPS is enabled on the device: `management api http-commands`
- If using HTTP (not HTTPS), ensure `eapi_allow_http: true` is set on the device record in the database
- Check the credential type is set to `api_token` in Credentials
