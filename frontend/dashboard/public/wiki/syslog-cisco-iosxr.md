# Syslog — Cisco IOS-XR

The syslog collector listens on **UDP and TCP port 514**.

## Configuration

```
logging <hub-ip>
logging facility local7
logging hostnameprefix <hostname>
```

## Recommended — with VRF

If your management interface is in a VRF:

```
logging vrf management <hub-ip>
logging facility local7
```

## Set severity level

```
logging trap informational
```

## Timestamp format

```
service timestamps log datetime msec
```

## Verify

```
show logging
```

Check that the remote host appears and message count is incrementing.

## Source interface

```
logging source-interface MgmtEth0/RP0/CPU0/0
```
