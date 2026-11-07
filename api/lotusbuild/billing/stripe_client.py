"""Stripe vocabulary translated into ours. The library pins the API version."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

import stripe

from lotusbuild.entitlements.schema import Plan
from lotusbuild.entitlements.values import EntitlementConfigError
from lotusbuild.errors import AppError

STATUS_TRANSLATION = {
    "trialing": "TRIALING",
    "active": "ACTIVE",
    "past_due": "PAST_DUE",
    "unpaid": "PAST_DUE",
    "canceled": "CANCELED",
    "paused": "CANCELED",
    "incomplete": "INCOMPLETE",
    "incomplete_expired": "CANCELED",
}
PLAN_KEY_METADATA_FIELD = "planKey"


def translate_status(status: str) -> str:
    translated = STATUS_TRANSLATION.get(status)
    if translated is None:
        raise AppError(
            code="billing/unknown-status",
            status_code=500,
            message=f'Stripe reported subscription status "{status}", which this service cannot read.',
            details={"status": status, "known": list(STATUS_TRANSLATION)},
        )
    return translated


@dataclass(frozen=True)
class StripeSubscriptionState:
    customer_id: str
    plan_key: str
    status: str
    current_period_start: datetime
    current_period_end: datetime


def _customer_id(subscription: Any) -> str:
    customer = subscription.customer
    customer_id = customer if isinstance(customer, str) else customer.id
    if customer_id == "":
        raise AppError(code="billing/malformed-subscription", status_code=500, message=f"Stripe subscription {subscription.id} has no customer.")
    return customer_id


def read_subscription(subscription: Any, plans: dict[str, Plan]) -> StripeSubscriptionState:
    items = subscription["items"]["data"] if isinstance(subscription, dict) else subscription.items.data
    if len(items) != 1:
        raise AppError(
            code="billing/unsupported-subscription",
            status_code=500,
            message=f"Stripe subscription {subscription.id} has {len(items)} items, and a subscription must carry exactly one plan.",
            details={"subscriptionId": subscription.id, "items": len(items)},
        )
    item = items[0]
    price = item["price"] if isinstance(item, dict) else item.price
    price_id = price["id"] if isinstance(price, dict) else price.id
    metadata = price["metadata"] if isinstance(price, dict) else price.metadata
    plan_key = metadata.get(PLAN_KEY_METADATA_FIELD) if metadata is not None else None
    if not plan_key:
        raise AppError(
            code="billing/unlabelled-price",
            status_code=500,
            message=f'Stripe price {price_id} carries no "{PLAN_KEY_METADATA_FIELD}", so what it sells cannot be told.',
            details={"priceId": price_id},
        )
    plan = plans.get(plan_key)
    if plan is None:
        raise AppError(
            code="billing/unknown-price",
            status_code=500,
            message=f"Stripe price {price_id} names no plan we configure.",
            details={"priceId": price_id, "planKey": plan_key, "configured": list(plans)},
        )
    start_seconds = item["current_period_start"] if isinstance(item, dict) else item.current_period_start
    end_seconds = item["current_period_end"] if isinstance(item, dict) else item.current_period_end
    start = datetime.fromtimestamp(start_seconds, tz=timezone.utc)
    end = datetime.fromtimestamp(end_seconds, tz=timezone.utc)
    if end <= start:
        raise AppError(
            code="billing/malformed-subscription",
            status_code=500,
            message=f"Stripe subscription {subscription.id} has no usable billing period.",
            details={"subscriptionId": subscription.id},
        )
    status = subscription["status"] if isinstance(subscription, dict) else subscription.status
    return StripeSubscriptionState(_customer_id(subscription), plan.key, translate_status(status), start, end)


def current_subscription(subscriptions: list[Any]) -> Any | None:
    current = []
    for subscription in subscriptions:
        status = subscription["status"] if isinstance(subscription, dict) else subscription.status
        translate_status(status)
        if status not in ("canceled", "incomplete_expired"):
            current.append(subscription)
    if len(current) > 1:
        raise AppError(
            code="billing/multiple-subscriptions",
            status_code=409,
            message="This account has multiple subscriptions. Contact support to reconcile billing.",
        )
    return current[0] if current else None


def lookup_key_for(plan: Plan) -> str:
    return f"lotusbuild_{plan.key}"


async def through_stripe(what: str, call, on_error) -> Any:
    try:
        return await call()
    except stripe.StripeError as cause:
        on_error(cause)
        raise AppError(
            code="billing/provider-unavailable",
            status_code=502,
            message=f"Stripe could not {what} right now. Try again shortly.",
            details={"operation": what, "type": getattr(cause, "type", None) or type(cause).__name__},
        ) from cause


def create_stripe(secret_key: str) -> stripe.StripeClient:
    return stripe.StripeClient(secret_key, max_network_retries=2)


async def ensure_price_id(client: Any, plan: Plan) -> str:
    """Publish the plan's current price in Stripe, reusing the lookup key when the amount matches."""
    import asyncio

    price = plan.price
    if price is None:
        raise EntitlementConfigError(f'Plan "{plan.key}" carries no price, so it cannot be sold.')
    lookup_key = lookup_key_for(plan)

    async def listed() -> Any:
        return await asyncio.to_thread(client.prices.list, {"lookup_keys": [lookup_key], "active": True, "limit": 1})

    existing = await through_stripe("look up a price", listed, lambda _error: None)
    current = existing.data[0] if existing.data else None
    recurring = None if current is None else current.recurring
    matches = (
        current is not None
        and current.unit_amount == price.amount_minor
        and current.currency == price.currency
        and recurring is not None
        and recurring.interval == price.interval
    )
    if matches:
        return current.id
    metadata = {PLAN_KEY_METADATA_FIELD: plan.key}
    product = None if current is None else (current.product if isinstance(current.product, str) else current.product.id)
    payload: dict[str, Any] = {
        "currency": price.currency,
        "unit_amount": price.amount_minor,
        "recurring": {"interval": price.interval},
        "lookup_key": lookup_key,
        "transfer_lookup_key": True,
        "metadata": metadata,
    }
    if product is None:
        payload["product_data"] = {"name": plan.name, "metadata": metadata}
    else:
        payload["product"] = product

    async def created() -> Any:
        return await asyncio.to_thread(client.prices.create, payload)

    published = await through_stripe("publish a price", created, lambda _error: None)
    return published.id
