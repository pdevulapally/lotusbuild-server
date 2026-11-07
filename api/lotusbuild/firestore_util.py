"""Shared Firestore sentinels and transaction helper."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from datetime import datetime, timezone
from typing import Any

from google.cloud.firestore_v1 import DELETE_FIELD, SERVER_TIMESTAMP, Increment
from google.cloud.firestore_v1.async_transaction import async_transactional
from google.cloud.firestore_v1.field_path import FieldPath

__all__ = [
    "DELETE_FIELD",
    "SERVER_TIMESTAMP",
    "Increment",
    "FieldPath",
    "run_transaction",
    "from_date",
    "from_millis",
    "document_data",
]


def from_date(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def from_millis(millis: float) -> datetime:
    return datetime.fromtimestamp(millis / 1000, tz=timezone.utc)


def document_data(snapshot: Any) -> dict[str, Any]:
    data = snapshot.to_dict() if snapshot is not None and snapshot.exists else None
    return data or {}


async def run_transaction(client: Any, callback: Callable[[Any], Awaitable[Any]]) -> Any:
    transaction = client.transaction()

    @async_transactional
    async def _run(transaction: Any) -> Any:
        return await callback(transaction)

    return await _run(transaction)
