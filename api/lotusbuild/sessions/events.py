"""Live session log: a Redis stream for history and pub/sub for what happens next."""

from __future__ import annotations

import asyncio
import json
import re
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from typing import Any

from lotusbuild.redis_client import SESSION_EVENTS_PREFIX

STREAM_ID = re.compile(r"^\d{1,20}-\d{1,20}$")


@dataclass(frozen=True)
class SessionEvent:
    id: str
    type: str
    data: dict[str, Any]


def parse_stream_id(value: object) -> str | None:
    return value if isinstance(value, str) and STREAM_ID.fullmatch(value) else None


def compare_stream_ids(left: str, right: str) -> int:
    left_ms, left_seq = (int(part) for part in left.split("-"))
    right_ms, right_seq = (int(part) for part in right.split("-"))
    difference = left_seq - right_seq if left_ms == right_ms else left_ms - right_ms
    return -1 if difference < 0 else 1 if difference > 0 else 0


def frame(event: SessionEvent) -> str:
    return f"id: {event.id}\nevent: {event.type}\ndata: {json.dumps(event.data, separators=(',', ':'))}\n\n"


def closing_frame(reason: str) -> str:
    return f"event: stream.closing\ndata: {json.dumps({'reason': reason}, separators=(',', ':'))}\n\n"


class SessionEvents:
    def __init__(self, redis: Any, subscriber: Any, *, max_event_bytes: int, retention_seconds: int, max_per_session: int, on_listener_error: Callable[[BaseException, str], None]) -> None:
        if max_event_bytes <= 0 or retention_seconds <= 0 or max_per_session <= 0:
            raise ValueError("Invalid session event limits.")
        self._redis = redis
        self._subscriber = subscriber
        self._max_event_bytes = max_event_bytes
        self._retention_seconds = retention_seconds
        self._max_per_session = max_per_session
        self._on_listener_error = on_listener_error
        self._listeners: dict[str, set[Callable[[SessionEvent], None]]] = {}

    def _key(self, session_id: str) -> str:
        return f"{SESSION_EVENTS_PREFIX}{session_id}"

    async def append(self, session_id: str, event_type: str, data: dict[str, Any]) -> SessionEvent:
        key = self._key(session_id)
        serialized = json.dumps(data, separators=(",", ":"))
        if len(serialized.encode()) + len(event_type.encode()) + 100 > self._max_event_bytes:
            raise RuntimeError("Event exceeds the configured byte budget; its authoritative data remains in Firestore.")
        event_id = await self._redis.xadd(key, {"type": event_type, "data": serialized}, maxlen=self._max_per_session, approximate=True)
        if event_id is None:
            raise RuntimeError(f'Redis refused to append a "{event_type}" event to session {session_id}.')
        if isinstance(event_id, bytes):
            event_id = event_id.decode()
        event = SessionEvent(event_id, event_type, data)
        async with self._redis.pipeline(transaction=False) as pipe:
            pipe.expire(key, self._retention_seconds)
            pipe.publish(key, json.dumps({"id": event.id, "type": event.type, "data": event.data}, separators=(",", ":")))
            await pipe.execute()
        return event

    def _parse_entry(self, event_id: str, fields: Any) -> SessionEvent:
        if isinstance(fields, dict):
            pairs = fields
        else:
            pairs = {}
            values = list(fields)
            if not parse_stream_id(event_id) or len(values) % 2 != 0:
                raise RuntimeError("Invalid or oversized stored event.")
            for index in range(0, len(values), 2):
                key = values[index].decode() if isinstance(values[index], bytes) else values[index]
                raw = values[index + 1]
                pairs[key] = raw.decode() if isinstance(raw, bytes) else raw
        event_type = pairs.get("type")
        serialized = pairs.get("data")
        if isinstance(event_type, bytes):
            event_type = event_type.decode()
        if isinstance(serialized, bytes):
            serialized = serialized.decode()
        if not isinstance(event_type, str) or not isinstance(serialized, str):
            raise RuntimeError("Malformed session event.")
        payload = json.loads(serialized)
        if not isinstance(payload, dict):
            raise RuntimeError("Invalid event data.")
        return SessionEvent(event_id if isinstance(event_id, str) else event_id.decode(), event_type, payload)

    async def replay(self, session_id: str, after_id: str | None) -> AsyncIterator[SessionEvent]:
        cursor = after_id
        key = self._key(session_id)
        for _count in range(self._max_per_session):
            start = "-" if cursor is None else f"({cursor}"
            entries = await self._redis.xrange(key, min=start, max="+", count=1)
            if not entries:
                return
            event_id, fields = entries[0]
            if isinstance(event_id, bytes):
                event_id = event_id.decode()
            event = self._parse_entry(event_id, fields)
            yield event
            cursor = event.id
        remaining = await self._redis.xrange(key, min=f"({cursor}", max="+", count=1)
        if remaining:
            raise RuntimeError("Replay page exhausted; reconnect using the last received event ID.")

    async def subscribe(self, session_id: str, listener: Callable[[SessionEvent], None]) -> Callable[[], None]:
        key = self._key(session_id)
        await self._subscriber.subscribe(key)
        listeners = self._listeners.setdefault(key, set())
        listeners.add(listener)
        released = False

        def release() -> None:
            nonlocal released
            if released:
                return
            released = True
            current = self._listeners.get(key)
            if current is None:
                return
            current.discard(listener)
            if current:
                return
            self._listeners.pop(key, None)

            async def unsubscribe() -> None:
                try:
                    await self._subscriber.unsubscribe(key)
                except Exception as cause:
                    self._on_listener_error(cause, session_id)

            try:
                asyncio.get_running_loop().create_task(unsubscribe())
            except RuntimeError:
                return

        return release

    async def listen(self) -> None:
        """Fan pub/sub messages out to the in-process listeners. One task for the process."""
        while True:
            try:
                async for message in self._subscriber.listen():
                    if not isinstance(message, dict) or message.get("type") != "message":
                        continue
                    channel = message.get("channel")
                    payload = message.get("data")
                    if isinstance(channel, bytes):
                        channel = channel.decode()
                    if isinstance(payload, bytes):
                        payload = payload.decode()
                    if isinstance(channel, str) and isinstance(payload, str):
                        self.deliver(channel, payload)
            except asyncio.CancelledError:
                raise
            except Exception as cause:
                self._on_listener_error(cause if isinstance(cause, Exception) else RuntimeError(str(cause)), "subscriber")
                await asyncio.sleep(1)

    def deliver(self, channel: str, payload: str) -> None:
        listeners = self._listeners.get(channel)
        if not listeners:
            return
        session_id = channel[len(SESSION_EVENTS_PREFIX):]
        try:
            if len(payload.encode()) > self._max_event_bytes:
                raise RuntimeError("Oversized live event.")
            parsed = json.loads(payload)
            if not isinstance(parsed, dict) or not parse_stream_id(parsed.get("id")) or not isinstance(parsed.get("type"), str) or not isinstance(parsed.get("data"), dict):
                raise RuntimeError("Invalid live event.")
            event = SessionEvent(parsed["id"], parsed["type"], parsed["data"])
        except Exception as cause:
            self._on_listener_error(cause if isinstance(cause, Exception) else RuntimeError(str(cause)), session_id)
            return
        for listener in list(listeners):
            try:
                listener(event)
            except Exception as cause:
                self._on_listener_error(cause, session_id)
