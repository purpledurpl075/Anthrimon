# Flow Export — Juniper JunOS

The flow collector listens on **UDP port 2055** for IPFIX / NetFlow v9.

## Inline active flow monitoring (MX / PTX)

### Configure the flow server

```
set services flow-monitoring version-ipfix template ipv4 template-id 100
set services flow-monitoring version-ipfix template ipv4 flow-active-timeout 60
set services flow-monitoring version-ipfix template ipv4 flow-inactive-timeout 15
set services flow-monitoring version-ipfix template ipv4 template-refresh-rate packets 50

set forwarding-options flow-server <hub-ip> port 2055
set forwarding-options flow-server <hub-ip> autonomous-system-type origin
set forwarding-options flow-server <hub-ip> version-ipfix template ipv4

set forwarding-options monitoring-instance default-instance
```

### Apply to interfaces

```
set interfaces ge-0/0/0 unit 0 family inet sampling input
set interfaces ge-0/0/0 unit 0 family inet sampling output
```

### Enable sampling globally

```
set forwarding-options sampling input rate 1000
set forwarding-options sampling family inet output flow-server <hub-ip>
set forwarding-options sampling family inet output version-ipfix
```

## J-Flow (EX / SRX / QFX)

```
set forwarding-options sampling input rate 1000
set forwarding-options sampling family inet output flow-server <hub-ip> port 2055
set forwarding-options sampling family inet output version 9
set forwarding-options sampling family inet output source-address <lo0-ip>
```

Apply per interface:

```
set interfaces ge-0/0/1 unit 0 family inet sampling input
set interfaces ge-0/0/1 unit 0 family inet sampling output
```

## Verify

```
show services flow-monitoring
show interfaces ge-0/0/0 statistics detail | match "sampl"
```
