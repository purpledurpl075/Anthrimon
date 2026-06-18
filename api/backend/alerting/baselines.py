"""Baseline computation background task.

Runs hourly.  Queries VictoriaMetrics and ClickHouse for rolling statistics
over the past 14 days and upserts results into the metric_baselines table.

These baselines are consumed by the alert evaluators to:
  - Suppress interface_down alerts on ports that are chronically down.
  - Raise anomaly alerts when numeric metrics (CPU, errors, DOM) deviate
    significantly from their learned normal range.
"""
from __future__ import annotations

import asyncio
import math
from datetime import datetime, timezone
from typing import Optional

import httpx
import structlog
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import AsyncSessionLocal
from ..services.urls import ch_url, vm_url

logger = structlog.get_logger(__name__)
_WINDOW  = "14d"        # rolling baseline window
_STEP    = "5m"         # subquery step (resolution)
_WINDOW_DAYS = 14


# ── VictoriaMetrics helpers ───────────────────────────────────────────────────

async def _vm_query(query: str) -> list[dict]:
    """Run an instant PromQL query and return the result vector."""
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(
                f"{vm_url()}/api/v1/query",
                params={"query": query},
            )
            resp.raise_for_status()
            return resp.json().get("data", {}).get("result", [])
    except Exception as exc:
        logger.warning("baseline_vm_query_failed", query=query[:100], error=str(exc))
        return []


async def _vm_scalar(query: str) -> Optional[float]:
    """Run an instant query expecting a single scalar result."""
    rows = await _vm_query(query)
    if rows:
        try:
            return float(rows[0]["value"][1])
        except (KeyError, IndexError, ValueError):
            pass
    return None


# ── ClickHouse helper ─────────────────────────────────────────────────────────

async def _ch_query(sql: str) -> list[dict]:
    flat = " ".join(sql.split()) + " FORMAT JSON"
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                ch_url(),
                content=flat,
                headers={"Content-Type": "text/plain"},
            )
            resp.raise_for_status()
            return resp.json().get("data", [])
    except Exception as exc:
        logger.warning("baseline_ch_query_failed", error=str(exc))
        return []


# ── DB upsert ─────────────────────────────────────────────────────────────────

async def _upsert(
    db: AsyncSession,
    device_id: str,
    metric_type: str,
    interface_id: Optional[str],
    label: Optional[str],
    *,
    normal_up_pct: Optional[float] = None,
    mean: float = 0.0,
    stddev: float = 0.0,
    p5: Optional[float] = None,
    p95: Optional[float] = None,
    sample_count: int = 0,
) -> None:
    """Upsert a single rolling-window baseline row."""
    await db.execute(
        text("""
            INSERT INTO metric_baselines
                (device_id, interface_id, label, metric_type,
                 bucket_type, bucket_index, window_days,
                 normal_up_pct, mean, stddev, p5, p95, sample_count,
                 computed_at)
            VALUES
                (:device_id, :interface_id, :label, :metric_type,
                 'rolling', 0, :window_days,
                 :normal_up_pct, :mean, :stddev, :p5, :p95, :sample_count,
                 now())
            ON CONFLICT (device_id,
                         COALESCE(interface_id, '00000000-0000-0000-0000-000000000000'),
                         metric_type, bucket_type, bucket_index)
            DO UPDATE SET
                normal_up_pct  = EXCLUDED.normal_up_pct,
                mean           = EXCLUDED.mean,
                stddev         = EXCLUDED.stddev,
                p5             = EXCLUDED.p5,
                p95            = EXCLUDED.p95,
                sample_count   = EXCLUDED.sample_count,
                window_days    = EXCLUDED.window_days,
                computed_at    = EXCLUDED.computed_at
        """),
        {
            "device_id":     device_id,
            "interface_id":  interface_id,
            "label":         label,
            "metric_type":   metric_type,
            "window_days":   _WINDOW_DAYS,
            "normal_up_pct": normal_up_pct,
            "mean":          mean,
            "stddev":        stddev,
            "p5":            p5,
            "p95":           p95,
            "sample_count":  sample_count,
        },
    )


# ── Interface-ID and device lookup caches ────────────────────────────────────

async def _load_interface_map(db: AsyncSession) -> dict[tuple[str, str], str]:
    """Return {(device_id, if_name): interface_id} for all active interfaces."""
    rows = await db.execute(
        text("""
            SELECT i.device_id::text, i.name, i.id::text
            FROM   interfaces i
            JOIN   devices d ON d.id = i.device_id
            WHERE  d.is_active = TRUE
        """)
    )
    return {(r[0], r[1]): r[2] for r in rows}


async def _load_active_device_ids(db: AsyncSession) -> set[str]:
    """Return the set of active device UUID strings."""
    rows = await db.execute(text("SELECT id::text FROM devices WHERE is_active = TRUE"))
    return {r[0] for r in rows}


# ── Per-metric baseline computations ─────────────────────────────────────────

async def _compute_interface_down(db: AsyncSession, iface_map: dict, valid_devs: set[str]) -> int:
    """Compute normal_up_pct per interface from anthrimon_if_oper_status.

    oper_status is written as 1=up, 0=down.  avg_over_time gives the
    fraction of samples that were up — exactly normal_up_pct.
    """
    # clamp_max(..., 1) guards against stale series that stored raw ifOperStatus
    # values (1=up, 6=notPresent) instead of the normalised 0/1 bit, which would
    # otherwise corrupt the baseline with avg values > 1.
    rows_avg = await _vm_query(
        f"clamp_max(avg_over_time(anthrimon_if_oper_status[{_WINDOW}:{_STEP}]), 1)"
    )
    # When duplicate label sets exist for the same (device_id, if_name) — e.g. one
    # series with a vendor label and one without — take the maximum so a fully-up
    # series wins over a stale all-zeros series.
    best: dict[tuple[str, str], float] = {}
    for r in rows_avg:
        device_id = r["metric"].get("device_id", "")
        if_name   = r["metric"].get("if_name", "")
        if not device_id or not if_name:
            continue
        try:
            up_pct = min(1.0, float(r["value"][1]))
        except (KeyError, IndexError, ValueError):
            continue
        key = (device_id, if_name)
        if up_pct > best.get(key, -1):
            best[key] = up_pct

    count = 0
    for (device_id, if_name), up_pct in best.items():
        iface_id = iface_map.get((device_id, if_name))
        if iface_id is None:
            continue
        await _upsert(
            db, device_id, "interface_down", iface_id, label=if_name,
            normal_up_pct=up_pct,
            sample_count=int(_WINDOW_DAYS * 24 * 60 / 5),  # approx
        )
        count += 1
    return count


async def _compute_interface_errors(db: AsyncSession, iface_map: dict, valid_devs: set[str]) -> int:
    """Compute mean + stddev of combined in+out error rate per interface."""
    metric = (
        f"avg_over_time("
        f"  (rate(anthrimon_if_in_errors_total[5m])"
        f"   + rate(anthrimon_if_out_errors_total[5m]))"
        f"  [{_WINDOW}:{_STEP}])"
    )
    stddev_metric = (
        f"stddev_over_time("
        f"  (rate(anthrimon_if_in_errors_total[5m])"
        f"   + rate(anthrimon_if_out_errors_total[5m]))"
        f"  [{_WINDOW}:{_STEP}])"
    )
    avg_rows, std_rows = await asyncio.gather(
        _vm_query(metric),
        _vm_query(stddev_metric),
    )

    # Build stddev lookup {(device_id, if_name): stddev}
    std_map: dict[tuple[str, str], float] = {}
    for r in std_rows:
        device_id = r["metric"].get("device_id", "")
        if_name   = r["metric"].get("if_name", "")
        try:
            std_map[(device_id, if_name)] = float(r["value"][1])
        except (KeyError, IndexError, ValueError):
            pass

    count = 0
    for r in avg_rows:
        device_id = r["metric"].get("device_id", "")
        if_name   = r["metric"].get("if_name", "")
        if not device_id or not if_name:
            continue
        iface_id = iface_map.get((device_id, if_name))
        if iface_id is None:
            continue
        try:
            mean = float(r["value"][1])
        except (KeyError, IndexError, ValueError):
            continue
        stddev = std_map.get((device_id, if_name), 0.0)
        await _upsert(
            db, device_id, "interface_errors", iface_id, label=if_name,
            mean=mean, stddev=stddev,
            sample_count=int(_WINDOW_DAYS * 24 * 60 / 5),
        )
        count += 1
    return count


async def _compute_cpu(db: AsyncSession, valid_devs: set[str]) -> int:
    """Compute mean + stddev of max CPU util per device."""
    # Take the max across cpu_index so we get the worst-case core.
    avg_rows, std_rows = await asyncio.gather(
        _vm_query(
            f"avg_over_time("
            f"  max by (device_id) (anthrimon_device_cpu_util_pct)"
            f"  [{_WINDOW}:{_STEP}])"
        ),
        _vm_query(
            f"stddev_over_time("
            f"  max by (device_id) (anthrimon_device_cpu_util_pct)"
            f"  [{_WINDOW}:{_STEP}])"
        ),
    )

    std_map = {r["metric"].get("device_id", ""): _safe_float(r) for r in std_rows}

    count = 0
    for r in avg_rows:
        device_id = r["metric"].get("device_id", "")
        if not device_id or device_id not in valid_devs:
            continue
        mean   = _safe_float(r)
        stddev = std_map.get(device_id, 0.0)
        await _upsert(
            db, device_id, "cpu_util_pct", None, label=None,
            mean=mean, stddev=stddev,
            sample_count=int(_WINDOW_DAYS * 24 * 60 / 5),
        )
        count += 1
    return count


async def _compute_memory(db: AsyncSession, valid_devs: set[str]) -> int:
    """Compute mean + stddev of memory utilisation % per device.

    VM stores raw bytes; we compute used/total*100 via a PromQL binary op.
    We use mem_type='DRAM' (most devices expose a single DRAM pool).
    """
    avg_rows, std_rows = await asyncio.gather(
        _vm_query(
            f"avg_over_time("
            f"  (max by (device_id) (anthrimon_device_mem_used_bytes{{mem_type='DRAM'}})"
            f"   / max by (device_id) (anthrimon_device_mem_total_bytes{{mem_type='DRAM'}})"
            f"   * 100)"
            f"  [{_WINDOW}:{_STEP}])"
        ),
        _vm_query(
            f"stddev_over_time("
            f"  (max by (device_id) (anthrimon_device_mem_used_bytes{{mem_type='DRAM'}})"
            f"   / max by (device_id) (anthrimon_device_mem_total_bytes{{mem_type='DRAM'}})"
            f"   * 100)"
            f"  [{_WINDOW}:{_STEP}])"
        ),
    )

    std_map = {r["metric"].get("device_id", ""): _safe_float(r) for r in std_rows}

    count = 0
    for r in avg_rows:
        device_id = r["metric"].get("device_id", "")
        if not device_id or device_id not in valid_devs:
            continue
        mean   = _safe_float(r)
        stddev = std_map.get(device_id, 0.0)
        await _upsert(
            db, device_id, "mem_util_pct", None, label=None,
            mean=mean, stddev=stddev,
            sample_count=int(_WINDOW_DAYS * 24 * 60 / 5),
        )
        count += 1
    return count


async def _compute_interface_util(db: AsyncSession, iface_map: dict, valid_devs: set[str]) -> int:
    """Compute mean + stddev of interface utilisation % per interface."""
    speed_filter = "anthrimon_if_speed_bps > 0"
    in_util  = (f"clamp_min(rate(anthrimon_if_in_octets_total[5m]) * 8"
                f"  / on(device_id, if_index) group_left() ({speed_filter}) * 100, 0)")
    out_util = (f"clamp_min(rate(anthrimon_if_out_octets_total[5m]) * 8"
                f"  / on(device_id, if_index) group_left() ({speed_filter}) * 100, 0)")
    util_expr = (
        f"max by (device_id, if_index, if_name) ("
        f"  label_replace({in_util},  \"d\", \"i\", \"\", \"\") or "
        f"  label_replace({out_util}, \"d\", \"o\", \"\", \"\")"
        f")"
    )
    avg_rows, std_rows = await asyncio.gather(
        _vm_query(f"avg_over_time(({util_expr})[{_WINDOW}:{_STEP}])"),
        _vm_query(f"stddev_over_time(({util_expr})[{_WINDOW}:{_STEP}])"),
    )

    std_map: dict[tuple[str, str], float] = {}
    for r in std_rows:
        device_id = r["metric"].get("device_id", "")
        if_name   = r["metric"].get("if_name", "")
        std_map[(device_id, if_name)] = _safe_float(r)

    count = 0
    for r in avg_rows:
        device_id = r["metric"].get("device_id", "")
        if_name   = r["metric"].get("if_name", "")
        if not device_id or not if_name:
            continue
        iface_id = iface_map.get((device_id, if_name))
        if iface_id is None:
            continue
        mean   = _safe_float(r)
        stddev = std_map.get((device_id, if_name), 0.0)
        await _upsert(
            db, device_id, "interface_util_pct", iface_id, label=if_name,
            mean=mean, stddev=stddev,
            sample_count=int(_WINDOW_DAYS * 24 * 60 / 5),
        )
        count += 1
    return count


async def _compute_dom_rx_power(db: AsyncSession, iface_map: dict, valid_devs: set[str]) -> int:
    """Compute mean + stddev of DOM Rx power per interface."""
    avg_rows, std_rows = await asyncio.gather(
        _vm_query(f"avg_over_time(anthrimon_if_dom_rx_power_dbm[{_WINDOW}:{_STEP}])"),
        _vm_query(f"stddev_over_time(anthrimon_if_dom_rx_power_dbm[{_WINDOW}:{_STEP}])"),
    )

    std_map: dict[tuple[str, str], float] = {}
    for r in std_rows:
        device_id = r["metric"].get("device_id", "")
        if_name   = r["metric"].get("if_name", "")
        std_map[(device_id, if_name)] = _safe_float(r)

    count = 0
    for r in avg_rows:
        device_id = r["metric"].get("device_id", "")
        if_name   = r["metric"].get("if_name", "")
        if not device_id or not if_name:
            continue
        iface_id = iface_map.get((device_id, if_name))
        if iface_id is None:
            continue
        mean   = _safe_float(r)
        stddev = std_map.get((device_id, if_name), 0.0)
        await _upsert(
            db, device_id, "dom_rx_power", iface_id, label=if_name,
            mean=mean, stddev=stddev,
            sample_count=int(_WINDOW_DAYS * 24 * 60 / 5),
        )
        count += 1
    return count


async def _compute_syslog_rate(db: AsyncSession, valid_devs: set[str]) -> int:
    """Compute mean + stddev of hourly syslog message rate per device from ClickHouse."""
    # syslog_agg_1hr stores one row per (hour, device_id, severity) with a `count`
    # column. Roll severities up into an hourly total per device first, then take
    # the mean/stddev of those hourly totals across the window (sample_count = the
    # number of hours observed). The previous query referenced a non-existent
    # `total` column, which ClickHouse rejected (UNKNOWN_IDENTIFIER → HTTP 404).
    rows = await _ch_query("""
        SELECT
            device_id,
            avg(hourly_total)       AS mean,
            stddevPop(hourly_total) AS stddev,
            count()                 AS sample_count
        FROM (
            SELECT device_id, hour, sum(count) AS hourly_total
            FROM syslog_agg_1hr
            WHERE hour >= now() - INTERVAL 14 DAY
            GROUP BY device_id, hour
        )
        GROUP BY device_id
    """)
    count = 0
    for r in rows:
        device_id = str(r.get("device_id", ""))
        if not device_id or device_id == "00000000-0000-0000-0000-000000000000":
            continue
        if device_id not in valid_devs:
            continue
        try:
            mean   = float(r["mean"])
            stddev = float(r["stddev"])
            sc     = int(r["sample_count"])
        except (KeyError, ValueError, TypeError):
            continue
        await _upsert(
            db, device_id, "syslog_rate", None, label=None,
            mean=mean, stddev=stddev, sample_count=sc,
        )
        count += 1
    return count


async def _compute_bgp_prefix_count(db: AsyncSession) -> int:
    """Accumulate an incremental mean/stddev for BGP prefix counts per peer.

    Each hourly run is one new sample.  Uses Welford's online algorithm to
    update mean and variance without storing raw values, so sample_count grows
    toward (and eventually past) the 50-sample threshold the evaluator requires.
    """
    rows = (await db.execute(
        text("""
            SELECT device_id::text, peer_ip::text, prefixes_received
            FROM   bgp_sessions
            WHERE  session_state = 'established'
              AND  prefixes_received IS NOT NULL
        """)
    )).all()
    count = 0
    for device_id, peer_ip, prefixes in rows:
        if prefixes is None:
            continue
        x = float(prefixes)
        # Fetch the existing baseline so we can update incrementally.
        existing = (await db.execute(
            text("""
                SELECT mean, stddev, sample_count
                FROM   metric_baselines
                WHERE  device_id    = :did
                  AND  label        = :label
                  AND  metric_type  = 'bgp_prefix_count'
                  AND  bucket_type  = 'rolling'
            """),
            {"did": device_id, "label": peer_ip},
        )).mappings().first()
        if existing and existing["sample_count"] > 0:
            n    = existing["sample_count"] + 1
            old_mean = float(existing["mean"])
            old_var  = (float(existing["stddev"]) ** 2) * existing["sample_count"]
            new_mean = old_mean + (x - old_mean) / n
            new_var  = (old_var + (x - old_mean) * (x - new_mean)) / n
            new_stddev = math.sqrt(max(new_var, 0.0))
        else:
            n, new_mean, new_stddev = 1, x, 0.0
        await _upsert(
            db, device_id, "bgp_prefix_count", None, label=peer_ip,
            mean=new_mean, stddev=new_stddev, sample_count=n,
        )
        count += 1
    return count


# ── Main compute loop ─────────────────────────────────────────────────────────

async def _run_once() -> None:
    # Load shared read-only data with a short-lived session.
    async with AsyncSessionLocal() as db:
        iface_map   = await _load_interface_map(db)
        valid_devs  = await _load_active_device_ids(db)

    # Each compute gets its own session so a FK violation or transaction error
    # in one metric cannot abort the others.
    async def _run(fn, *args):
        async with AsyncSessionLocal() as sess:
            result = await fn(sess, *args)
            await sess.commit()
            return result

    results = await asyncio.gather(
        _run(_compute_interface_down,  iface_map, valid_devs),
        _run(_compute_interface_errors, iface_map, valid_devs),
        _run(_compute_cpu,             valid_devs),
        _run(_compute_memory,          valid_devs),
        _run(_compute_interface_util,  iface_map, valid_devs),
        _run(_compute_dom_rx_power,    iface_map, valid_devs),
        _run(_compute_syslog_rate,     valid_devs),
        _run(_compute_bgp_prefix_count),
        return_exceptions=True,
    )

    totals = {}
    metrics = [
        "interface_down", "interface_errors", "cpu_util_pct",
        "mem_util_pct", "interface_util_pct", "dom_rx_power",
        "syslog_rate", "bgp_prefix_count",
    ]
    for metric, result in zip(metrics, results):
        if isinstance(result, BaseException):
            logger.warning("baseline_metric_failed", metric=metric, error=str(result))
            totals[metric] = "error"
        else:
            totals[metric] = result

    logger.info("baselines_computed", **totals)


_STARTUP_DELAY_S = 60  # wait for ClickHouse/VM to be ready before first run


async def _baseline_loop(interval_s: int = 3600) -> None:
    logger.info("baseline_task_started", interval_s=interval_s)
    # Give ClickHouse and VictoriaMetrics time to finish starting up before
    # the first compute — they may still be initialising when the API starts.
    await asyncio.sleep(_STARTUP_DELAY_S)
    while True:
        try:
            await _run_once()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.error("baseline_run_failed", error=str(exc), exc_info=exc)
        await asyncio.sleep(interval_s)


def start_baseline_task(interval_s: int = 3600) -> asyncio.Task:
    """Start the baseline computation loop.  Call from lifespan."""
    return asyncio.create_task(_baseline_loop(interval_s), name="baseline-task")


# ── Utilities ─────────────────────────────────────────────────────────────────

def _safe_float(row: dict, default: float = 0.0) -> float:
    try:
        return float(row["value"][1])
    except (KeyError, IndexError, ValueError, TypeError):
        return default
