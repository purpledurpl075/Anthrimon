"""Remote collector hub API — package root.

The full implementation lives in _main.py.  Future incremental splits:
  lifecycle.py  — CRUD, bootstrap, heartbeat, token, download
  builds.py     — binary build management
  control.py    — probe, sweep, update, refresh, trap-config
  ingest.py     — all POST data ingest endpoints
  _auth.py      — WireGuard + API-key auth helpers
  _shared.py    — shared constants, state, and utility functions
"""
from ._main import router, _discover_engine_id, _push_trap_config

__all__ = ["router", "_discover_engine_id", "_push_trap_config"]
