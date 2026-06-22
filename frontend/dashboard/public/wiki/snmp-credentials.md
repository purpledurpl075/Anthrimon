# Configuring SNMP Credentials

## Adding a credential

Go to **Credentials** and click **Add Credential**. Choose the SNMP version:

### SNMPv2c
- **Community string** — typically `public` (read-only) or a custom string

### SNMPv3
- **Username** — the security name configured on the device
- **Auth protocol** — SHA or SHA-256 (MD5 is accepted but not recommended)
- **Auth password**
- **Privacy protocol** — AES (DES is accepted but not recommended)
- **Privacy password**
- **Security level** — `noAuthNoPriv`, `authNoPriv`, or `authPriv`

## Linking credentials to a device

1. Open the device detail page
2. Click the **gear icon** to open the **Device Settings** drawer
3. Scroll to the **Credentials** section and click **Link Credential**
4. Select from the list and set **priority** — lower number = tried first (1 = highest priority)

The SNMP collector tries credentials in priority order and uses the first one that responds.

## SNMPv3 and SNMP traps

When a device has SNMPv3 credentials linked, the hub automatically pushes those credentials to any remote collector responsible for that device's site. The remote collector's `snmptrapd` is reconfigured with the v3 user keys so that authenticated traps (`authPriv`) from the device are accepted and forwarded to the hub.

This means: saving a v3 credential and linking it to a device is all you need to do — trap auth is configured automatically.

## Testing credentials

In the Device Settings drawer, scroll to the **SNMP Diagnostic** section and click **Run**. This performs a live SNMP walk against the device and shows response time and sample OID values.

## ProCurve / HP switches

ProCurve switches sometimes require the community string to be set explicitly on each VLAN interface. If SNMP walks return no data, check:

```
show snmp-server
```

on the switch to confirm the community and access list.

## Credential priority recommendations

| Priority | Use |
|----------|-----|
| 1 | Primary production community / v3 user |
| 10 | Fallback / secondary community |
| 99 | Legacy or deprecated credentials |
