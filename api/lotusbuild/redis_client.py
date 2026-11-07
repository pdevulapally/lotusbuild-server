"""Redis connection that fails closed, and the key prefixes both processes share."""

from __future__ import annotations

from typing import Any

from redis.asyncio import Redis

from lotusbuild.errors import EnvironmentError

RATE_LIMIT_PREFIX = "rl:"
SUBSCRIPTION_PREFIX = "sub:"
SESSION_EVENTS_PREFIX = "ev:"
STRIPE_EVENT_PREFIX = "evt:"
DESKTOP_TICKET_PREFIX = "dkt:"
DESKTOP_HANDOFF_PREFIX = "dkh:"


async def connect_redis(config: Any, on_error, connection_name: str) -> Redis:
    redis = Redis.from_url(
        str(config.REDIS_URL),
        socket_connect_timeout=5,
        socket_timeout=5,
        retry_on_error=[],
        health_check_interval=0,
        client_name=connection_name,
    )
    try:
        await redis.ping()
    except Exception as cause:
        on_error(RuntimeError("REDIS_URL connection error."))
        await redis.aclose()
        raise EnvironmentError([
            "REDIS_URL could not establish a connection; check reachability and authentication.",
        ]) from cause
    try:
        pong = await redis.ping()
    except Exception as cause:
        await redis.aclose()
        raise EnvironmentError(["REDIS_URL readiness check failed."]) from cause
    if pong is not True and pong != b"PONG" and pong != "PONG":
        await redis.aclose()
        raise EnvironmentError(["REDIS_URL returned an unexpected PING response."])
    return redis
