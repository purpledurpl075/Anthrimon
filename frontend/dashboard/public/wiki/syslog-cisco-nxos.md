# Syslog — Cisco NX-OS

The syslog collector listens on **UDP and TCP port 514**.

## Configuration

```
logging server <hub-ip> 6 use-vrf management facility local7
logging timestamp milliseconds
logging level all 5
```

- Severity `6` = informational; `5` = notifications; `3` = errors
- `use-vrf management` — required when the management interface is in the mgmt VRF

## Send over TCP

```
logging server <hub-ip> 6 use-vrf management facility local7 transport tcp port 514
```

## Source interface

```
logging source-interface mgmt0
```

## Verify

```
show logging server
```

## NX-OS logging levels reference

| Level | Name | Meaning |
|-------|------|---------|
| 0 | Emergency | System unusable |
| 1 | Alert | Immediate action needed |
| 2 | Critical | Critical conditions |
| 3 | Error | Error conditions |
| 4 | Warning | Warning conditions |
| 5 | Notification | Normal but significant |
| 6 | Informational | Informational only |
| 7 | Debugging | Debug messages |
