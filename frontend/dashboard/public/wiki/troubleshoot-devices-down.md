# Devices Showing as Down or Unreachable

## Check if the device is actually reachable

```bash
ping -c 3 <mgmt-ip>
```

If ping fails, the device may genuinely be down or the management network is unreachable.

## Check the SNMP collector logs

```bash
journalctl -u snmp-collector -n 50 --no-pager | grep -i "error\|<device-ip>"
```

Common errors:

### Database auth failure
```
failed SASL auth: FATAL: password authentication failed for user "anthrimon"
```
The collector has the wrong DB password. Update `/home/poly/Anthri-mon/collectors/snmp/snmp-collector.yaml` — see [Changing the Database Password](changing-db-password).

### SNMP timeout
```
request timeout for device <id>
```
SNMP credentials may be wrong, or the device's SNMP access list is blocking the collector. Open the device's **Device Settings** drawer (gear icon) → **SNMP Diagnostic** section and click **Run**.

## Check last_polled in the database

```bash
PGPASSWORD='<password>' psql -U anthrimon -h 127.0.0.1 -d anthrimon \
  -c "SELECT hostname, mgmt_ip, status, last_polled FROM devices WHERE mgmt_ip = '<ip>';"
```

If `last_polled` is more than a few minutes old, the collector is not reaching the device.

## Remote collector devices

If the device is assigned to a **remote collector**, check that collector is online on the **Collectors** page. If the collector is offline, device-down alerts are automatically suppressed until it reconnects.

## False positives after password rotation

After changing the DB password, all collectors must be updated and restarted. Until they are, `last_polled` goes stale and the alerting engine fires `device_down`. See [Changing the Database Password](changing-db-password).

## Device is up but showing unreachable

The alert engine marks a device unreachable when `last_polled` is older than `2.5 × poll_interval` (default: 37.5 seconds). If the device responds to SNMP but `last_polled` is not updating, the collector is polling but failing to write to the database.
