# Advanced Reports

Scheduled or on-demand branded PDF/CSV reports, drawing on the same data as the rest of the platform. Go to **Reports** in the sidebar. This is a licensed add-on module — see [Licensing](licensing).

## Report types

| Type | What it covers |
|------|-----------------|
| Capacity & Utilisation | Avg/peak interface utilisation and CPU per device |
| SLA / Uptime | Per-device downtime and uptime %, from device-down alert history |
| Inventory | Full device inventory snapshot (no date range — always current) |
| Config Compliance | Pass/fail summary by policy, latest per-device result |
| Alert Summary / MTTR | Alert counts and mean-time-to-ack/resolve by severity, noisiest devices |
| Config Change History | Config diffs with who deployed them (or "periodic poll") |
| Top Talkers / Flow | Top bandwidth consumers by source/destination/protocol |
| Interface Errors / Health | Interface errors, discards, and link-state flaps |
| BGP / Routing Health | Session state, flap counts, prefix counts |
| Syslog / Security Events | Severity trend plus match counts for your syslog-match alert rules |
| Bundle | Combine any of the above into one PDF/CSV, one section per type |

## Running a report on demand

1. Go to **Reports** → **Run a report now**
2. Pick a type, format (PDF or CSV), and optionally a date range and site
3. Click **Preview** to render it in a modal without saving anything — good for checking filters before committing to a schedule
4. Click **Run now**, then find it under **Recent runs** once it finishes

## Scheduling a recurring report

1. **Reports** → **New schedule**
2. Pick a type, format(s), date range/site/comparison filters, and a cron expression for how often it runs
3. Add email recipients, and optionally a custom subject/intro note
4. Save — an existing schedule can be edited later (Edit button on the schedule row), including all of the above

## Comparing to a previous period

For the 8 metric-heavy report types (everything except Inventory and Syslog/Security), check **Compare to previous period** when running or scheduling a report. This adds a delta table against the immediately preceding period of the same length — e.g. a 30-day capacity report also shows how CPU/bandwidth changed vs. the 30 days before that.

## Branding

**Platform Admin** → **Report Branding** sets a company name and logo for the PDF header/footer. Defaults to Anthrimon's own logo until you set your own.

## If a scheduled report keeps failing

After 3 consecutive failures (each retried automatically first), a notification fires through the normal alerting system — create an alert rule with metric **Scheduled report failure** and attach whichever notification channels you want to hear about it.

## Retention

Saved report files and history are pruned automatically after a configurable number of days (**Platform Admin** → data retention settings, default 90). Delete any individual saved report early from the Reports page.
