from __future__ import annotations

import httpx
import structlog

logger = structlog.get_logger(__name__)
_ABUSE_URL = "https://api.abuseipdb.com/api/v2/check"


async def check_abuseipdb(ip: str, api_key: str) -> dict | None:
    """
    Check a single IP against AbuseIPDB.
    Returns {abuse_score, abuse_reports, abuse_isp, abuse_domain} or None on failure/rate-limit.
    Free tier: 1 000 checks/day. Cache results for 24 h.
    """
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(
                _ABUSE_URL,
                params={"ipAddress": ip, "maxAgeInDays": 90},
                headers={"Key": api_key, "Accept": "application/json"},
            )
        if resp.status_code == 429:
            logger.warning("abuseipdb_rate_limited", ip=ip)
            return None
        if resp.status_code == 402:
            logger.warning("abuseipdb_quota_exceeded")
            return None
        resp.raise_for_status()
        d = resp.json().get("data", {})
        return {
            "abuse_score":   int(d.get("abuseConfidenceScore", 0)),
            "abuse_reports": int(d.get("totalReports", 0)),
            "abuse_isp":     d.get("isp") or None,
            "abuse_domain":  d.get("domain") or None,
        }
    except Exception as exc:
        logger.error("abuseipdb_check_failed", ip=ip, error=str(exc))
        return None
