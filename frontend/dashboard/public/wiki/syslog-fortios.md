# Syslog — Fortinet FortiOS

The syslog collector listens on **UDP and TCP port 514**.

## Configuration via CLI

```
config log syslogd setting
    set status enable
    set server <hub-ip>
    set port 514
    set facility local7
    set format default
end
```

## Set severity

```
config log syslogd filter
    set severity information
end
```

## Send over TCP (reliable delivery)

```
config log syslogd setting
    set status enable
    set server <hub-ip>
    set port 514
    set mode reliable
end
```

`mode reliable` uses TCP with guaranteed delivery.

## Source interface / VRF

```
config log syslogd setting
    set interface-select-method specify
    set interface <mgmt-interface>
end
```

## Multiple syslog servers

FortiOS supports up to four syslog destinations using `syslogd`, `syslogd2`, `syslogd3`, `syslogd4`.

## Verify

```
diagnose log test
diagnose test application syslogd 99
```

Check the hub is receiving traffic:

```bash
journalctl -u syslog-collector -f | grep <fortigate-ip>
```
