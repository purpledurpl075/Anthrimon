# Syslog — Arista EOS

The syslog collector listens on **UDP and TCP port 514**.

## Configuration

```
logging on
logging host <hub-ip>
logging trap informational
```

## Recommended — with source interface and timestamp

```
logging on
logging host <hub-ip>
logging trap informational
logging format timestamp traditional
logging source-interface Management1
```

## Send over TCP

```
logging host <hub-ip> protocol tcp
```

## VRF-aware management

If the management interface is in the `management` VRF (default on most Arista platforms):

```
logging vrf management host <hub-ip>
logging vrf management trap informational
logging vrf management source-interface Management1
```

## Facility

```
logging facility local7
```

## Verify

```
show logging
```

Look for the remote host and confirm messages are being forwarded.
