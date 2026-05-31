# Credential Types Reference

Credentials are managed under **Credentials** in the sidebar and linked to devices with a priority order.

## Types

### `snmp_v2c`

SNMPv2c community-string credential.

| Field | Description |
|-------|-------------|
| Community | The SNMP community string (e.g. `public`) |

Used for: SNMP polling, health metrics, interface data, BGP, routing table collection.

---

### `snmp_v3`

SNMPv3 with authentication and privacy.

| Field | Description |
|-------|-------------|
| Username | SNMPv3 security name |
| Auth protocol | `MD5` or `SHA` |
| Auth password | Authentication password |
| Privacy protocol | `DES`, `AES128`, `AES256` |
| Privacy password | Encryption password |
| Security level | `noAuthNoPriv`, `authNoPriv`, `authPriv` |

Used for: same as `snmp_v2c` but with encrypted transport. Preferred over v2c.

---

### `ssh`

SSH username/password or private key.

| Field | Description |
|-------|-------------|
| Username | SSH login username |
| Password | SSH password (or leave blank if using a key) |
| Private key | PEM-format SSH private key (optional) |

Used for: config collection (show running-config), ProCurve collection via invoke_shell.

---

### `api_token`

Generic API token / bearer token.

| Field | Description |
|-------|-------------|
| Token | The API token or bearer token value |

Used for: Aruba CX REST API config collection.

---

### `eapi`

Arista eAPI username and password (HTTP/HTTPS JSON-RPC).

| Field | Description |
|-------|-------------|
| Username | eAPI login username |
| Password | eAPI login password |
| Allow HTTP | Enable HTTP fallback (HTTPS preferred) |

Used for: Arista EOS — richer BGP, IS-IS, LLDP, and interface data beyond what SNMP provides.

---

### `gnmi_tls`

gNMI (gRPC Network Management Interface) with TLS.

| Field | Description |
|-------|-------------|
| Username | gNMI username |
| Password | gNMI password |
| CA cert | PEM CA certificate for TLS validation |

Used for: gNMI-capable devices (future use; not all collection paths implemented yet).

---

### `netconf`

NETCONF over SSH.

| Field | Description |
|-------|-------------|
| Username | NETCONF username |
| Password | NETCONF password |

Used for: NETCONF-capable devices (future use).

---

## Credential priority

When multiple credentials of the same type are linked to a device, the collector tries them in ascending priority order (1 = highest priority, tried first). The first credential that succeeds is used for the poll; others are not tried unless the first fails.

**Best practice**: set priority 1 for the current production credential, and use priority 10+ for fallback or legacy credentials. Remove credentials that are no longer valid to eliminate unnecessary timeout delays.
