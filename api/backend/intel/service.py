from __future__ import annotations

import asyncio
import ipaddress
from datetime import datetime, timedelta, timezone
from typing import Optional

import structlog
from sqlalchemy import text

from ..database import AsyncSessionLocal
from .geo   import batch_geoip
from .abuse import check_abuseipdb

logger = structlog.get_logger(__name__)

_GEO_TTL_DAYS   = 7
_ABUSE_TTL_HOURS = 24

# Private / non-routable ranges — skip geo + abuse checks entirely
_PRIVATE = [
    ipaddress.ip_network(n) for n in (
        "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16",
        "127.0.0.0/8", "169.254.0.0/16", "100.64.0.0/10",
        "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24",
        "224.0.0.0/4", "240.0.0.0/4",
    )
]


def is_private(ip: str) -> bool:
    try:
        addr = ipaddress.ip_address(ip)
        return any(addr in net for net in _PRIVATE)
    except ValueError:
        return True   # treat unparseable as private / skip


def _intel_row(row) -> dict:
    return {
        "ip":            str(row["ip"]).split("/")[0],
        "is_private":    row["is_private"],
        "country_iso":   row["country_iso"],
        "country_name":  row["country_name"],
        "asn":           row["asn"],
        "asn_org":       row["asn_org"],
        "city":          row["city"],
        "abuse_score":   row["abuse_score"],
        "abuse_reports": row["abuse_reports"],
        "abuse_isp":     row["abuse_isp"],
        "abuse_domain":  row["abuse_domain"],
    }


async def get_intel(ips: list[str]) -> dict[str, dict]:
    """Return cached intel from ip_intel for the given IPs. Fast — DB only."""
    if not ips:
        return {}
    async with AsyncSessionLocal() as db:
        rows = (await db.execute(
            text("SELECT * FROM ip_intel WHERE host(ip) = ANY(:ips)"),
            {"ips": list(ips)},
        )).mappings().all()
    # host() strips the /32 prefix PostgreSQL adds to INET values
    return {str(r["ip"]).split("/")[0]: _intel_row(r) for r in rows}


async def enrich_ips(
    ips: list[str],
    abuseipdb_key: str = "",
    force_abuse: bool = False,
) -> dict[str, dict]:
    """
    Fetch geo + optionally abuse intel for IPs not yet in cache (or stale).
    Stores results in ip_intel.  Returns the final intel dict for all IPs.
    """
    if not ips:
        return {}

    now = datetime.now(timezone.utc)
    geo_cutoff   = now - timedelta(days=_GEO_TTL_DAYS)
    abuse_cutoff = now - timedelta(hours=_ABUSE_TTL_HOURS)

    # Load what we already have
    async with AsyncSessionLocal() as db:
        rows = (await db.execute(
            text("SELECT * FROM ip_intel WHERE host(ip) = ANY(:ips)"),
            {"ips": list(ips)},
        )).mappings().all()

    cached: dict[str, dict] = {str(r["ip"]).split("/")[0]: dict(r) for r in rows}

    public_ips = [ip for ip in ips if not is_private(ip)]

    # ── GeoIP enrichment ──────────────────────────────────────────────────────
    geo_needed = [
        ip for ip in public_ips
        if ip not in cached
        or cached[ip].get("geo_checked_at") is None
        or cached[ip]["geo_checked_at"].replace(tzinfo=timezone.utc) < geo_cutoff
    ]
    geo_results: dict[str, dict] = {}
    if geo_needed:
        geo_results = await batch_geoip(geo_needed)

    # ── AbuseIPDB enrichment ──────────────────────────────────────────────────
    abuse_results: dict[str, dict] = {}
    if abuseipdb_key:
        abuse_needed = [
            ip for ip in public_ips
            if force_abuse
            or ip not in cached
            or cached[ip].get("abuse_checked_at") is None
            or cached[ip]["abuse_checked_at"].replace(tzinfo=timezone.utc) < abuse_cutoff
        ]
        # Check sequentially to respect rate limits; limit to 50 per call
        for ip in abuse_needed[:50]:
            result = await check_abuseipdb(ip, abuseipdb_key)
            if result is not None:
                abuse_results[ip] = result
            await asyncio.sleep(0.05)  # ~20/s, well under rate limit

    # ── Upsert into ip_intel ──────────────────────────────────────────────────
    all_ips_to_write = set(geo_needed) | set(abuse_results.keys())
    # Also ensure private IPs are marked
    for ip in ips:
        if is_private(ip) and ip not in cached:
            all_ips_to_write.add(ip)

    if all_ips_to_write:
        async with AsyncSessionLocal() as db:
            for ip in all_ips_to_write:
                priv = is_private(ip)
                geo  = geo_results.get(ip, {})
                ab   = abuse_results.get(ip, {})
                existing = cached.get(ip, {})

                await db.execute(text("""
                    INSERT INTO ip_intel
                        (ip, is_private,
                         country_iso, country_name, asn, asn_org, city, geo_checked_at,
                         abuse_score, abuse_reports, abuse_isp, abuse_domain, abuse_checked_at,
                         updated_at)
                    VALUES
                        (CAST(:ip AS inet), :priv,
                         :country_iso, :country_name, :asn, :asn_org, :city,
                         CASE WHEN :geo_done THEN NOW() ELSE :old_geo END,
                         :abuse_score, :abuse_reports, :abuse_isp, :abuse_domain,
                         CASE WHEN :abuse_done THEN NOW() ELSE :old_abuse END,
                         NOW())
                    ON CONFLICT (ip) DO UPDATE SET
                        is_private    = EXCLUDED.is_private,
                        country_iso   = COALESCE(EXCLUDED.country_iso,   ip_intel.country_iso),
                        country_name  = COALESCE(EXCLUDED.country_name,  ip_intel.country_name),
                        asn           = COALESCE(EXCLUDED.asn,            ip_intel.asn),
                        asn_org       = COALESCE(EXCLUDED.asn_org,        ip_intel.asn_org),
                        city          = COALESCE(EXCLUDED.city,           ip_intel.city),
                        geo_checked_at  = GREATEST(EXCLUDED.geo_checked_at,  ip_intel.geo_checked_at),
                        abuse_score     = COALESCE(EXCLUDED.abuse_score,    ip_intel.abuse_score),
                        abuse_reports   = COALESCE(EXCLUDED.abuse_reports,  ip_intel.abuse_reports),
                        abuse_isp       = COALESCE(EXCLUDED.abuse_isp,      ip_intel.abuse_isp),
                        abuse_domain    = COALESCE(EXCLUDED.abuse_domain,   ip_intel.abuse_domain),
                        abuse_checked_at = GREATEST(EXCLUDED.abuse_checked_at, ip_intel.abuse_checked_at),
                        updated_at      = NOW()
                """), {
                    "ip":          ip,
                    "priv":        priv,
                    "country_iso": geo.get("country_iso"),
                    "country_name":geo.get("country_name"),
                    "asn":         geo.get("asn"),
                    "asn_org":     geo.get("asn_org"),
                    "city":        geo.get("city"),
                    "geo_done":    ip in geo_results,
                    "old_geo":     existing.get("geo_checked_at"),
                    "abuse_score": ab.get("abuse_score"),
                    "abuse_reports":ab.get("abuse_reports"),
                    "abuse_isp":   ab.get("abuse_isp"),
                    "abuse_domain":ab.get("abuse_domain"),
                    "abuse_done":  ip in abuse_results,
                    "old_abuse":   existing.get("abuse_checked_at"),
                })
            await db.commit()

    # Return fresh intel from DB
    return await get_intel(ips)
