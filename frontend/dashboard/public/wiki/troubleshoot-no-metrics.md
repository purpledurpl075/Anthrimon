# No Metrics or Stale Data

## Check all collector services are running

```bash
sudo systemctl status snmp-collector flow-collector syslog-collector anthrimon-api
```

All four should show `active (running)`.

## Check VictoriaMetrics

```bash
curl -s http://localhost:8428/health
```

Should return `OK`. If VictoriaMetrics is down, no time-series data will appear in the UI even if collectors are polling.

```bash
sudo systemctl status victoria-metrics
sudo systemctl restart victoria-metrics
```

## SNMP collector not writing

Check logs for database errors:

```bash
journalctl -u snmp-collector -n 30 --no-pager | grep error
```

If you see password authentication failures, the DB password in the collector config is wrong — see [Changing the Database Password](changing-db-password).

## Flow data missing

Verify sFlow/NetFlow is configured on the switch to export to the hub IP on UDP 6343 (sFlow) or 2055 (NetFlow).

Check the flow collector is receiving packets:

```bash
journalctl -u flow-collector -f
```

You should see flow records logged every few seconds when traffic is flowing.

## Metrics appear in VictoriaMetrics but not in the UI

This is usually a browser cache or time-range issue. Try:
- Switching to a longer time range (6h or 24h)
- Hard-refreshing the page (Ctrl+Shift+R)
- Checking the API directly: `curl -s https://<host>/api/v1/devices/<id>/health/history?hours=1`

## Health tab shows — for all values

The `device_health_latest` table may be empty for this device. Check:

```bash
PGPASSWORD='<password>' psql -U anthrimon -h 127.0.0.1 -d anthrimon \
  -c "SELECT collected_at, cpu_util_pct FROM device_health_latest WHERE device_id = '<id>';"
```

If no row exists, the SNMP collector has not successfully written health data yet.
