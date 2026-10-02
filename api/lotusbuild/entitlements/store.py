"""Reads and validates registry and plans as one cached unit."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from lotusbuild.entitlements.schema import (
    Plan,
    Registry,
    assert_sandbox_allowances_are_usable,
    parse_plan,
    parse_registry,
)
from lotusbuild.firestore_util import document_data
from lotusbuild.support.cache import Cached, cached
from lotusbuild.support.documents import DocumentShapeError

REGISTRY_DOCUMENT_PATH = "config/registry"
PLANS_COLLECTION_PATH = "plans"


@dataclass(frozen=True)
class Configuration:
    registry: Registry
    plans: dict[str, Plan]


class ConfigurationStore:
    def __init__(self, firestore: Any, ttl_ms: float) -> None:
        self._entry: Cached[Configuration] = cached(ttl_ms, lambda: self._load(firestore))

    async def _load(self, firestore: Any) -> Configuration:
        registry_snapshot, plan_snapshots = await _gather(
            firestore.document(REGISTRY_DOCUMENT_PATH).get(),
            _collect(firestore.collection(PLANS_COLLECTION_PATH).stream()),
        )
        if not registry_snapshot.exists:
            raise DocumentShapeError(f"{REGISTRY_DOCUMENT_PATH} does not exist. The configuration has not been seeded.")
        registry = parse_registry(document_data(registry_snapshot), REGISTRY_DOCUMENT_PATH)
        plans: dict[str, Plan] = {}
        for snapshot in plan_snapshots:
            where = f"{PLANS_COLLECTION_PATH}/{snapshot.id}"
            plan = parse_plan(snapshot.to_dict() or {}, where, registry)
            if plan.key != snapshot.id:
                raise DocumentShapeError(f'{where}: the document id and its "key" field ("{plan.key}") disagree.')
            plans[plan.key] = plan
        if registry.default_plan_key not in plans:
            raise DocumentShapeError(
                f'{REGISTRY_DOCUMENT_PATH}: defaultPlanKey "{registry.default_plan_key}" names no plan, so '
                "a user without a subscription could not be entitled at all."
            )
        default_plan = plans[registry.default_plan_key]
        if default_plan.price is not None:
            raise DocumentShapeError(
                f"{PLANS_COLLECTION_PATH}/{default_plan.key}: the default plan carries a price, but the "
                "plan everybody already has cannot be sold."
            )
        assert_sandbox_allowances_are_usable(registry, list(plans.values()), registry.sandbox_time_meter_key)
        return Configuration(registry, plans)

    async def get(self) -> Configuration:
        return await self._entry.get()

    def invalidate(self) -> None:
        self._entry.invalidate()


async def _collect(stream: Any) -> list[Any]:
    return [item async for item in stream]


async def _gather(left: Any, right: Any) -> tuple[Any, Any]:
    return await left, await right
