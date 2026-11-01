"""UTC window start for a meter's reset period."""

from __future__ import annotations

from datetime import datetime, timezone

from lotusbuild.entitlements.schema import MeterDefinition


def period_start_for(meter: MeterDefinition, now: datetime) -> datetime:
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    now = now.astimezone(timezone.utc)
    if meter.reset_period == "NEVER":
        return datetime.fromtimestamp(0, tz=timezone.utc)
    if meter.reset_period == "DAILY":
        return datetime(now.year, now.month, now.day, tzinfo=timezone.utc)
    if meter.reset_period == "MONTHLY":
        return datetime(now.year, now.month, 1, tzinfo=timezone.utc)
    raise KeyError(meter.reset_period)
