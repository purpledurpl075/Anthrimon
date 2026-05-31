# Alert Policies

Policies control **who gets notified**, **how often**, and **how alerts escalate**.

Go to **Policies** to manage them.

## Policy fields

| Field | Description |
|-------|-------------|
| Name | Display name |
| Channels | One or more notification channels to notify on alert open and resolve |
| Re-notify interval | How often to re-send the notification while the alert remains open (default: 3600s / 1 hour). Set to 0 to notify once only. |
| Escalation severity | If the alert is still open after `escalation_seconds`, bump it to this severity |
| Escalation delay | Seconds before escalation triggers (e.g. 1800 = escalate after 30 minutes unacknowledged) |

## Typical setup

### Simple — alert once

| Setting | Value |
|---------|-------|
| Channels | `#alerts` Slack channel |
| Re-notify | 0 (notify once) |
| Escalation | — |

### On-call with escalation

| Setting | Value |
|---------|-------|
| Channels | `#network-alerts` Slack |
| Re-notify | 3600 (remind hourly) |
| Escalation severity | `critical` |
| Escalation delay | 1800 (30 min) |

On-call rotation: assign a second channel (e.g. PagerDuty) and put it in the same policy. PagerDuty will manage the on-call schedule and paging.

## Linking a policy to a rule

On the **Alert Rules** page, each rule has a **Policy** field. A rule with no policy will still generate alerts in the UI but will not send any notifications.

## Resolution notifications

When an alert clears (the condition is no longer met), a resolution notification is sent to the same channels as the open notification. This can be disabled per-channel if needed.
