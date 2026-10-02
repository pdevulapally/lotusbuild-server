"""Holds one value for a TTL. Concurrent misses share one load."""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from typing import Awaitable, Callable, Generic, TypeVar

T = TypeVar("T")


@dataclass
class _Held(Generic[T]):
    held: T
    expires_at: float


class Cached(Generic[T]):
    def __init__(self, ttl_ms: float, load: Callable[[], Awaitable[T]]) -> None:
        if ttl_ms != ttl_ms or ttl_ms <= 0:
            raise ValueError(f"A cache TTL must be a positive number of milliseconds, got {ttl_ms}.")
        self._ttl_ms = ttl_ms
        self._load = load
        self._value: _Held[T] | None = None
        self._in_flight: asyncio.Task[T] | None = None
        self._lock = asyncio.Lock()

    async def get(self) -> T:
        now = time.time() * 1000
        if self._value is not None and now < self._value.expires_at:
            return self._value.held
        async with self._lock:
            now = time.time() * 1000
            if self._value is not None and now < self._value.expires_at:
                return self._value.held
            if self._in_flight is not None:
                task = self._in_flight
            else:
                task = asyncio.create_task(self._load())
                self._in_flight = task
        try:
            loaded = await task
        finally:
            if self._in_flight is task:
                self._in_flight = None
        self._value = _Held(loaded, time.time() * 1000 + self._ttl_ms)
        return loaded

    def invalidate(self) -> None:
        self._value = None


def cached(ttl_ms: float, load: Callable[[], Awaitable[T]]) -> Cached[T]:
    return Cached(ttl_ms, load)
