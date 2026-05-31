# Notification Channels

Notification channels define where alerts are sent. Channels are assigned to **Policies**, which are then linked to alert rules.

Go to **Alert Rules** → **Channels** to manage channels.

---

## Email

Requires SMTP to be configured first under **Administration** → **SMTP Settings**.

### SMTP settings (one-time setup)

| Field | Description |
|-------|-------------|
| Host | SMTP server hostname (e.g. `smtp.gmail.com`) |
| Port | Usually `587` (STARTTLS) or `465` (SSL) |
| User | SMTP login username |
| Password | SMTP login password (stored encrypted) |
| From address | The `From:` address on outgoing emails |
| SSL | Enable for port 465; leave off for 587 (STARTTLS used automatically) |

### Channel config

When adding an email channel, set **To** to a comma-separated list of recipient addresses. One channel per team or escalation group is typical.

---

## Slack

Uses a Slack **Incoming Webhook**.

1. In Slack: **Apps** → **Incoming Webhooks** → **Add to Slack** → choose a channel → **Add Incoming Webhooks Integration**
2. Copy the webhook URL (starts with `https://hooks.slack.com/services/...`)
3. In Anthrimon: add a Slack channel and paste the URL

Alerts appear as a formatted message in the chosen Slack channel with severity, device name, and a link to the alert.

---

## Microsoft Teams

Uses a Teams **Incoming Webhook connector**.

1. In Teams: open the channel → **…** → **Connectors** → **Incoming Webhook** → **Configure**
2. Give it a name, copy the webhook URL
3. In Anthrimon: add a Teams channel and paste the URL

---

## PagerDuty

Uses a PagerDuty **Events API v2** integration key.

1. In PagerDuty: **Services** → select or create a service → **Integrations** → **Add Integration** → **Events API v2**
2. Copy the **Integration Key**
3. In Anthrimon: add a PagerDuty channel and paste the integration key

Alerts fire PagerDuty incidents on open and resolve them automatically when the alert clears.

---

## Webhook (generic)

Posts a JSON payload to any HTTP/HTTPS endpoint via POST.

| Field | Description |
|-------|-------------|
| URL | The endpoint to POST to |

### Payload format

```json
{
  "alert_id": "uuid",
  "status": "open",
  "severity": "critical",
  "metric": "device_down",
  "device_id": "uuid",
  "device_name": "core-sw-01",
  "message": "Device core-sw-01 is unreachable",
  "fired_at": "2026-05-30T04:26:00Z",
  "alert_url": "https://<hub>/alerts/<id>"
}
```

`status` is `"open"` when the alert fires and `"resolved"` when it clears.

---

## Testing a channel

Use the **Test** button on any channel to send a test notification. For email this sends a test message to all recipients. This is the fastest way to verify credentials and connectivity.
