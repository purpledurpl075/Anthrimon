# Alert Exclusions

Alert exclusions permanently suppress a specific metric for a specific device or interface, without modifying or deleting the alert rule.

Use exclusions when a rule applies broadly across all devices but one particular device should never fire it — for example, a legacy device that always has high CPU, or a known-down interface that you do not want to alert on.

## Adding an exclusion

1. Go to the device detail page
2. Click the **gear icon** to open **Device Settings**
3. Scroll to the **Alert ignores** section
4. Check the **metric** to suppress (e.g. `cpu_util_pct`, `device_down`, `temperature`)
5. For interface-down alerts, check specific **interfaces** to ignore
6. Click **Save ignores**

The exclusion takes effect on the next alert engine cycle (~15 seconds).

## Removing an exclusion

Open the Device Settings drawer → **Alert ignores** section, uncheck the metric or interface, and click **Save ignores**. Alerts for that metric will resume on the next evaluation.

## Exclusions vs maintenance windows

| | Exclusion | Maintenance Window |
|--|-----------|-------------------|
| Duration | Permanent | Time-bounded |
| Scope | One metric (optionally one interface) | All metrics on selected devices |
| Use case | Permanently noisy device/interface | Planned maintenance |

## Exclusions vs baseline suppression

If an alert fires because the baseline threshold is too sensitive, consider adjusting the baseline override instead of creating an exclusion. Go to the device's **Health** tab → **Baselines** → **Override** to force-suppress or force-alert a specific metric.
