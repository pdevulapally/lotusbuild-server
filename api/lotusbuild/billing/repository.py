"""Stripe customer links, checkout idempotency, and webhook claims."""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from lotusbuild.entitlements.service import SUBSCRIPTIONS_COLLECTION_PATH
from lotusbuild.errors import AppError
from lotusbuild.firestore_util import SERVER_TIMESTAMP, document_data, from_date, from_millis, run_transaction
from lotusbuild.support.documents import string_field, timestamp_field
from lotusbuild.users.repository import USERS_COLLECTION_PATH

STRIPE_CUSTOMERS_COLLECTION_PATH = "stripeCustomers"
PROCESSING_LEASE = timedelta(minutes=5)


def _busy() -> AppError:
    return AppError(code="billing/processing", status_code=503, message="A billing operation is still processing. Retry shortly.")


@dataclass(frozen=True)
class CheckoutOperation:
    id: str
    plan_key: str
    price_id: str
    expires_at: int


class BillingRepository:
    def __init__(self, firestore: Any, cache: Any, event_retention_seconds: int) -> None:
        if not isinstance(event_retention_seconds, int) or event_retention_seconds <= 0:
            raise ValueError("The webhook replay window must be a positive number of seconds.")
        self._firestore = firestore
        self._cache = cache
        self._event_retention_seconds = event_retention_seconds

    async def claim_event(self, event_id: str) -> dict[str, str]:
        ref = self._firestore.document(f"stripeEvents/{event_id}")
        token = str(uuid.uuid4())

        async def txn(tx: Any) -> dict[str, str]:
            snapshot = await ref.get(transaction=tx)
            if snapshot.exists:
                fields = document_data(snapshot)
                if fields.get("status") == "COMPLETED":
                    return {"kind": "completed"}
                if timestamp_field(fields, "leaseUntil", ref.path) > datetime.now(timezone.utc):
                    raise _busy()
            tx.set(ref, {"status": "PROCESSING", "token": token, "leaseUntil": from_date(datetime.now(timezone.utc) + PROCESSING_LEASE)})
            return {"kind": "claimed", "token": token}

        return await run_transaction(self._firestore, txn)

    async def complete_event(self, event_id: str, token: str) -> None:
        ref = self._firestore.document(f"stripeEvents/{event_id}")

        async def txn(tx: Any) -> None:
            snapshot = await ref.get(transaction=tx)
            fields = document_data(snapshot)
            if fields.get("token") != token or timestamp_field(fields, "leaseUntil", ref.path) <= datetime.now(timezone.utc):
                raise _busy()
            tx.set(ref, {
                "status": "COMPLETED",
                "completedAt": SERVER_TIMESTAMP,
                "expiresAt": from_date(datetime.now(timezone.utc) + timedelta(seconds=self._event_retention_seconds)),
            })

        await run_transaction(self._firestore, txn)

    async def release_event(self, event_id: str, token: str) -> None:
        ref = self._firestore.document(f"stripeEvents/{event_id}")

        async def txn(tx: Any) -> None:
            snapshot = await ref.get(transaction=tx)
            if document_data(snapshot).get("token") == token:
                tx.delete(ref)

        await run_transaction(self._firestore, txn)

    async def synchronize_subscription(self, uid: str, read) -> None:
        """Apply the customer's current Stripe subscription, never the event snapshot."""
        lock = self._firestore.document(f"billingSynchronization/{uid}")
        token = str(uuid.uuid4())

        async def claim(tx: Any) -> None:
            snapshot = await lock.get(transaction=tx)
            if snapshot.exists and timestamp_field(document_data(snapshot), "leaseUntil", lock.path) > datetime.now(timezone.utc):
                raise _busy()
            tx.set(lock, {"token": token, "leaseUntil": from_date(datetime.now(timezone.utc) + PROCESSING_LEASE)})

        await run_transaction(self._firestore, claim)
        try:
            state = await read()

            async def apply(tx: Any) -> None:
                snapshot = await lock.get(transaction=tx)
                fields = document_data(snapshot)
                if fields.get("token") != token or timestamp_field(fields, "leaseUntil", lock.path) <= datetime.now(timezone.utc):
                    raise _busy()
                ref = self._firestore.document(f"{SUBSCRIPTIONS_COLLECTION_PATH}/{uid}")
                if state is None:
                    tx.delete(ref)
                else:
                    tx.set(ref, {
                        "planKey": state.plan_key,
                        "status": state.status,
                        "stripeCustomerId": state.customer_id,
                        "currentPeriodStart": from_date(state.current_period_start),
                        "currentPeriodEnd": from_date(state.current_period_end),
                        "updatedAt": SERVER_TIMESTAMP,
                    })
                tx.delete(lock)

            await run_transaction(self._firestore, apply)
            await self._cache.invalidate(uid)
        except Exception as cause:
            try:
                async def cleanup(tx: Any) -> None:
                    snapshot = await lock.get(transaction=tx)
                    if document_data(snapshot).get("token") == token:
                        tx.delete(lock)

                await run_transaction(self._firestore, cleanup)
            except Exception as cleanup_error:
                raise ExceptionGroup("Subscription synchronization and lease cleanup failed.", [cause, cleanup_error]) from cause
            raise

    async def uid_for_customer(self, customer_id: str) -> str | None:
        ref = self._firestore.document(f"{STRIPE_CUSTOMERS_COLLECTION_PATH}/{customer_id}")
        snapshot = await ref.get()
        return string_field(document_data(snapshot), "uid", ref.path) if snapshot.exists else None

    async def link_customer(self, uid: str, customer_id: str) -> None:
        async def txn(tx: Any) -> None:
            child = await self._firestore.document(f"familyLinks/{uid}").get(transaction=tx)
            erasure = await self._firestore.document(f"accountErasures/{uid}").get(transaction=tx)
            if child.exists or erasure.exists:
                raise AppError(code="billing/account-restricted", status_code=403, message="This account cannot manage billing.")
            tx.set(self._firestore.document(f"{STRIPE_CUSTOMERS_COLLECTION_PATH}/{customer_id}"), {"uid": uid, "createdAt": SERVER_TIMESTAMP})
            tx.update(self._firestore.document(f"{USERS_COLLECTION_PATH}/{uid}"), {"stripeCustomerId": customer_id, "updatedAt": SERVER_TIMESTAMP})

        await run_transaction(self._firestore, txn)

    async def customer_id_for(self, uid: str) -> str | None:
        ref = self._firestore.document(f"{USERS_COLLECTION_PATH}/{uid}")
        snapshot = await ref.get()
        value = document_data(snapshot).get("stripeCustomerId")
        return value if isinstance(value, str) and value != "" else None

    async def checkout_operation(self, uid: str, plan_key: str, price_id: str) -> CheckoutOperation:
        ref = self._firestore.document(f"billingCheckouts/{uid}")

        async def txn(tx: Any) -> CheckoutOperation:
            snapshot = await ref.get(transaction=tx)
            if snapshot.exists:
                fields = document_data(snapshot)
                expires_at = timestamp_field(fields, "expiresAt", ref.path).timestamp()
                if expires_at > datetime.now(timezone.utc).timestamp():
                    stored_plan = string_field(fields, "planKey", ref.path)
                    if stored_plan != plan_key:
                        raise AppError(
                            code="billing/checkout-pending",
                            status_code=409,
                            message="A checkout for another plan is still open. Complete it or wait for it to expire.",
                        )
                    return CheckoutOperation(string_field(fields, "id", ref.path), stored_plan, string_field(fields, "priceId", ref.path), int(expires_at))
            operation = CheckoutOperation(str(uuid.uuid4()), plan_key, price_id, int(datetime.now(timezone.utc).timestamp()) + 3600)
            tx.set(ref, {"id": operation.id, "planKey": operation.plan_key, "priceId": operation.price_id, "expiresAt": from_millis(operation.expires_at * 1000)})
            return operation

        return await run_transaction(self._firestore, txn)
