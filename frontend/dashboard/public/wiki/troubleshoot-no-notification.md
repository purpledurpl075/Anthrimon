# Alert Fired But No Notification Sent

## 1. Check the alert has a policy assigned

Go to **Alert Rules** and open the rule. Confirm a **Policy** is set. Rules without a policy generate alerts in the UI but never send notifications.

## 2. Check the policy has channels

Go to **Policies** and open the policy linked to the rule. Confirm at least one **Notification Channel** is assigned.

## 3. Test the channel directly

Go to **Administration** (under Admin in the sidebar) → **Channels** tab, find the channel, and click **Test**. If the test fails:

- **Email**: check SMTP settings under **Administration** → **SMTP Server** tab. Verify host, port, and credentials. Check for firewall blocks on outbound SMTP.
- **Slack**: the webhook URL may have been revoked. Regenerate it in the Slack workspace.
- **PagerDuty**: verify the integration key is correct and the service is active.
- **Webhook**: confirm the endpoint is reachable from the hub server. Test manually with `curl -X POST <url>`.

## 4. Check the API logs for notification errors

```bash
journalctl -u anthrimon-api -n 100 --no-pager | grep -i "notify\|smtp\|channel\|email"
```

Common log events:
- `notify_smtp_not_configured` — SMTP has not been set up
- `notify_sent` — notification was delivered successfully
- `notify_slack_no_webhook` — Slack channel has no webhook URL configured
- `notify_pagerduty_no_key` — PagerDuty channel has no integration key

## 5. Re-notify interval

If the alert was already open and a re-notification is expected, check the policy's **Re-notify interval**. If set to 0, only the initial open notification is sent. If set to 3600, the next reminder won't fire until an hour after the first.

## 6. Alert is in acknowledged state

Acknowledged alerts suppress re-notifications until they resolve or the acknowledgement expires. Check the alert status on the **Alerts** page.
