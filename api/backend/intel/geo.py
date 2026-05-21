from __future__ import annotations

import httpx
import structlog

logger = structlog.get_logger(__name__)
_GEO_API = "http://ip-api.com/batch"


async def batch_geoip(ips: list[str]) -> dict[str, dict]:
    """
    Look up GeoIP for up to 100 public IPs via ip-api.com batch endpoint.
    Returns {ip: {country_iso, country_name, asn, asn_org, city}}.
    Rate limit: 45 req/min (free). Each call covers 100 IPs.
    """
    if not ips:
        return {}
    results: dict[str, dict] = {}
    for i in range(0, len(ips), 100):
        chunk = ips[i:i + 100]
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.post(
                    _GEO_API,
                    json=[{"query": ip, "fields": "status,query,countryCode,country,as,org,city"} for ip in chunk],
                )
            for item in resp.json():
                if item.get("status") != "success":
                    continue
                raw_as = item.get("as", "")
                results[item["query"]] = {
                    "country_iso":  item.get("countryCode") or None,
                    "country_name": item.get("country") or None,
                    "asn":          _parse_asn(raw_as),
                    "asn_org":      item.get("org") or raw_as or None,
                    "city":         item.get("city") or None,
                }
        except Exception as exc:
            logger.warning("geoip_batch_failed", error=str(exc), chunk_size=len(chunk))
    return results


def _parse_asn(s: str) -> int | None:
    """Parse 'AS12345 Some Org' → 12345."""
    if s and s.startswith("AS"):
        try:
            return int(s.split()[0][2:])
        except (ValueError, IndexError):
            pass
    return None
