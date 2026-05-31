# Syslog — HP ProCurve / Aruba

The syslog collector listens on **UDP port 514**. ProCurve switches support UDP syslog only (no TCP).

## ProCurve (older firmware)

```
logging <hub-ip>
logging severity informational
```

## Aruba / HPE switches (newer firmware)

```
logging <hub-ip>
logging facility local7
logging severity informational
```

## Verify

```
show logging
```

The remote host and send count will be listed.

## Notes

- ProCurve switches use RFC 3164 format with no millisecond timestamps — the collector handles this correctly
- The source IP will be the outbound interface toward the hub; ensure this matches the device's management IP registered in the system, or update the mgmt IP on the device to match
- Some older ProCurve firmware only supports a single syslog destination
