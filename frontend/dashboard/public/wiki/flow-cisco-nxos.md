# Flow Export — Cisco NX-OS

The flow collector listens on **UDP port 2055** for NetFlow v9 and IPFIX.

## Configuration

### Create the exporter

```
feature netflow

flow exporter ANTHRIMON
  destination <hub-ip> use-vrf management
  source mgmt0
  transport udp 2055
  version 9
    template data timeout 60
```

### Create the flow record

```
flow record ANTHRIMON-RECORD
  match ipv4 source address
  match ipv4 destination address
  match transport source-port
  match transport destination-port
  match ip protocol
  collect counter bytes
  collect counter packets
  collect timestamp sys-uptime first
  collect timestamp sys-uptime last
```

### Create the flow monitor

```
flow monitor ANTHRIMON-MONITOR
  exporter ANTHRIMON
  record ANTHRIMON-RECORD
  cache timeout active 60
  cache timeout inactive 15
```

### Apply to interfaces

```
interface Ethernet1/1
  ip flow monitor ANTHRIMON-MONITOR input
  ip flow monitor ANTHRIMON-MONITOR output
```

## Verify

```
show flow exporter ANTHRIMON
show flow monitor ANTHRIMON-MONITOR
show flow monitor ANTHRIMON-MONITOR cache
```
