# Assigning Devices to Remote Collectors

By default all devices are polled by the **hub SNMP collector**. Devices at remote sites should be assigned to a **remote collector** co-located at that site to avoid SNMP traffic traversing the WAN.

## Assign a device to a remote collector

1. Go to the device detail page
2. Click the **gear icon** to open **Device Settings**
3. In the **Collector** section, select the desired remote collector
4. Save

The remote collector pulls its device list from the hub on a 30-second refresh. The device will be picked up within the next refresh cycle.

## Move a device back to the hub collector

Set **Collector** to **Hub** (or leave it blank). The hub collector will resume polling on its next device refresh.

## Bulk assignment

To assign many devices to a remote collector at once, use the device list page. Select multiple devices and use **Bulk Edit** → **Assign Collector**.

## What the remote collector does

A remote collector assigned a device will:

- Poll SNMP at the configured interval
- Run ICMP ping probes every 30 seconds (if CAP_NET_RAW is available)
- Push metrics to the hub API over WireGuard
- Pull config (SSH/eAPI) if SSH credentials are linked

The hub collector stops polling a device as soon as it is assigned to a remote collector.

## Verifying the assignment is working

After assignment, check the device's **Health** tab. Within 60 seconds metrics should appear from the remote collector. The collector column on the device list also shows which collector last polled the device.

If metrics stop after reassignment, check the remote collector is online on the **Collectors** page. See [Remote Collector Offline](troubleshoot-remote-collector-offline) if it shows as offline.
