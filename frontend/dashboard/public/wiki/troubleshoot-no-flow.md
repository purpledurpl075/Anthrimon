# No Flow Data Appearing

## 1. Confirm the flow collector is running

```bash
sudo systemctl status flow-collector
journalctl -u flow-collector -n 30 --no-pager
```

Look for `starting UDP listeners` and confirm no errors.

## 2. Verify the device is exporting to the correct IP and port

| Protocol | Port |
|----------|------|
| NetFlow v5 / v9 / IPFIX | UDP 2055 |
| sFlow v5 | UDP 6343 |

Check the device config shows the hub IP as the flow export destination and the correct port. A common mistake is exporting to the wrong port (e.g. sFlow to 2055 instead of 6343).

## 3. Sniff for flow packets on the hub

```bash
sudo tcpdump -n udp port 2055 -i any -c 10
# or for sFlow:
sudo tcpdump -n udp port 6343 -i any -c 10
```

If packets arrive but data is not appearing in the UI, the device IP may not be registered.

## 4. Confirm the exporter IP is a known device

The flow collector maps incoming records to devices by the **exporter source IP**. If the device's export source IP does not match any device's management IP in Anthrimon, the records are dropped.

Check what IP the device uses as the flow source:
- Cisco: `show ip flow export` or `show flow exporter <name>`
- Arista sFlow: `show sflow`

Ensure this IP matches the management IP set for that device in Anthrimon, or update the device's management IP.

## 5. Check for firewall blocks

```bash
sudo ufw status
sudo iptables -L INPUT -n | grep -E "2055|6343"
```

Ensure UDP 2055 and 6343 are permitted from the device subnets.

## 6. Sampling rate

Flow data is sampled (1:N packets). At very low traffic volumes or high sample rates, the flow page may appear empty even when the collector is working. Check the **Flow** page with a longer time range (24h) to confirm data is trickling in.

## 7. Database / ClickHouse errors

```bash
journalctl -u flow-collector -n 50 --no-pager | grep -i "error\|clickhouse"
```

Flow records are stored in ClickHouse. If ClickHouse is down or the DSN is misconfigured, records will be dropped. Check ClickHouse is running:

```bash
sudo systemctl status clickhouse-server
```
