"""Public plan catalogue. Stripe price ids and rate limits stay off this response."""

from __future__ import annotations

from typing import Any

from lotusbuild.support.cache import Cached, cached


def plan_catalogue(configuration: Any, ttl_ms: int) -> Cached[list[dict[str, Any]]]:
    async def load() -> list[dict[str, Any]]:
        loaded = await configuration.get()
        plans = []
        for plan in sorted((plan for plan in loaded.plans.values() if plan.status == "ACTIVE"), key=lambda item: item.rank):
            capabilities = []
            for key, entitlement in plan.entitlements.items():
                definition = loaded.registry.capabilities.get(key)
                if definition is None:
                    continue
                value = list(entitlement.value) if entitlement.kind == "stringList" else entitlement.value
                capabilities.append({"key": key, "label": definition.label, "kind": entitlement.kind, "value": value})
            allowances = []
            for key, limit in plan.meter_limits.items():
                meter = loaded.registry.meters.get(key)
                if meter is None:
                    continue
                allowances.append({
                    "key": key,
                    "label": meter.label,
                    "unit": meter.unit,
                    "included": limit.included_allowance,
                    "limit": limit.hard_limit,
                })
            price = None if plan.price is None else {
                "amountMinor": plan.price.amount_minor,
                "currency": plan.price.currency,
                "interval": plan.price.interval,
            }
            plans.append({
                "key": plan.key,
                "name": plan.name,
                "rank": plan.rank,
                "price": price,
                "capabilities": capabilities,
                "allowances": allowances,
            })
        return plans

    return cached(ttl_ms, load)
