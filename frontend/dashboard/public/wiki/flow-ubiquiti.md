# Flow Export — Ubiquiti

The flow collector listens on **UDP port 2055** for NetFlow v9 and **UDP port 6343** for sFlow v5.

## UniFi (via UniFi Network Application)

Go to **Settings** → **Site** → **NetFlow** and enter the hub IP and port 2055. Enable **NetFlow**.

This applies to all UniFi gateways (UDM, UDM-Pro, USG).

## EdgeOS (EdgeRouter) — NetFlow v9

```
set system flow-accounting interface eth0
set system flow-accounting netflow server <hub-ip> port 2055
set system flow-accounting netflow version 9
set system flow-accounting netflow timeout expiry-interval 60
set system flow-accounting netflow timeout flow-generic 60
set system flow-accounting netflow timeout max-active-life 600
commit
save
```

Replace `eth0` with the interface(s) you want to monitor. Add multiple interfaces:

```
set system flow-accounting interface eth1
set system flow-accounting interface eth2
```

## EdgeOS — Verify

```
show flow-accounting interface eth0
show flow-accounting
```

## Notes

- UniFi NetFlow exports v5-compatible records — the collector handles these correctly
- EdgeOS supports per-interface flow accounting; only add interfaces that carry relevant traffic
- The source IP is the router's outbound interface — confirm it matches the management IP in the system
