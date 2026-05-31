from __future__ import annotations

import asyncio
import json
import time
import uuid

import httpx
import structlog
from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..dependencies import get_current_user, get_current_user_sse, get_db, require_role
from ..models.interface import Interface
from ..models.tenant import User
from ..schemas.interface import InterfaceRead, InterfaceUpdate

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/interfaces", tags=["interfaces"])

_VM_URL = "http://localhost:8428"


@router.get("/{interface_id}", response_model=InterfaceRead, summary="Get a single interface")
async def get_interface(
    interface_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> InterfaceRead:
    iface = await _get_interface_for_tenant(interface_id, current_user.tenant_id, db)
    return InterfaceRead.model_validate(iface)


@router.patch("/{interface_id}", response_model=InterfaceRead, summary="Update operator-editable interface fields")
async def update_interface(
    interface_id: uuid.UUID,
    body: InterfaceUpdate,
    current_user: User = Depends(require_role("admin", "superadmin", "operator")),
    db: AsyncSession = Depends(get_db),
) -> InterfaceRead:
    iface = await _get_interface_for_tenant(interface_id, current_user.tenant_id, db)

    for field, value in body.model_dump(exclude_none=True).items():
        setattr(iface, field, value)

    await db.commit()
    await db.refresh(iface)
    logger.info("interface_updated", interface_id=str(interface_id))
    return InterfaceRead.model_validate(iface)


@router.get("/{interface_id}/utilisation", summary="Interface metrics from VictoriaMetrics")
async def get_interface_utilisation(
    interface_id: uuid.UUID,
    hours: float = Query(default=0.5, ge=0.1, le=720.0),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    iface = await _get_interface_for_tenant(interface_id, current_user.tenant_id, db)
    device_id = str(iface.device_id)
    if_index = str(iface.if_index)

    now   = int(time.time())
    start = now - int(hours * 3600)

    if hours <= 1:
        step     = 15
        lookback = 60   # irate only uses last 2 samples — longer window just guards missed polls
        rate_fn  = "irate"
    elif hours <= 6:
        step     = 60
        lookback = 120  # 2× step so spikes can't straddle a boundary
        rate_fn  = "rate"
    elif hours <= 24:
        step     = 300
        lookback = 600
        rate_fn  = "rate"
    else:
        step     = 3600
        lookback = 7200
        rate_fn  = "rate"

    def q(metric: str, multiplier: str = "") -> str:
        base = f'{rate_fn}({metric}{{device_id="{device_id}",if_index="{if_index}"}}[{lookback}s])'
        return base + multiplier

    queries = {
        "in_bps":       q("anthrimon_if_in_octets_total",  " * 8"),
        "out_bps":      q("anthrimon_if_out_octets_total", " * 8"),
        "in_errors":    q("anthrimon_if_in_errors_total"),
        "out_errors":   q("anthrimon_if_out_errors_total"),
        "in_discards":  q("anthrimon_if_in_discards_total"),
        "out_discards": q("anthrimon_if_out_discards_total"),
    }

    async def fetch_series(client: httpx.AsyncClient, key: str, query: str) -> tuple[str, list]:
        try:
            resp = await client.get(
                f"{_VM_URL}/api/v1/query_range",
                params={"query": query, "start": start, "end": now, "step": step},
            )
            resp.raise_for_status()
            results = resp.json().get("data", {}).get("result", [])
            series = [
                [int(v[0]), float(v[1])]
                for v in (results[0].get("values", []) if results else [])
            ]
            return key, series
        except Exception:
            return key, []

    result: dict[str, list] = {k: [] for k in queries}
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            fetched = await asyncio.gather(*[
                fetch_series(client, k, qry) for k, qry in queries.items()
            ])
            result = dict(fetched)
    except Exception:
        pass

    return {
        "if_name":   iface.name,
        "speed_bps": iface.speed_bps,
        **result,
    }


_LIVE_OIDS = {
    "in_octets":    "1.3.6.1.2.1.31.1.1.1.6",   # ifHCInOctets  (64-bit)
    "out_octets":   "1.3.6.1.2.1.31.1.1.1.10",  # ifHCOutOctets (64-bit)
    "in_errors":    "1.3.6.1.2.1.2.2.1.14",     # ifInErrors
    "out_errors":   "1.3.6.1.2.1.2.2.1.20",     # ifOutErrors
    "in_pkts":      "1.3.6.1.2.1.31.1.1.1.7",   # ifHCInUcastPkts  (64-bit)
    "out_pkts":     "1.3.6.1.2.1.31.1.1.1.11",  # ifHCOutUcastPkts (64-bit)
    "in_discards":  "1.3.6.1.2.1.2.2.1.13",     # ifInDiscards
    "out_discards": "1.3.6.1.2.1.2.2.1.19",     # ifOutDiscards
}


def _escape_label(s: str) -> str:
    return s.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")

_AUTH_PROTO = {
    "md5":    "usmHMACMD5AuthProtocol",
    "sha":    "usmHMACSHAAuthProtocol",
    "sha256": "usmHMAC192SHA256AuthProtocol",
    "sha512": "usmHMAC384SHA512AuthProtocol",
}
_PRIV_PROTO = {
    "des":    "usmDESPrivProtocol",
    "aes":    "usmAesCfb128Protocol",
    "aes192": "usmAesCfb192Protocol",
    "aes256": "usmAesCfb256Protocol",
}


@router.get("/{interface_id}/live", summary="Live SNMP counter stream (Server-Sent Events)")
async def interface_live_stream(
    interface_id: uuid.UUID,
    current_user: User = Depends(get_current_user_sse),
    db: AsyncSession = Depends(get_db),
) -> StreamingResponse:
    from ..models.device import Device
    from ..models.credential import Credential, DeviceCredential
    from ..models.site import RemoteCollector

    iface = await _get_interface_for_tenant(interface_id, current_user.tenant_id, db)

    device = (await db.execute(
        select(Device).where(Device.id == iface.device_id, Device.tenant_id == current_user.tenant_id)
    )).scalar_one_or_none()
    if device is None:
        raise HTTPException(status_code=404, detail="Device not found")

    # ── Remote-collector proxy path ───────────────────────────────────────────
    if device.collector_id is not None:
        rc = (await db.execute(
            select(RemoteCollector).where(
                RemoteCollector.id == device.collector_id,
                RemoteCollector.tenant_id == current_user.tenant_id,
            )
        )).scalar_one_or_none()
        if rc is None or not rc.wg_ip:
            raise HTTPException(status_code=503, detail="Remote collector not reachable")

        wg_ip      = str(rc.wg_ip).split("/")[0]
        auth_token = rc.api_key_hash
        device_id  = str(device.id)
        if_index   = iface.if_index
        speed_bps  = iface.speed_bps
        if_name    = iface.name
        vendor_str = device.vendor or ""
        vm_labels  = (
            f'device_id="{device.id}",'
            f'if_index="{if_index}",'
            f'if_name="{_escape_label(if_name)}",'
            f'vendor="{_escape_label(vendor_str)}"'
        )

        return StreamingResponse(
            _stream_proxy(wg_ip, auth_token, device_id, if_index, speed_bps, vm_labels),
            media_type="text/event-stream",
            headers={
                "Cache-Control":     "no-cache",
                "X-Accel-Buffering": "no",
                "Connection":        "keep-alive",
            },
        )

    # ── Direct SNMP path (hub-managed devices) ────────────────────────────────
    import pysnmp.hlapi.v3arch.asyncio as hlapi
    from pysnmp.hlapi.v3arch.asyncio import (
        CommunityData, ContextData, ObjectIdentity, ObjectType,
        SnmpEngine, UdpTransportTarget, UsmUserData, get_cmd,
    )

    cred_row = (await db.execute(
        select(DeviceCredential, Credential)
        .join(Credential, Credential.id == DeviceCredential.credential_id)
        .where(
            DeviceCredential.device_id == device.id,
            Credential.type.in_(["snmp_v2c", "snmp_v3"]),
        )
        .order_by(DeviceCredential.priority)
    )).first()
    if cred_row is None:
        raise HTTPException(status_code=400, detail="No SNMP credential assigned to this device")

    _, cred = cred_row
    cred_data = cred.data if isinstance(cred.data, dict) else json.loads(cred.data)

    host       = device.mgmt_ip_str
    port       = device.snmp_port or 161
    if_index   = iface.if_index
    speed_bps  = iface.speed_bps
    if_name    = iface.name
    vendor_str = device.vendor or ""
    vm_labels  = (
        f'device_id="{device.id}",'
        f'if_index="{if_index}",'
        f'if_name="{_escape_label(if_name)}",'
        f'vendor="{_escape_label(vendor_str)}"'
    )

    if cred.type == "snmp_v2c":
        auth = CommunityData(cred_data.get("community", "public"), mpModel=1)
    else:
        auth = UsmUserData(
            cred_data["username"],
            authKey=cred_data.get("auth_key", ""),
            privKey=cred_data.get("priv_key", ""),
            authProtocol=getattr(hlapi, _AUTH_PROTO.get(cred_data.get("auth_protocol", "sha256").lower(), "usmHMAC192SHA256AuthProtocol")),
            privProtocol=getattr(hlapi, _PRIV_PROTO.get(cred_data.get("priv_protocol", "aes").lower(), "usmAesCfb128Protocol")),
        )

    async def _stream():
        engine    = SnmpEngine()
        vm_client = httpx.AsyncClient(timeout=5)
        prev: dict | None = None
        try:
            transport = await UdpTransportTarget.create((host, port), timeout=3, retries=0)
            oid_objs  = [ObjectType(ObjectIdentity(f"{base}.{if_index}")) for base in _LIVE_OIDS.values()]

            for _ in range(100):  # 100 × 3 s = 5 min max
                ts = time.time()
                try:
                    err_ind, err_status, _, vbs = await get_cmd(
                        engine, auth, transport, ContextData(), *oid_objs
                    )
                    if err_ind or err_status:
                        msg = str(err_ind) if err_ind else err_status.prettyPrint()
                        yield f"data: {json.dumps({'error': msg})}\n\n"
                        return

                    counters: dict[str, int] = {}
                    for key, vb in zip(_LIVE_OIDS.keys(), vbs):
                        try:
                            counters[key] = int(vb[1])
                        except Exception:
                            counters[key] = 0

                    # Write raw counter values to VictoriaMetrics so the historical
                    # chart benefits from live mode's 3 s resolution.
                    ts_ms = int(ts * 1000)
                    vm_lines = "\n".join([
                        f'anthrimon_if_in_octets_total{{{vm_labels}}} {counters["in_octets"]} {ts_ms}',
                        f'anthrimon_if_out_octets_total{{{vm_labels}}} {counters["out_octets"]} {ts_ms}',
                        f'anthrimon_if_in_errors_total{{{vm_labels}}} {counters["in_errors"]} {ts_ms}',
                        f'anthrimon_if_out_errors_total{{{vm_labels}}} {counters["out_errors"]} {ts_ms}',
                        f'anthrimon_if_in_discards_total{{{vm_labels}}} {counters["in_discards"]} {ts_ms}',
                        f'anthrimon_if_out_discards_total{{{vm_labels}}} {counters["out_discards"]} {ts_ms}',
                    ]) + "\n"
                    try:
                        await vm_client.post(
                            f"{_VM_URL}/api/v1/import/prometheus",
                            content=vm_lines,
                            headers={"Content-Type": "text/plain"},
                        )
                    except Exception:
                        pass  # non-fatal — SSE stream continues

                    if prev is not None:
                        dt = ts - prev["ts"]
                        if dt > 0:
                            in_bps    = max(0.0, (counters["in_octets"]  - prev["in_octets"])  * 8 / dt)
                            out_bps   = max(0.0, (counters["out_octets"] - prev["out_octets"]) * 8 / dt)
                            in_pps    = max(0.0, (counters["in_pkts"]    - prev["in_pkts"])    / dt)
                            out_pps   = max(0.0, (counters["out_pkts"]   - prev["out_pkts"])   / dt)
                            in_err_s  = max(0.0, (counters["in_errors"]  - prev["in_errors"])  / dt)
                            out_err_s = max(0.0, (counters["out_errors"] - prev["out_errors"]) / dt)
                            event = {
                                "ts":           ts,
                                "in_bps":       in_bps,
                                "out_bps":      out_bps,
                                "in_pps":       in_pps,
                                "out_pps":      out_pps,
                                "in_errors_ps": in_err_s,
                                "out_errors_ps":out_err_s,
                                "util_in_pct":  round(in_bps  / speed_bps * 100, 2) if speed_bps else None,
                                "util_out_pct": round(out_bps / speed_bps * 100, 2) if speed_bps else None,
                            }
                        else:
                            event = {"ts": ts}
                    else:
                        # First sample: counters received but no rate yet
                        event = {
                            "ts":           ts,
                            "in_bps":       None, "out_bps":       None,
                            "in_pps":       None, "out_pps":       None,
                            "in_errors_ps": None, "out_errors_ps": None,
                            "util_in_pct":  None, "util_out_pct":  None,
                        }

                    prev = {"ts": ts, **counters}
                    yield f"data: {json.dumps(event)}\n\n"

                except asyncio.CancelledError:
                    return
                except Exception as exc:
                    yield f"data: {json.dumps({'error': str(exc)})}\n\n"
                    return

                try:
                    await asyncio.sleep(3)
                except asyncio.CancelledError:
                    return

        except asyncio.CancelledError:
            pass
        except Exception as exc:
            yield f"data: {json.dumps({'error': str(exc)})}\n\n"
        finally:
            await vm_client.aclose()
            yield 'data: {"done":true}\n\n'

    return StreamingResponse(
        _stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control":    "no-cache",
            "X-Accel-Buffering": "no",
            "Connection":        "keep-alive",
        },
    )


async def _stream_proxy(
    wg_ip:      str,
    auth_token: str,
    device_id:  str,
    if_index:   int,
    speed_bps:  int | None,
    vm_labels:  str,
):
    """Proxy live SSE from a remote collector's /live endpoint.

    The collector sends raw counter snapshots (LiveSample JSON).  This generator
    calculates rates from consecutive samples, writes raw counters to
    VictoriaMetrics (same as the direct SNMP path), and yields rate events to
    the browser.
    """
    url = f"http://{wg_ip}:9090/live?device_id={device_id}&if_index={if_index}"
    headers = {"Authorization": f"Bearer {auth_token}"}
    prev: dict | None = None

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(connect=10, read=None, write=10, pool=10)) as client:
            async with client.stream("GET", url, headers=headers) as resp:
                if resp.status_code != 200:
                    yield f"data: {json.dumps({'error': f'collector returned HTTP {resp.status_code}'})}\n\n"
                    return

                vm_client = httpx.AsyncClient(timeout=5)
                try:
                    async for line in resp.aiter_lines():
                        if not line.startswith("data:"):
                            continue
                        raw = line[5:].strip()
                        try:
                            data = json.loads(raw)
                        except Exception:
                            continue

                        if data.get("done"):
                            break
                        if "error" in data:
                            yield f"data: {raw}\n\n"
                            return

                        ts_ms: int = data["ts"]
                        ts = ts_ms / 1000.0

                        # Write raw counters to VictoriaMetrics for historical charts.
                        vm_lines = "\n".join([
                            f'anthrimon_if_in_octets_total{{{vm_labels}}} {data["in_octets"]} {ts_ms}',
                            f'anthrimon_if_out_octets_total{{{vm_labels}}} {data["out_octets"]} {ts_ms}',
                            f'anthrimon_if_in_errors_total{{{vm_labels}}} {data["in_errors"]} {ts_ms}',
                            f'anthrimon_if_out_errors_total{{{vm_labels}}} {data["out_errors"]} {ts_ms}',
                            f'anthrimon_if_in_discards_total{{{vm_labels}}} {data["in_discards"]} {ts_ms}',
                            f'anthrimon_if_out_discards_total{{{vm_labels}}} {data["out_discards"]} {ts_ms}',
                        ]) + "\n"
                        try:
                            await vm_client.post(
                                f"{_VM_URL}/api/v1/import/prometheus",
                                content=vm_lines,
                                headers={"Content-Type": "text/plain"},
                            )
                        except Exception:
                            pass

                        if prev is not None:
                            dt = ts - prev["ts"]
                            if dt > 0:
                                def _rate(key: str) -> float:
                                    return max(0.0, (data[key] - prev[key]) / dt)
                                in_bps   = _rate("in_octets")  * 8
                                out_bps  = _rate("out_octets") * 8
                                event = {
                                    "ts":            ts,
                                    "in_bps":        in_bps,
                                    "out_bps":       out_bps,
                                    "in_pps":        _rate("in_pkts"),
                                    "out_pps":       _rate("out_pkts"),
                                    "in_errors_ps":  _rate("in_errors"),
                                    "out_errors_ps": _rate("out_errors"),
                                    "util_in_pct":   round(in_bps  / speed_bps * 100, 2) if speed_bps else None,
                                    "util_out_pct":  round(out_bps / speed_bps * 100, 2) if speed_bps else None,
                                }
                            else:
                                event = {"ts": ts}
                        else:
                            event = {
                                "ts": ts,
                                "in_bps": None, "out_bps": None,
                                "in_pps": None, "out_pps": None,
                                "in_errors_ps": None, "out_errors_ps": None,
                                "util_in_pct": None, "util_out_pct": None,
                            }

                        prev = {**data, "ts": ts}
                        yield f"data: {json.dumps(event)}\n\n"
                finally:
                    await vm_client.aclose()

    except asyncio.CancelledError:
        pass
    except Exception as exc:
        yield f"data: {json.dumps({'error': str(exc)})}\n\n"

    yield 'data: {"done":true}\n\n'


async def _get_interface_for_tenant(
    interface_id: uuid.UUID,
    tenant_id: uuid.UUID,
    db: AsyncSession,
) -> Interface:
    """Fetch an interface, enforcing tenant isolation via the device relationship."""
    from ..models.device import Device
    result = await db.execute(
        select(Interface)
        .join(Device, Interface.device_id == Device.id)
        .where(Interface.id == interface_id, Device.tenant_id == tenant_id)
    )
    iface = result.scalar_one_or_none()
    if iface is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Interface not found")
    return iface
