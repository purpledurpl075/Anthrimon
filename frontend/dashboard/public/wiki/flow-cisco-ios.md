# Flow Export — Cisco IOS / IOS-XE

The flow collector listens on **UDP port 2055** for NetFlow v5, v9, and IPFIX.

## NetFlow v9 (recommended)

### Define the exporter

```
flow exporter ANTHRIMON
 destination <hub-ip>
 source GigabitEthernet0/0
 transport udp 2055
 export-protocol netflow-ipv4-version9
 template data timeout 60
```

### Define a flow record (optional — uses default if omitted)

```
flow record ANTHRIMON-RECORD
 match ipv4 source address
 match ipv4 destination address
 match transport source-port
 match transport destination-port
 match ip protocol
 match interface input
 collect counter bytes
 collect counter packets
 collect timestamp sys-uptime first
 collect timestamp sys-uptime last
```

### Define a flow monitor

```
flow monitor ANTHRIMON-MONITOR
 exporter ANTHRIMON
 record ANTHRIMON-RECORD
 cache timeout active 60
 cache timeout inactive 15
```

### Apply to interfaces

Apply to each interface that carries traffic you want to monitor, in both directions:

```
interface GigabitEthernet0/1
 ip flow monitor ANTHRIMON-MONITOR input
 ip flow monitor ANTHRIMON-MONITOR output
```

## NetFlow v5 (legacy, simpler)

```
ip flow-export destination <hub-ip> 2055
ip flow-export version 5
ip flow-export source GigabitEthernet0/0
ip flow-cache timeout active 1
ip flow-cache timeout inactive 15
```

Apply on each interface:

```
interface GigabitEthernet0/1
 ip route-cache flow
```

## Verify

```
show flow monitor ANTHRIMON-MONITOR cache
show flow exporter ANTHRIMON statistics
```

For v5:

```
show ip flow export
show ip cache flow
```
