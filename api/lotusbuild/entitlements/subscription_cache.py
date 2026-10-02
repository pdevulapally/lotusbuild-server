"""Short-lived cache of each user's subscription lookup, including confirmed absence."""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from lotusbuild.entitlements.schema import SUBSCRIPTION_STATUSES
from lotusbuild.redis_client import SUBSCRIPTION_PREFIX

FILL_PREFIX = "filling:"
COMPLETE_FILL = """
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
return 1
"""


@dataclass(frozen=True)
class CachedSubscription:
    subscription: Any


class SubscriptionCache:
    def __init__(self, redis: Any, ttl_seconds: int) -> None:
        if not isinstance(ttl_seconds, int) or isinstance(ttl_seconds, bool) or ttl_seconds <= 0:
            raise ValueError(f"The subscription cache TTL must be a positive integer, got {ttl_seconds}.")
        self._redis = redis
        self._ttl_seconds = ttl_seconds

    def _key(self, uid: str) -> str:
        return f"{SUBSCRIPTION_PREFIX}{uid}"

    async def read(self, uid: str) -> CachedSubscription | None:
        raw = await self._redis.get(self._key(uid))
        if raw is None or (isinstance(raw, str) and raw.startswith(FILL_PREFIX)):
            return None
        if isinstance(raw, bytes):
            raw = raw.decode()
        if raw == "none":
            return CachedSubscription(None)
        try:
            wire = json.loads(raw)
        except json.JSONDecodeError:
            await self._redis.delete(self._key(uid))
            return None
        start = _date(wire.get("currentPeriodStart") if isinstance(wire, dict) else None)
        end = _date(wire.get("currentPeriodEnd") if isinstance(wire, dict) else None)
        plan_key = wire.get("planKey") if isinstance(wire, dict) else None
        status = wire.get("status") if isinstance(wire, dict) else None
        if not isinstance(plan_key, str) or status not in SUBSCRIPTION_STATUSES or start is None or end is None:
            await self._redis.delete(self._key(uid))
            return None
        from lotusbuild.entitlements.service import Subscription

        return CachedSubscription(Subscription(plan_key, status, start, end))

    async def begin_fill(self, uid: str) -> str | None:
        token = f"{FILL_PREFIX}{uuid.uuid4()}"
        result = await self._redis.set(self._key(uid), token, ex=self._ttl_seconds, nx=True)
        if result not in (True, None, b"OK", "OK"):
            # redis-py returns True for NX success and None otherwise.
            if result is not True and result != "OK":
                if result is None:
                    return None
                raise RuntimeError("Unexpected subscription cache fill response.")
        return token if result in (True, "OK", b"OK") else None

    async def write(self, uid: str, subscription: Any, token: str) -> None:
        payload = "none" if subscription is None else json.dumps({
            "planKey": subscription.plan_key,
            "status": subscription.status,
            "currentPeriodStart": _iso(subscription.current_period_start),
            "currentPeriodEnd": _iso(subscription.current_period_end),
        })
        result = await self._redis.eval(COMPLETE_FILL, 1, self._key(uid), token, payload, str(self._ttl_seconds))
        if result not in (0, 1):
            raise RuntimeError("Unexpected subscription cache write response.")

    async def invalidate(self, uid: str) -> None:
        await self._redis.delete(self._key(uid))


def _date(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return None if parsed.timestamp() != parsed.timestamp() else parsed


def _iso(value: datetime) -> str:
    from lotusbuild.timeutil import to_iso
    return to_iso(value)
