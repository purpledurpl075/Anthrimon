# Flow Export — Fortinet FortiOS

The flow collector listens on **UDP port 2055** for NetFlow v9.

## Configuration via CLI

```
config system netflow
    set collector-ip <hub-ip>
    set collector-port 2055
    set source-ip <mgmt-ip>
    set active-flow-timeout 60
    set inactive-flow-timeout 15
end
```

## Enable on interfaces

NetFlow export on FortiOS requires policy-based traffic — flows are automatically exported for traffic matching firewall policies. No per-interface configuration is required.

## Verify

```
get system netflow
diagnose ip flow list
```

## Notes

- FortiOS exports NetFlow for routed/NAT traffic passing through the firewall
- The source IP should match the device's management IP registered in the system
- FortiGate VDOMs each need their own netflow configuration if in multi-VDOM mode

## Multi-VDOM

```
config vdom
    edit <vdom-name>
    config system netflow
        set collector-ip <hub-ip>
        set collector-port 2055
    end
    next
end
```
