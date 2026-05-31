# Alert Exclusions

Alert exclusions permanently suppress a specific metric for a specific device or interface, without modifying or deleting the alert rule.

Use exclusions when a rule applies broadly across all devices but one particular device should never fire it — for example, a legacy device that always has high CPU, or a known-down interface that you do not want to alert on.

## Adding an exclusion

1. Go to the device detail page
2. Click **Alert Exclusions** (in the Settings or Actions area)
3. Select the **metric** to suppress (e.g. `cpu_util_pct`, `interface_down`)
4. Optionally select a specific **interface** (for interface-scoped metrics)
5. Save

The exclusion takes effect on the next alert engine cycle (~15 seconds).

## Removing an exclusion

Go to **Alert Exclusions** on the device and delete the relevant entry. Alerts for that metric will resume on the next evaluation.

## Exclusions vs maintenance windows

| | Exclusion | Maintenance Window |
|--|-----------|-------------------|
| Duration | Permanent | Time-bounded |
| Scope | One metric (optionally one interface) | All metrics on selected devices |
| Use case | Permanently noisy device/interface | Planned maintenance |

## Exclusions vs baseline suppression

If an alert fires because the baseline threshold is too sensitive, consider adjusting the baseline override instead of creating an exclusion. Go to the device's **Health** tab → **Baselines** → **Override** to force-suppress or force-alert a specific metric.
