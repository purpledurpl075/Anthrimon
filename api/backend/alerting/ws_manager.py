"""In-process registry of /alerts/ws connections, grouped by tenant.

The alert engine and API share one process/event loop, so a simple
in-memory registry is sufficient — no Redis or external pub/sub needed.
"""
from __future__ import annotations

import uuid

import structlog
from fastapi import WebSocket

logger = structlog.get_logger(__name__)


class AlertWSManager:
    def __init__(self) -> None:
        self._connections: dict[uuid.UUID, set[WebSocket]] = {}

    def connect(self, tenant_id: uuid.UUID, ws: WebSocket) -> None:
        self._connections.setdefault(tenant_id, set()).add(ws)

    def disconnect(self, tenant_id: uuid.UUID, ws: WebSocket) -> None:
        conns = self._connections.get(tenant_id)
        if conns is not None:
            conns.discard(ws)
            if not conns:
                del self._connections[tenant_id]

    async def broadcast(self, tenant_id: uuid.UUID, message: dict) -> None:
        conns = self._connections.get(tenant_id)
        if not conns:
            return
        dead = []
        for ws in conns:
            try:
                await ws.send_json(message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            conns.discard(ws)


manager = AlertWSManager()
