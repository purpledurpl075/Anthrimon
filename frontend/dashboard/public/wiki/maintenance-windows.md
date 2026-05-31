# Maintenance Windows

Maintenance windows suppress all alert notifications for a device during planned changes. Alerts are still recorded in the UI but no notifications are sent.

Go to **Maintenance** to manage windows.

## Creating a window

| Field | Description |
|-------|-------------|
| Name | Description of the maintenance (e.g. "Firmware upgrade core-sw-01") |
| Devices | One or more devices to suppress |
| Start / End | Date and time in your local timezone |
| Recurring | Repeat the window on a schedule (e.g. every Sunday 02:00–04:00) |

## One-time windows

Use for planned upgrades, cabling work, or any change with a specific time window. The window activates at `start` and deactivates at `end`. All alert rules are suppressed for the selected devices while active.

## Recurring windows

Use for scheduled maintenance tasks that run on a regular basis:

- Recurring basis: **daily**, **weekly**, or **monthly**
- Specify start time and duration
- Common use: nightly backup jobs that cause brief SNMP timeouts, weekly patch windows

## Best practice

Create the maintenance window **before** starting work, not after. If you start work without a window and alerts fire, acknowledge them manually to stop re-notifications, then create the window to suppress further noise.

## Verify a window is active

Go to **Maintenance** and check the window shows status **Active**. You can also confirm via the device detail page — an active window banner will appear at the top.

## Ending a window early

Click **End Now** on the window. Alert evaluation resumes immediately on the next engine cycle (~15 seconds).
