"""CLI for Anthrimon licensing.

    python -m backend.licensing --print-machine-id   # the fingerprint to request a license for
    python -m backend.licensing --status             # current license status

Installed as `anthrimon-licensing` on hosts.
"""
from __future__ import annotations

import argparse
import json
import sys


def main() -> int:
    ap = argparse.ArgumentParser(prog="anthrimon-licensing")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--print-machine-id", action="store_true",
                   help="print this host's license fingerprint")
    g.add_argument("--status", action="store_true",
                   help="print current license status as JSON")
    args = ap.parse_args()

    if args.print_machine_id:
        from .fingerprint import machine_fingerprint
        print(machine_fingerprint())
        return 0

    if args.status:
        from . import license_info
        print(json.dumps(license_info().as_dict(), indent=2))
        return 0

    return 1


if __name__ == "__main__":
    sys.exit(main())
