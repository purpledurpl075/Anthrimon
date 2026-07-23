"""Self-observability: /platform/health (JSON for the dashboard) and
/platform/metrics (Prometheus text format for external scrape).

These endpoints describe Anthrimon itself — alert engine cycle time, API
request stats, alert/notification counts, DB pool stats, table sizes.
"""
from __future__ import annotations

import asyncio
import datetime
import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

import structlog
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, UploadFile, File
from fastapi.responses import StreamingResponse
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from ..audit import audit
from ..database import AsyncSessionLocal, engine
from ..dependencies import get_db, require_platform_user
from ..models.tenant import User
from ..platform_health import registry

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/platform", tags=["platform-health"])


def _safe_float(v: object) -> float:
    try:
        return float(v)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 0.0


async def _db_health(db: AsyncSession) -> dict:
    """Per-table row counts + DB connection pool stats."""
    tables = ["alerts", "alert_rules", "devices", "interfaces",
              "credentials", "users", "audit_log", "notification_send_log"]
    row_counts: dict[str, int] = {}
    for t in tables:
        try:
            n = (await db.execute(text(f"SELECT count(*) FROM {t}"))).scalar_one()
            row_counts[t] = int(n)
        except Exception as exc:
            logger.debug("table_count_failed", table=t, error=str(exc))
            row_counts[t] = -1

    # Postgres-side stats
    try:
        active = (await db.execute(text(
            "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()"
        ))).scalar_one()
        db_size = (await db.execute(text(
            "SELECT pg_database_size(current_database())"
        ))).scalar_one()
    except Exception:
        active, db_size = -1, -1

    # Connection pool stats from SQLAlchemy.  Pool.overflow() returns a
    # signed value where negative means "we have headroom"; the operator-
    # friendly number is max(0, …) so a healthy pool shows 0, not -2.
    pool = engine.pool
    raw_overflow = getattr(pool, "overflow", lambda: 0)()
    pool_stats = {
        "size":         getattr(pool, "size", lambda: -1)(),
        "checked_in":   getattr(pool, "checkedin", lambda: -1)(),
        "checked_out":  getattr(pool, "checkedout", lambda: -1)(),
        "overflow":     max(0, raw_overflow),
    }

    return {
        "row_counts":          row_counts,
        "active_connections":  active,
        "database_bytes":      db_size,
        "pool":                pool_stats,
    }


async def _alert_stats(db: AsyncSession, tenant_id: str) -> dict:
    """Per-tenant alert counts + recent notification activity."""
    by_status = dict((await db.execute(text("""
        SELECT status::text, count(*) FROM alerts
         WHERE tenant_id = CAST(:t AS uuid)
         GROUP BY status
    """), {"t": tenant_id})).all())
    last_hour_fired = (await db.execute(text("""
        SELECT count(*) FROM alerts
         WHERE tenant_id = CAST(:t AS uuid)
           AND triggered_at > now() - interval '1 hour'
    """), {"t": tenant_id})).scalar_one()
    last_hour_notify = (await db.execute(text("""
        SELECT count(*) FROM notification_send_log
         WHERE tenant_id = CAST(:t AS uuid)
           AND sent_at > now() - interval '1 hour'
    """), {"t": tenant_id})).scalar_one()
    notify_failures = (await db.execute(text("""
        SELECT count(*) FROM notification_send_log
         WHERE tenant_id = CAST(:t AS uuid)
           AND status NOT IN ('sent', 'success')
           AND sent_at > now() - interval '24 hours'
    """), {"t": tenant_id})).scalar_one()
    return {
        "by_status":         {k: int(v) for k, v in by_status.items()},
        "last_hour_fired":   int(last_hour_fired),
        "last_hour_notify":  int(last_hour_notify),
        "notify_failures_24h": int(notify_failures),
    }


async def _collector_stats(db: AsyncSession, tenant_id: str) -> list[dict]:
    """Recent heartbeat per remote collector."""
    rows = (await db.execute(text("""
        SELECT name, wg_ip::text AS wg_ip, last_seen, version
          FROM remote_collectors
         WHERE tenant_id = CAST(:t AS uuid)
         ORDER BY name
    """), {"t": tenant_id})).all()
    now = time.time()
    out: list[dict] = []
    for r in rows:
        ls_unix = r.last_seen.timestamp() if r.last_seen else None
        # Synthetic / in-process collectors (e.g. hub-trap-receiver) have no
        # WireGuard IP because they don't run on a remote machine.  Mark them
        # so the UI doesn't flag missing heartbeats as a failure.
        synthetic = not r.wg_ip
        out.append({
            "name":          r.name,
            "wg_ip":         r.wg_ip,
            "version":       r.version,
            "last_seen":     r.last_seen.isoformat() if r.last_seen else None,
            "stale_seconds": int(now - ls_unix) if ls_unix else None,
            "synthetic":     synthetic,
        })
    return out


@router.get("/health", summary="Anthrimon self-observability snapshot (JSON)")
async def get_platform_health(
    current_user: User = Depends(require_platform_user()),
    db: AsyncSession = Depends(get_db),
) -> dict:
    snap = registry.snapshot()
    tid = str(current_user.tenant_id)

    db_stats        = await _db_health(db)
    alert_stats     = await _alert_stats(db, tid)
    collector_stats = await _collector_stats(db, tid)

    return {
        "process":   snap["process"],
        "api": {
            "requests_total":   sum(
                v["value"] for v in snap["counters"].get("anthrimon_api_requests_total", [])
            ),
            "requests_by_status": _aggregate_by_label(snap, "anthrimon_api_requests_total", "status"),
            "request_duration": snap["histograms"].get(
                "anthrimon_api_request_duration_seconds",
                {"count": 0, "sum": 0, "p50": 0, "p95": 0, "p99": 0, "max": 0},
            ),
        },
        "alert_engine": {
            "cycle_duration": snap["histograms"].get(
                "anthrimon_alert_engine_cycle_duration_seconds",
                {"count": 0, "sum": 0, "p50": 0, "p95": 0, "p99": 0, "max": 0},
            ),
            "fired_total":      sum(
                v["value"] for v in snap["counters"].get("anthrimon_alert_engine_alerts_fired_total", [])
            ),
            "suppressed_total": sum(
                v["value"] for v in snap["counters"].get("anthrimon_alert_engine_alerts_suppressed_total", [])
            ),
            "wake_events":      sum(
                v["value"] for v in snap["counters"].get("anthrimon_alert_engine_wake_events_total", [])
            ),
        },
        "alerts":     alert_stats,
        "database":   db_stats,
        "collectors": collector_stats,
    }


def _aggregate_by_label(snap: dict, counter_name: str, label: str) -> dict[str, float]:
    out: dict[str, float] = {}
    for v in snap["counters"].get(counter_name, []):
        key = v["labels"].get(label, "")
        out[key] = out.get(key, 0.0) + v["value"]
    return out


@router.get("/metrics", summary="Anthrimon self-metrics (Prometheus exposition format)")
async def get_platform_metrics() -> Response:
    """Prometheus text-format metrics.  No auth so external scrapers can read.
    Bind to localhost or use a reverse-proxy ACL if you want to restrict access."""
    body = registry.prometheus_text()
    return Response(content=body, media_type="text/plain; version=0.0.4")


# ── Backup creation + download ────────────────────────────────────────────────

def _find_backup_script() -> Path:
    """Locate the anthrimon-backup CLI.  Prefer the installed copy at
    /usr/local/bin/anthrimon-backup (which is the install layout the API
    expects on a real deployment); fall back to the in-repo script for
    development.  Returns the first one found."""
    candidates = [
        Path("/usr/local/bin/anthrimon-backup"),
        Path(__file__).resolve().parents[3] / "scripts" / "anthrimon-backup",
    ]
    for c in candidates:
        if c.exists():
            return c
    return candidates[0]  # error reported by the endpoint when it tries to run

_BACKUP_SCRIPT = _find_backup_script()


@router.post("/backup",
             summary="Create and download a full system backup (admin only)")
async def create_backup_download(
    request:       Request,
    no_flow_history: bool = Query(default=True,
                                  description="Skip flow_records + syslog_messages data (smaller, faster)"),
    compression:   int = Query(default=3, ge=1, le=19),
    current_user:  User = Depends(require_platform_user()),
    db:            AsyncSession = Depends(get_db),
) -> StreamingResponse:
    """Runs the anthrimon-backup CLI to a temp file, then streams the file as
    a downloadable response.  The temp file is unlinked once the stream closes.

    Audit-logged as a `config_backup` action because this exposes every secret
    in /etc/anthrimon (TLS keys, .env, WireGuard keys) to whoever downloads it.
    """
    if not _BACKUP_SCRIPT.exists():
        raise HTTPException(status_code=500,
                            detail=f"backup script not found at {_BACKUP_SCRIPT}")

    ts = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d-%H%M%S")
    out_path = Path(tempfile.mkdtemp(prefix="anthrimon-backup-")) / f"anthrimon-backup-{ts}.tar.zst"

    cmd = [
        "python3", str(_BACKUP_SCRIPT),
        "--out", str(out_path),
        "--compression", str(compression),
    ]
    if no_flow_history:
        cmd.append("--no-flow-history")

    logger.info("backup_started", user=current_user.username, no_flow_history=no_flow_history)

    # Run synchronously so we have the full file before streaming.  This makes
    # Content-Length accurate and lets the operator see download progress.
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()

    if proc.returncode != 0:
        # Clean up temp dir before erroring out
        try:
            if out_path.exists(): out_path.unlink()
            out_path.parent.rmdir()
        except Exception:
            pass
        logger.error("backup_failed", returncode=proc.returncode,
                     stderr=stderr.decode("utf-8", "replace")[-500:])
        raise HTTPException(
            status_code=500,
            detail=f"Backup failed (rc={proc.returncode}): "
                   f"{stderr.decode('utf-8', 'replace').strip()[-500:]}",
        )

    if not out_path.exists():
        raise HTTPException(status_code=500, detail="Backup script reported success but no output file produced")

    size = out_path.stat().st_size
    logger.info("backup_ready", path=str(out_path), bytes=size)

    await audit(db, action="config_backup", resource_type="platform",
                new_value={"size_bytes": size, "no_flow_history": no_flow_history,
                           "filename": out_path.name},
                user=current_user, request=request)
    await db.commit()

    async def _stream():
        """Stream the file 1 MiB at a time, deleting it when done."""
        try:
            with open(out_path, "rb") as fh:
                while True:
                    chunk = fh.read(1024 * 1024)
                    if not chunk:
                        break
                    yield chunk
        finally:
            try:
                out_path.unlink(missing_ok=True)
                out_path.parent.rmdir()
            except Exception as exc:
                logger.debug("backup_cleanup_failed", error=str(exc))

    return StreamingResponse(
        _stream(),
        media_type="application/zstd",
        headers={
            "Content-Disposition": f'attachment; filename="{out_path.name}"',
            "Content-Length":      str(size),
            "X-Anthrimon-Backup-Version": "1",
        },
    )


# ── Backup upload + list ─────────────────────────────────────────────────────

_UPLOAD_DIR = Path("/var/lib/anthrimon/uploaded-backups")
_MAX_UPLOAD_BYTES = 10 * 1024 * 1024 * 1024  # 10 GiB — flow-history backups can be big


def _ensure_upload_dir() -> Path:
    _UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    return _UPLOAD_DIR


@router.post("/backup-upload",
             summary="Upload a backup archive to the server's restore-staging dir (admin only)")
async def upload_backup(
    request:      Request,
    file:         UploadFile = File(...),
    current_user: User       = Depends(require_platform_user()),
    db:           AsyncSession = Depends(get_db),
) -> dict:
    """Streams an uploaded `anthrimon-backup-*.tar.zst` to the server's
    /var/lib/anthrimon/uploaded-backups/ directory.  The operator then SSHes
    in and runs `sudo anthrimon-restore <path>` — restore itself stays CLI
    because it has to stop the API and replace the database that's serving
    the very request that triggered it.
    """
    name = (file.filename or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="No filename")
    # Defend against path-traversal and arbitrary extensions
    safe_name = os.path.basename(name)
    if safe_name != name or "/" in name or ".." in name:
        raise HTTPException(status_code=400, detail="Filename must not contain path separators")
    if not (safe_name.endswith(".tar.zst") or safe_name.endswith(".tar.zst.enc")):
        raise HTTPException(status_code=400,
                            detail="Only .tar.zst or .tar.zst.enc backup archives are accepted")

    target_dir = _ensure_upload_dir()
    # Avoid clobbering an existing file with the same name — prefix with a stamp.
    ts = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    dst = target_dir / f"{ts}__{safe_name}"

    # Stream to disk so we don't buffer multi-GB uploads in memory.
    written = 0
    try:
        with open(dst, "wb") as fh:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                written += len(chunk)
                if written > _MAX_UPLOAD_BYTES:
                    raise HTTPException(status_code=413,
                                        detail=f"Upload exceeds {_MAX_UPLOAD_BYTES // (1024**3)} GiB cap")
                fh.write(chunk)
    except HTTPException:
        dst.unlink(missing_ok=True)
        raise
    except Exception as exc:
        dst.unlink(missing_ok=True)
        logger.error("backup_upload_failed", error=str(exc))
        raise HTTPException(status_code=500, detail=f"Upload failed: {exc}")

    # Readable by group so the restore process can pick it up without chowning.
    try:
        os.chmod(dst, 0o640)
    except OSError:
        pass

    await audit(db, action="config_backup", resource_type="platform",
                new_value={"action": "upload", "filename": dst.name,
                           "size_bytes": written},
                user=current_user, request=request)
    await db.commit()

    logger.info("backup_uploaded", path=str(dst), bytes=written)
    return {
        "path":      str(dst),
        "filename":  dst.name,
        "size":      written,
        "restore_command": f"sudo anthrimon-restore {dst}",
    }


@router.get("/backups",
            summary="List backup archives sitting in the server's restore-staging dir")
async def list_uploaded_backups(
    current_user: User = Depends(require_platform_user()),
) -> list[dict]:
    """List files currently staged for restore.  Operator deletes them via
    SSH after restoring (or via the corresponding DELETE endpoint below)."""
    target_dir = _ensure_upload_dir()
    out: list[dict] = []
    for p in sorted(target_dir.iterdir(), key=lambda x: x.name, reverse=True):
        if not p.is_file():
            continue
        try:
            st = p.stat()
            out.append({
                "filename": p.name,
                "path":     str(p),
                "size":     st.st_size,
                "modified_at": datetime.datetime.fromtimestamp(st.st_mtime, datetime.timezone.utc).isoformat(),
            })
        except OSError:
            continue
    return out


@router.delete("/backups/{filename}", status_code=204,
               summary="Remove an uploaded backup archive from the staging dir")
async def delete_uploaded_backup(
    filename:     str,
    request:      Request,
    current_user: User         = Depends(require_platform_user()),
    db:           AsyncSession = Depends(get_db),
) -> Response:
    safe = os.path.basename(filename)
    if safe != filename:
        raise HTTPException(status_code=400, detail="Filename must not contain path separators")
    target_dir = _ensure_upload_dir()
    p = target_dir / safe
    if not p.exists() or not p.is_file():
        raise HTTPException(status_code=404, detail="Not found")
    try:
        p.unlink()
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Delete failed: {exc}")
    await audit(db, action="delete", resource_type="platform",
                new_value={"filename": safe, "context": "uploaded-backup"},
                user=current_user, request=request)
    await db.commit()
    return Response(status_code=204)
