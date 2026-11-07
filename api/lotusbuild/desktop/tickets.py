"""Single-use, short-lived tickets for the desktop WebSocket. Only a SHA-256 is stored."""

from __future__ import annotations

import hashlib
import json
import re
import secrets
from dataclasses import dataclass
from typing import Any

from lotusbuild.redis_client import DESKTOP_TICKET_PREFIX

DESKTOP_TICKET_TTL_SECONDS = 30
DESKTOP_TICKET_PATTERN = re.compile(r"^[A-Za-z0-9_-]{43}$")
CONSUME_SCRIPT = "local v = redis.call('GET', KEYS[1]); if v then redis.call('DEL', KEYS[1]) end; return v"


@dataclass(frozen=True)
class DesktopGrant:
    uid: str
    session_id: str


def _key(ticket: str) -> str:
    return f"{DESKTOP_TICKET_PREFIX}{hashlib.sha256(ticket.encode()).hexdigest()}"


class DesktopTickets:
    def __init__(self, redis: Any) -> None:
        self._redis = redis

    async def issue(self, grant: DesktopGrant) -> str:
        ticket = secrets.token_urlsafe(32)
        stored = await self._redis.set(_key(ticket), json.dumps({"uid": grant.uid, "sessionId": grant.session_id}), ex=DESKTOP_TICKET_TTL_SECONDS, nx=True)
        if stored not in (True, "OK", b"OK"):
            raise RuntimeError("A desktop ticket could not be stored.")
        return ticket

    async def consume(self, ticket: str) -> DesktopGrant | None:
        if DESKTOP_TICKET_PATTERN.fullmatch(ticket) is None:
            return None
        raw = await self._redis.eval(CONSUME_SCRIPT, 1, _key(ticket))
        if not isinstance(raw, (str, bytes)):
            return None
        if isinstance(raw, bytes):
            raw = raw.decode()
        parsed = json.loads(raw)
        if not isinstance(parsed, dict) or not isinstance(parsed.get("uid"), str) or not isinstance(parsed.get("sessionId"), str):
            raise RuntimeError("Malformed desktop ticket.")
        return DesktopGrant(parsed["uid"], parsed["sessionId"])


def redact_desktop_ticket(url: str) -> str:
    return re.sub(r"([?&]ticket=)[^&#]*", r"\1[redacted]", url)
