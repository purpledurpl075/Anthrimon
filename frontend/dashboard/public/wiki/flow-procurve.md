# Flow Export — HP ProCurve / Aruba CX (sFlow)

The flow collector listens on **UDP port 6343** for sFlow v5.

ProCurve and Aruba CX switches use **sFlow**.

## ProCurve (older firmware)

```
sflow 1 destination <hub-ip>
sflow 1 sampling all 1024
sflow 1 polling all 30
```

- `sampling all 1024` — 1:1024 sampling on all ports
- `polling all 30` — counter polling interval in seconds

### Per-port sampling

```
sflow 1 sampling e1 512
```

### Verify

```
show sflow 1
show sflow 1 statistics
```

## Aruba CX (ArubaOS-CX)

```
sflow agent-ip <mgmt-ip>
sflow collector <hub-ip> port 6343

interface 1/1/1
    sflow enable
    sflow sample-rate 1024
    sflow polling-interval 30
```

### Enable globally on all interfaces

```
sflow enable
```

### Verify

```
show sflow
show sflow statistics
```

## Notes

- sFlow is a sampling protocol — suitable for traffic trending and bandwidth alerts, not exact byte accounting
- The **agent IP** must match the device's management IP registered in the system. Set it explicitly to avoid mismatches when multiple interfaces are present
