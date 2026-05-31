# Syslog — Juniper JunOS

The syslog collector listens on **UDP and TCP port 514**.

## Configuration

```
set system syslog host <hub-ip> any info
set system syslog host <hub-ip> explicit-priority
set system syslog host <hub-ip> facility-override local7
set system syslog time-format millisecond
```

- `any info` — all facilities at informational level and above
- `explicit-priority` — includes the priority value in the syslog header (RFC 3164 compatible)
- `facility-override local7` — normalises the facility; accepted by the collector

## Send over TCP

```
set system syslog host <hub-ip> any info
set system syslog host <hub-ip> log-prefix <hostname>
set system syslog host <hub-ip> transport tcp port 514
```

## Source address

Bind to the loopback or management interface:

```
set system syslog host <hub-ip> source-address <lo0-ip>
```

## Routing instance (management VRF)

If using a management routing instance:

```
set system syslog host <hub-ip> routing-instance mgmt_junos
```

## Verify

```
show system syslog
```

Send a test message:

```
request system syslog test-message
```
