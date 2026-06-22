# No Syslog Messages Appearing

## 1. Confirm the syslog collector is running

```bash
sudo systemctl status syslog-collector
journalctl -u syslog-collector -n 30 --no-pager
```

The service should show `active (running)` and log lines like `udp syslog listener ready` and `tcp syslog listener ready`.

## 2. Check the device is actually sending

On the device, verify syslog is configured and directed to the hub IP. Trigger a test message if the platform supports it (e.g. Juniper `request system syslog test-message`).

## 3. Verify UDP 514 is reachable

From the device's management subnet, test connectivity to the hub on UDP 514:

```bash
# From the hub, listen for UDP packets:
sudo tcpdump -n udp port 514 -i any
```

Then generate a syslog event on the device and watch for packets. If none appear, the traffic is being blocked by a firewall between the device and the hub.

Check the hub firewall:

```bash
sudo ufw status
sudo iptables -L INPUT -n | grep 514
```

Ensure UDP 514 (and TCP 514 if using TCP syslog) is permitted from the device's management IP.

## 4. Confirm the source IP matches a known device

The syslog collector maps incoming messages to devices by source IP. If the source IP does not match any device's management IP in the database, the message is still stored but will not appear in a device's syslog view.

Check the device's management IP in Anthrimon matches the IP actually used for syslog. Many devices use the outbound interface IP, not necessarily the management IP — configure a `source-interface` on the device to fix this.

## 5. Check the syslog page filter

On the **Logging** page (under Operations in the sidebar), ensure the time range and severity filter are not hiding recent messages. Set severity to **All** and time range to **Last 15 minutes**.

## 6. Database errors

```bash
journalctl -u syslog-collector -n 50 --no-pager | grep error
```

If you see password authentication failures, the syslog collector has the wrong DB password. Update `/home/poly/Anthri-mon/collectors/syslog/syslog-collector.yaml` and restart. See [Changing the Database Password](changing-db-password).
