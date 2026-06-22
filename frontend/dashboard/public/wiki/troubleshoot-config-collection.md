# Config Collection Failing

## 1. Check the API logs

```bash
journalctl -u anthrimon-api -n 100 --no-pager | grep -i "config\|ssh\|collect\|backup"
```

## 2. Verify an SSH credential is linked

On the device detail page, click the **gear icon** to open **Device Settings** → scroll to the **Credentials** section. Confirm an SSH credential is linked. Without one, config collection is skipped silently.

## 3. Test SSH connectivity manually

From the hub server:

```bash
ssh <username>@<device-ip>
```

If this fails, the problem is network connectivity or credentials — not an Anthrimon issue.

## 4. Common SSH errors

### Authentication failed
The username or password in the SSH credential is wrong. Update the credential and re-link it to the device.

### Connection timeout
The device is not accepting SSH from the hub IP. Check:
- SSH is enabled on the device (`ip ssh version 2` on Cisco IOS)
- The hub IP is permitted in the device's SSH access list
- No firewall between the hub and device on TCP 22

### Host key verification
The device's SSH host key may have changed (after a reimage or reset). Remove the old key from known hosts on the hub:

```bash
ssh-keygen -R <device-ip>
```

## 5. ProCurve / Aruba interactive shell issues

ProCurve switches require an interactive shell session rather than a direct exec command. The collector uses paramiko `invoke_shell` for these devices. If collection times out:

- Ensure the SSH user has `operator` or `manager` level privilege
- Some ProCurve firmware versions add a press-any-key prompt on login — this can cause timeouts. Disable the banner:

```
no banner motd
```

- If the switch outputs a `Press any key to continue` prompt, collection will stall. Disable it via the console before SSH-based collection will work.

## 6. Aruba CX — REST API

Aruba CX collection uses the REST API, not SSH. Ensure:
- An `api_token` credential is linked to the device
- The Aruba CX REST API is enabled: `https-server rest access-mode read-only`
- The hub IP can reach HTTPS on the device

## 7. Collection interval

Config collection runs every **1 hour** by default. If you just linked a credential, wait up to an hour or trigger manually via the device's Config tab → **Collect Now**.
