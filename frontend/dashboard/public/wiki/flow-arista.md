# Flow Export — Arista EOS (sFlow)

The flow collector listens on **UDP port 6343** for sFlow v5.

Arista EOS uses **sFlow** rather than NetFlow/IPFIX.

## Configuration

```
sflow run
sflow sample 1024
sflow polling-interval 30
sflow destination <hub-ip>
sflow source-interface Management1
```

### Key parameters

- `sample 1024` — sample 1 in every 1024 packets. Lower values increase accuracy but add CPU load. Typical range: 256–4096 depending on link speed.
- `polling-interval 30` — send interface counter updates every 30 seconds.

## Per-interface sFlow (optional)

Override the global sample rate on specific interfaces:

```
interface Ethernet1
   sflow sample 512
```

Disable sFlow on an interface:

```
interface Management1
   no sflow enable
```

## Verify

```
show sflow
show sflow detail
```

Expected output shows the destination IP, sample rate, and datagram counters incrementing.

## Notes

- sFlow is a sampling protocol — not every packet is captured. It is suitable for traffic visibility and bandwidth trending, not exact accounting.
- The sFlow agent IP is set automatically from the `source-interface`. Ensure this matches the device's management IP in the system.
