"""Copies bytes between a browser and one sandbox desktop. It does not parse the stream."""

from __future__ import annotations

import asyncio
import logging
import re
import time
from typing import Any

from starlette.websockets import WebSocket

from lotusbuild.errors import AppError, safe_error_diagnostic
from lotusbuild.redis_client import DESKTOP_HANDOFF_PREFIX

DESKTOP_PORT = 6080
DESKTOP_SUBPROTOCOL = "binary"
TRAFFIC_TOKEN_HEADER = "e2b-traffic-access-token"
CLIENT_MAX_PAYLOAD = 64 * 1024
CLOSE_CODES = {
    "desktop-ended": 1000,
    "server-shutdown": 1001,
    "protocol-abuse": 4400,
    "ticket-invalid": 4401,
    "origin-not-allowed": 4403,
    "session-not-found": 4404,
    "no-desktop": 4409,
    "max-lifetime": 4410,
    "slow-consumer": 4413,
    "capacity-reached": 4429,
    "relay-error": 4500,
}
log = logging.getLogger("lotusbuild.desktop")


class DesktopRelay:
    def __init__(self, deps: Any, options: Any) -> None:
        for name in (
            "max_connections", "max_connections_per_user", "max_viewers_per_session",
            "stream_max_seconds", "ping_seconds", "buffer_max_bytes", "client_max_bytes_per_second",
        ):
            value = getattr(options, name)
            if not isinstance(value, int) or value <= 0:
                raise ValueError(f"Desktop relay option {name} must be a positive integer.")
        if options.upstream_domain == "":
            raise ValueError("Desktop relay needs the domain sandbox hosts belong to.")
        self._deps = deps
        self._options = options
        self._host_pattern = re.compile(
            rf"^{DESKTOP_PORT}-[a-z0-9]{{10,40}}\.{re.escape(options.upstream_domain)}$"
        )
        self._open = 0
        self._per_user: dict[str, int] = {}
        self._per_session: dict[str, int] = {}

    def has_capacity(self, uid: str, session_id: str) -> bool:
        return (
            self._open < self._options.max_connections
            and self._per_user.get(uid, 0) < self._options.max_connections_per_user
            and self._per_session.get(session_id, 0) < self._options.max_viewers_per_session
        )

    def _reserve(self, uid: str, session_id: str):
        if not self.has_capacity(uid, session_id):
            return None
        self._open += 1
        self._per_user[uid] = self._per_user.get(uid, 0) + 1
        self._per_session[session_id] = self._per_session.get(session_id, 0) + 1
        released = False

        def release() -> None:
            nonlocal released
            if released:
                return
            released = True
            self._open -= 1
            for store, key in ((self._per_user, uid), (self._per_session, session_id)):
                remaining = store.get(key, 1) - 1
                if remaining <= 0:
                    store.pop(key, None)
                else:
                    store[key] = remaining

        return release

    async def serve(self, socket: WebSocket, *, session_id: str, origin: str | None, ticket: str | None) -> None:
        subprotocol = DESKTOP_SUBPROTOCOL if DESKTOP_SUBPROTOCOL in (socket.headers.get("sec-websocket-protocol") or "").split(",") else None
        await socket.accept(subprotocol=subprotocol.strip() if isinstance(subprotocol, str) else None)
        release = None
        try:
            if subprotocol is None:
                await socket.close(CLOSE_CODES["protocol-abuse"], "protocol-abuse")
                return
            if origin is None or origin not in self._options.allowed_origins:
                await socket.close(CLOSE_CODES["origin-not-allowed"], "origin-not-allowed")
                return
            grant = None if ticket is None else await self._deps.tickets.consume(ticket)
            if grant is None or grant.session_id != session_id:
                await socket.close(CLOSE_CODES["ticket-invalid"], "ticket-invalid")
                return
            try:
                await self._deps.sessions.read_owned(grant.uid, session_id)
            except AppError as error:
                code = "session-not-found" if error.code == "session/not-found" else "relay-error"
                await socket.close(CLOSE_CODES[code], code)
                return
            release = self._reserve(grant.uid, session_id)
            if release is None:
                await socket.close(CLOSE_CODES["capacity-reached"], "capacity-reached")
                return
            raw = await self._deps.redis.get(f"{DESKTOP_HANDOFF_PREFIX}{session_id}")
            if raw is None:
                await socket.close(CLOSE_CODES["no-desktop"], "no-desktop")
                return
            import json
            parsed = json.loads(raw.decode() if isinstance(raw, bytes) else raw)
            host, token = parsed.get("host"), parsed.get("token")
            if not isinstance(host, str) or not isinstance(token, str) or not self._host_pattern.fullmatch(host):
                log.error("desktop handoff host is outside the sandbox domain %s", session_id)
                await socket.close(CLOSE_CODES["relay-error"], "relay-error")
                return
            await self._pipe(socket, host, token, session_id)
        except Exception as cause:
            log.error("desktop relay failed %s", safe_error_diagnostic(cause))
            try:
                await socket.close(CLOSE_CODES["relay-error"], "relay-error")
            except Exception:
                return
        finally:
            if release is not None:
                release()

    async def _pipe(self, socket: WebSocket, host: str, token: str, session_id: str) -> None:
        import websockets

        deadline = time.monotonic() + self._options.stream_max_seconds
        window_start = time.monotonic()
        window_bytes = 0
        async with websockets.connect(
            f"wss://{host}/websockify",
            subprotocols=[DESKTOP_SUBPROTOCOL],
            additional_headers={TRAFFIC_TOKEN_HEADER: token},
            open_timeout=10,
            max_size=8 * 1024 * 1024,
        ) as upstream:
            async def client_to_upstream() -> None:
                nonlocal window_start, window_bytes
                while True:
                    message = await socket.receive()
                    if message["type"] == "websocket.disconnect":
                        return
                    data = message.get("bytes") or (message.get("text") or "").encode()
                    now = time.monotonic()
                    if now - window_start >= 1:
                        window_start = now
                        window_bytes = 0
                    window_bytes += len(data)
                    if len(data) > CLIENT_MAX_PAYLOAD or window_bytes > self._options.client_max_bytes_per_second:
                        raise AppError(code="desktop/protocol-abuse", status_code=4400, message="protocol-abuse")
                    await upstream.send(data)

            async def upstream_to_client() -> None:
                async for data in upstream:
                    payload = data if isinstance(data, bytes) else data.encode()
                    await socket.send_bytes(payload)

            async def watch() -> None:
                while time.monotonic() < deadline:
                    await asyncio.sleep(self._options.ping_seconds)
                    exists = await self._deps.redis.exists(f"{DESKTOP_HANDOFF_PREFIX}{session_id}")
                    if exists not in (1, True):
                        raise AppError(code="desktop/ended", status_code=1000, message="desktop-ended")
                raise AppError(code="desktop/max-lifetime", status_code=4410, message="max-lifetime")

            done, pending = await asyncio.wait(
                [asyncio.create_task(client_to_upstream()), asyncio.create_task(upstream_to_client()), asyncio.create_task(watch())],
                return_when=asyncio.FIRST_COMPLETED,
            )
            for task in pending:
                task.cancel()
            for task in done:
                error = task.exception()
                if isinstance(error, AppError) and error.message in CLOSE_CODES:
                    await socket.close(CLOSE_CODES[error.message], error.message)
                    return
            await socket.close(CLOSE_CODES["desktop-ended"], "desktop-ended")
