# Device Onboarding Workflow

End-to-end steps for bringing a new device into monitoring.

## 1. Add the device

Go to **Devices** → **Add Device** and fill in:

- **Hostname** — display name in the UI
- **Management IP** — the IP the collectors will use to reach the device
- **Device type** — router, switch, firewall, etc.
- **Vendor** — used to apply vendor-specific SNMP OID mappings

## 2. Link a credential

On the device detail page, click the **gear icon** to open **Device Settings** → scroll to the **Credentials** section → **Link Credential**.

Select an existing credential or create a new one first under **Credentials** in the sidebar (Admin section). Set **priority 1** for the primary credential. See [Configuring SNMP Credentials](snmp-credentials) for details.

## 3. Run SNMP diagnostics

In the Device Settings drawer, scroll to **SNMP Diagnostic** and click **Run**. This performs a live test walk and confirms:

- Which credential is being used
- Response time in milliseconds
- Sample OID values (sysDescr, sysUpTime, ifNumber)

If this fails, see [SNMP Collection Failures](troubleshoot-snmp-failures).

## 4. Assign to a collector (if needed)

By default the device is polled by the hub SNMP collector. If the device is at a remote site, set the **Collector** in the Device Settings drawer to assign it to a remote collector. See [Assigning Devices to Remote Collectors](collector-device-assignment).

## 5. Verify metrics are flowing

After the first poll cycle (up to 60 seconds), check:

- **Health tab** — CPU, memory, uptime should appear
- **Interfaces tab** — interface list with status and speed

If data is absent after 2 minutes, see [No Metrics or Stale Data](troubleshoot-no-metrics).

## 6. Configure syslog and flow (optional)

For full visibility, configure the device to send:

- **Syslog** to the hub on UDP/TCP 514 — see the Syslog Setup articles for your vendor
- **Flow** (NetFlow / sFlow) to the hub on UDP 2055 or 6343 — see the Flow Setup articles for your vendor

## 7. Create alert rules

Go to **Alert Rules** and create rules for this device or apply existing rules globally. See [Creating Alert Rules](alert-rules).
