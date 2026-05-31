# Configuring SNMP Credentials

## Adding a credential

Go to **Credentials** and click **Add Credential**. Choose the SNMP version:

### SNMPv2c
- **Community string** — typically `public` (read-only) or a custom string

### SNMPv3
- **Username** — the security name configured on the device
- **Auth protocol** — MD5 or SHA
- **Auth password**
- **Privacy protocol** — DES or AES
- **Privacy password**
- **Security level** — `noAuthNoPriv`, `authNoPriv`, or `authPriv`

## Linking credentials to a device

1. Open the device detail page
2. Go to the **Credentials** tab
3. Click **Link Credential** and select from the list
4. Set **priority** — lower number = tried first (1 = highest priority)

The SNMP collector tries credentials in priority order and uses the first one that responds.

## Testing credentials

Use the **SNMP Diagnostics** button on the device's Credentials tab. This runs a live SNMP walk against the device and shows response time and sample OID values.

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
