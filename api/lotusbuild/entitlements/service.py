"""Resolves the effective entitlements for one user."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from lotusbuild.entitlements.merge import EntitlementContribution, resolve_capability
from lotusbuild.entitlements.schema import SUBSCRIPTION_STATUSES, MeterLimit, Plan, RateLimit, Registry
from lotusbuild.entitlements.subscription_cache import SubscriptionCache
from lotusbuild.entitlements.values import EntitlementConfigError, EntitlementValue
from lotusbuild.firestore_util import document_data
from lotusbuild.support.documents import DocumentShapeError, enum_field, string_field, timestamp_field

SUBSCRIPTIONS_COLLECTION_PATH = "subscriptions"


@dataclass(frozen=True)
class Subscription:
    plan_key: str
    status: str
    current_period_start: datetime
    current_period_end: datetime


def parse_subscription(fields: dict[str, Any], where: str) -> Subscription:
    start = timestamp_field(fields, "currentPeriodStart", where)
    end = timestamp_field(fields, "currentPeriodEnd", where)
    if end <= start:
        raise DocumentShapeError(f"{where}: currentPeriodEnd is not after currentPeriodStart.")
    return Subscription(
        plan_key=string_field(fields, "planKey", where),
        status=enum_field(fields, "status", where, SUBSCRIPTION_STATUSES),
        current_period_start=start,
        current_period_end=end,
    )


class ResolvedEntitlements:
    def __init__(self, values: dict[str, EntitlementValue]) -> None:
        self._values = values

    def _require(self, key: str, kind: str) -> EntitlementValue:
        value = self._values.get(key)
        if value is None:
            raise EntitlementConfigError(
                f'Capability "{key}" is not configured for this user\'s plan, so it cannot be evaluated.'
            )
        if value.kind != kind:
            raise EntitlementConfigError(
                f'Capability "{key}" resolved to a "{value.kind}" but was read as a "{kind}".'
            )
        return value

    def boolean(self, key: str) -> bool:
        value = self._require(key, "boolean").value
        assert isinstance(value, bool)
        return value

    def number(self, key: str) -> int | float:
        value = self._require(key, "number").value
        assert isinstance(value, (int, float)) and not isinstance(value, bool)
        return value

    def string(self, key: str) -> str:
        value = self._require(key, "string").value
        assert isinstance(value, str)
        return value

    def string_list(self, key: str) -> tuple[str, ...]:
        value = self._require(key, "stringList").value
        assert isinstance(value, tuple)
        return value

    def allows(self, key: str, candidate: str) -> bool:
        permitted = self.string_list(key)
        return len(permitted) == 0 or candidate in permitted

    def keys(self) -> list[str]:
        return list(self._values)

    def entries(self) -> list[dict[str, Any]]:
        return [{"key": key, "kind": value.kind, "value": list(value.value) if value.kind == "stringList" else value.value}
                for key, value in self._values.items()]


@dataclass(frozen=True)
class UserEntitlements:
    plan_key: str
    plan_name: str
    subscription_status: str | None
    capabilities: ResolvedEntitlements
    meter_limits: dict[str, MeterLimit]
    rate_limits: dict[str, RateLimit]


class EntitlementService:
    def __init__(self, firestore: Any, configuration: Any, cache: SubscriptionCache) -> None:
        self._firestore = firestore
        self._configuration = configuration
        self._cache = cache

    async def _subscription_for(self, uid: str, fresh: bool) -> Subscription | None:
        cached = None if fresh else await self._cache.read(uid)
        if cached is not None:
            return cached.subscription
        fill_token = None if fresh else await self._cache.begin_fill(uid)
        path = f"{SUBSCRIPTIONS_COLLECTION_PATH}/{uid}"
        snapshot = await self._firestore.document(path).get()
        subscription = parse_subscription(document_data(snapshot), path) if snapshot.exists else None
        if fill_token is not None:
            await self._cache.write(uid, subscription, fill_token)
        return subscription

    def _entitles(self, subscription: Subscription, registry: Registry, now: datetime) -> bool:
        return (
            subscription.status in registry.entitling_subscription_statuses
            and subscription.current_period_start <= now < subscription.current_period_end
        )

    async def _plan_for(self, uid: str, now: datetime, fresh: bool) -> tuple[Plan, str | None]:
        configuration = await self._configuration.get()
        registry: Registry = configuration.registry
        plans: dict[str, Plan] = configuration.plans
        path = f"{SUBSCRIPTIONS_COLLECTION_PATH}/{uid}"
        subscription = await self._subscription_for(uid, fresh)
        default_plan = plans.get(registry.default_plan_key)
        if default_plan is None:
            raise EntitlementConfigError(
                f'The default plan "{registry.default_plan_key}" is missing from the loaded configuration.'
            )
        if subscription is None:
            return default_plan, None
        if not self._entitles(subscription, registry, now):
            return default_plan, subscription.status
        plan = plans.get(subscription.plan_key)
        if plan is None:
            raise EntitlementConfigError(
                f'{path}: plan "{subscription.plan_key}" is not configured, so this subscription cannot be honoured.'
            )
        if plan.status != "ACTIVE":
            raise EntitlementConfigError(
                f'{path}: plan "{plan.key}" is {plan.status}, so it cannot entitle a live subscription.'
            )
        return plan, subscription.status

    async def for_user(self, uid: str, now: datetime | None = None, fresh: bool = False) -> UserEntitlements:
        if now is None:
            now = datetime.now(timezone.utc)
        elif now.tzinfo is None:
            now = now.replace(tzinfo=timezone.utc)
        configuration = await self._configuration.get()
        registry: Registry = configuration.registry
        plan, status = await self._plan_for(uid, now, fresh)
        plan_source = registry.entitlement_sources.get("plan")
        if plan_source is None:
            raise EntitlementConfigError(
                'The "plan" entitlement source is not declared, so a plan cannot contribute anything.'
            )
        resolved: dict[str, EntitlementValue] = {}
        for capability_key, value in plan.entitlements.items():
            capability = registry.capabilities.get(capability_key)
            if capability is None:
                raise EntitlementConfigError(
                    f'Plan "{plan.key}" grants "{capability_key}", which is not a declared capability.'
                )
            resolved[capability_key] = resolve_capability(capability, [
                EntitlementContribution(plan_source.key, plan_source.precedence, value),
            ])
        return UserEntitlements(
            plan_key=plan.key,
            plan_name=plan.name,
            subscription_status=status,
            capabilities=ResolvedEntitlements(resolved),
            meter_limits=plan.meter_limits,
            rate_limits=plan.rate_limits,
        )
