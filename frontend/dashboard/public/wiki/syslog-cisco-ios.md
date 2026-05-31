# Syslog — Cisco IOS / IOS-XE

The syslog collector listens on **UDP and TCP port 514** and accepts RFC 3164 and RFC 5424 format messages.

## Minimal configuration

```
logging host <hub-ip>
logging trap informational
logging on
```

## Recommended configuration

```
service timestamps log datetime msec localtime show-timezone
logging buffered 16384 informational
logging host <hub-ip> transport udp port 514
logging trap informational
logging facility local7
logging on
```

### Key options

- `service timestamps log datetime msec localtime` — include millisecond timestamps so the collector can accurately order events
- `logging trap informational` — sends severity 6 and above; use `debugging` only if needed (very noisy)
- `logging facility local7` — sets the syslog facility; any facility is accepted by the collector

## Send over TCP (more reliable)

```
logging host <hub-ip> transport tcp port 514
```

TCP delivery ensures messages are not dropped under load. Most IOS-XE versions support this.

## Verify

```
show logging
```

Look for the hub IP in the list of syslog hosts and confirm messages are being sent:

```
Trap logging: level informational, 1234 message lines logged
    Logging to <hub-ip>  (udp port 514, ...)
```

## Source interface

Bind syslog to a specific interface so the source IP matches the device's management IP in the system:

```
logging source-interface Loopback0
```

or

```
logging source-interface GigabitEthernet0/0
```
