"""Records what a user has spent against their plan's meters."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable

from lotusbuild.entitlements.schema import MeterDefinition, MeterLimit
from lotusbuild.entitlements.service import UserEntitlements
from lotusbuild.entitlements.values import EntitlementConfigError
from lotusbuild.errors import AppError, is_safe_integer
from lotusbuild.firestore_util import SERVER_TIMESTAMP, document_data, from_date, run_transaction
from lotusbuild.metering.periods import period_start_for
from lotusbuild.support.documents import enum_field, integer_field, string_field, timestamp_field
from lotusbuild.timeutil import to_iso
from lotusbuild.users.repository import USERS_COLLECTION_PATH

USAGE_COLLECTION_NAME = "usage"
RESERVATIONS_COLLECTION_NAME = "reservations"
RESERVATION_STATUSES = ("OPEN", "SETTLED", "RELEASED")
EXCEEDED_STATUS = {"COUNTER": 402, "GAUGE": 409}


@dataclass(frozen=True)
class Consumption:
    meter_key: str
    consumed: int
    period_start: datetime


@dataclass(frozen=True)
class Reservation:
    id: str
    meter_key: str
    estimated_quantity: int
    status: str
    operation_id: str


@dataclass(frozen=True)
class MeterUsageSummary:
    meter_key: str
    unit: str
    label: str
    kind: str
    reset_period: str
    consumed: int
    reserved: int
    included_allowance: int
    hard_limit: int
    overage_enabled: bool
    period_start: datetime


@dataclass(frozen=True)
class _UsageState:
    consumed: int
    reserved: int


@dataclass(frozen=True)
class _CloseOutcome:
    status: str
    settled_quantity: int | None = None
    overrun_quantity: int | None = None


def _ms(value: datetime) -> int:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return int(value.timestamp() * 1000)


class MeteringService:
    def __init__(self, firestore: Any, configuration: Any) -> None:
        self._firestore = firestore
        self._configuration = configuration

    def _usage_ref(self, uid: str, meter_key: str) -> Any:
        return self._firestore.document(f"{USERS_COLLECTION_PATH}/{uid}/{USAGE_COLLECTION_NAME}/{meter_key}")

    def _reservation_ref(self, uid: str, reservation_id: str) -> Any:
        return self._firestore.document(
            f"{USERS_COLLECTION_PATH}/{uid}/{RESERVATIONS_COLLECTION_NAME}/{reservation_id}"
        )

    async def _resolve(self, entitlements: UserEntitlements, meter_key: str) -> tuple[MeterDefinition, MeterLimit]:
        registry = (await self._configuration.get()).registry
        meter = registry.meters.get(meter_key)
        if meter is None:
            raise EntitlementConfigError(f'Meter "{meter_key}" is not declared in the registry, so it cannot be charged.')
        limit = entitlements.meter_limits.get(meter_key)
        if limit is None:
            raise EntitlementConfigError(
                f'Plan "{entitlements.plan_key}" declares no limit for "{meter.key}", so it would be spent unmetered.'
            )
        return meter, limit

    def _state(self, snapshot: Any, period_start: datetime, path: str) -> _UsageState:
        if not snapshot.exists:
            return _UsageState(0, 0)
        fields = document_data(snapshot)
        stored = timestamp_field(fields, "periodStart", path)
        consumed = integer_field(fields, "consumed", path, min_value=0) if _ms(stored) == _ms(period_start) else 0
        return _UsageState(consumed, integer_field(fields, "reserved", path, min_value=0))

    def _exceeded(
        self,
        entitlements: UserEntitlements,
        meter: MeterDefinition,
        limit: MeterLimit,
        state: _UsageState,
        requested: int,
        period_start: datetime,
    ) -> AppError:
        return AppError(
            code="usage/limit-reached",
            status_code=EXCEEDED_STATUS[meter.kind],
            message=(
                f"The {entitlements.plan_name} plan allows {limit.hard_limit} {meter.unit} of "
                f"{meter.label}, and {state.consumed + state.reserved} {meter.unit} of that is already used or held."
            ),
            details={
                "meterKey": meter.key,
                "unit": meter.unit,
                "label": meter.label,
                "kind": meter.kind,
                "limit": limit.hard_limit,
                "consumed": state.consumed,
                "reserved": state.reserved,
                "requested": requested,
                "resetPeriod": meter.reset_period,
                "periodStart": to_iso(period_start),
                "plan": entitlements.plan_key,
            },
        )

    def _assert_positive(self, quantity: int, meter_key: str) -> None:
        if not is_safe_integer(quantity) or int(quantity) <= 0:
            raise ValueError(f'A metered quantity must be a positive integer, got {quantity} for "{meter_key}".')

    def _write_usage(self, transaction: Any, ref: Any, meter: MeterDefinition, consumed: int, reserved: int, period_start: datetime) -> None:
        transaction.set(ref, {
            "meterKey": meter.key,
            "consumed": consumed,
            "reserved": reserved,
            "periodStart": from_date(period_start),
            "updatedAt": SERVER_TIMESTAMP,
        })

    async def consume_in(self, transaction: Any, *, uid: str, entitlements: UserEntitlements, meter_key: str, quantity: int, now: datetime) -> Consumption:
        self._assert_positive(quantity, meter_key)
        meter, limit = await self._resolve(entitlements, meter_key)
        if meter.kind != "COUNTER":
            raise EntitlementConfigError(
                f'Meter "{meter.key}" is a {meter.kind}, which is held and released rather than consumed. Charging it would never be given back.'
            )
        ref = self._usage_ref(uid, meter_key)
        snapshot = await ref.get(transaction=transaction)
        period_start = period_start_for(meter, now)
        state = self._state(snapshot, period_start, ref.path)
        after = state.consumed + quantity
        if after + state.reserved > limit.hard_limit:
            raise self._exceeded(entitlements, meter, limit, state, quantity, period_start)
        self._write_usage(transaction, ref, meter, after, state.reserved, period_start)
        return Consumption(meter.key, after, period_start)

    async def refund_in(
        self, transaction: Any, *, uid: str, entitlements: UserEntitlements, meter_key: str,
        quantity: int, charged_at: datetime, now: datetime,
    ) -> Consumption:
        self._assert_positive(quantity, meter_key)
        meter, _limit = await self._resolve(entitlements, meter_key)
        if meter.kind != "COUNTER":
            raise EntitlementConfigError(f'Meter "{meter.key}" is a {meter.kind}, which is released rather than refunded.')
        ref = self._usage_ref(uid, meter_key)
        snapshot = await ref.get(transaction=transaction)
        period_start = period_start_for(meter, now)
        state = self._state(snapshot, period_start, ref.path)
        same_window = _ms(period_start_for(meter, charged_at)) == _ms(period_start)
        after = max(0, state.consumed - quantity) if same_window else state.consumed
        self._write_usage(transaction, ref, meter, after, state.reserved, period_start)
        return Consumption(meter.key, after, period_start)

    async def read_usage_breakdown(self, uid: str, entitlements: UserEntitlements, now: datetime | None = None) -> list[MeterUsageSummary]:
        if now is None:
            now = datetime.now(timezone.utc)
        registry = (await self._configuration.get()).registry
        summaries: list[MeterUsageSummary] = []
        for meter_key, meter in registry.meters.items():
            limit = entitlements.meter_limits.get(meter_key)
            if limit is None:
                continue
            ref = self._usage_ref(uid, meter_key)
            snapshot = await ref.get()
            period_start = period_start_for(meter, now)
            state = self._state(snapshot, period_start, ref.path)
            summaries.append(MeterUsageSummary(
                meter.key, meter.unit, meter.label, meter.kind, meter.reset_period,
                state.consumed, state.reserved, limit.included_allowance, limit.hard_limit,
                limit.overage_enabled, period_start,
            ))
        return summaries

    async def set_gauge_in(
        self, transaction: Any, *, uid: str, entitlements: UserEntitlements, meter_key: str,
        previous_quantity: int, quantity: int, now: datetime,
    ) -> int:
        for name, value in (("previousQuantity", previous_quantity), ("quantity", quantity)):
            if not is_safe_integer(value) or int(value) < 0:
                raise ValueError(f'A gauge {name} must be a non-negative integer, got {value} for "{meter_key}".')
        meter, limit = await self._resolve(entitlements, meter_key)
        if meter.kind != "GAUGE":
            raise EntitlementConfigError(
                f'Meter "{meter.key}" is a {meter.kind}, which is spent rather than occupied. Setting it would silently discard what has already been charged to it.'
            )
        ref = self._usage_ref(uid, meter_key)
        snapshot = await ref.get(transaction=transaction)
        period_start = period_start_for(meter, now)
        state = self._state(snapshot, period_start, ref.path)
        total = state.consumed - previous_quantity + quantity
        if total < 0:
            raise RuntimeError(
                f"Usage for {uid}/{meter.key} reads {state.consumed} but a contributor claims to have held {previous_quantity}."
            )
        if quantity > previous_quantity and total + state.reserved > limit.hard_limit:
            raise self._exceeded(entitlements, meter, limit, state, quantity, period_start)
        self._write_usage(transaction, ref, meter, total, state.reserved, period_start)
        return total

    async def set_gauge(self, **kwargs: Any) -> int:
        return await run_transaction(self._firestore, lambda transaction: self.set_gauge_in(transaction, **kwargs))

    async def consume(self, **kwargs: Any) -> Consumption:
        return await run_transaction(self._firestore, lambda transaction: self.consume_in(transaction, **kwargs))

    async def reserve_in(
        self, transaction: Any, *, uid: str, entitlements: UserEntitlements, meter_key: str,
        quantity: int, operation_id: str, now: datetime,
    ) -> Reservation:
        self._assert_positive(quantity, meter_key)
        meter, limit = await self._resolve(entitlements, meter_key)
        usage_ref = self._usage_ref(uid, meter_key)
        reservation_ref = self._firestore.collection(
            f"{USERS_COLLECTION_PATH}/{uid}/{RESERVATIONS_COLLECTION_NAME}"
        ).document()
        snapshot = await usage_ref.get(transaction=transaction)
        period_start = period_start_for(meter, now)
        state = self._state(snapshot, period_start, usage_ref.path)
        if state.consumed + state.reserved + quantity > limit.hard_limit:
            raise self._exceeded(entitlements, meter, limit, state, quantity, period_start)
        self._write_usage(transaction, usage_ref, meter, state.consumed, state.reserved + quantity, period_start)
        transaction.create(reservation_ref, {
            "meterKey": meter.key,
            "estimatedQuantity": quantity,
            "status": "OPEN",
            "operationId": operation_id,
            "createdAt": SERVER_TIMESTAMP,
            "updatedAt": SERVER_TIMESTAMP,
        })
        return Reservation(reservation_ref.id, meter.key, quantity, "OPEN", operation_id)

    async def commit_storage_in(self, transaction: Any, uid: str, reservation_id: str, bytes_count: int) -> None:
        registry = (await self._configuration.get()).registry
        ref = self._reservation_ref(uid, reservation_id)
        reservation = await ref.get(transaction=transaction)
        fields = document_data(reservation)
        if fields.get("status") != "OPEN" or fields.get("meterKey") != registry.storage_meter_key or fields.get("estimatedQuantity") != bytes_count:
            raise RuntimeError("Snapshot storage reservation does not match the uploaded object.")
        meter = registry.meters[registry.storage_meter_key]
        if meter.kind != "GAUGE":
            raise RuntimeError("Storage requires a gauge.")
        usage_ref = self._usage_ref(uid, meter.key)
        usage = await usage_ref.get(transaction=transaction)
        period_start = period_start_for(meter, datetime.now(timezone.utc))
        state = self._state(usage, period_start, usage_ref.path)
        if state.reserved < bytes_count:
            raise RuntimeError("Storage reservation ledger disagrees.")
        self._write_usage(transaction, usage_ref, meter, state.consumed + bytes_count, state.reserved - bytes_count, period_start)
        transaction.update(ref, {"status": "SETTLED", "settledQuantity": bytes_count, "updatedAt": SERVER_TIMESTAMP})

    async def remove_stored_bytes_in(self, transaction: Any, uid: str, bytes_count: int) -> None:
        if not is_safe_integer(bytes_count) or int(bytes_count) <= 0:
            raise RuntimeError("Invalid stored byte count.")
        registry = (await self._configuration.get()).registry
        meter = registry.meters[registry.storage_meter_key]
        if meter.kind != "GAUGE":
            raise RuntimeError("Storage requires a gauge.")
        ref = self._usage_ref(uid, meter.key)
        snapshot = await ref.get(transaction=transaction)
        period_start = period_start_for(meter, datetime.now(timezone.utc))
        state = self._state(snapshot, period_start, ref.path)
        if state.consumed < bytes_count:
            raise RuntimeError("Stored byte ledger disagrees.")
        self._write_usage(transaction, ref, meter, state.consumed - bytes_count, state.reserved, period_start)

    async def reserve(self, **kwargs: Any) -> Reservation:
        return await run_transaction(self._firestore, lambda transaction: self.reserve_in(transaction, **kwargs))

    async def release_in(self, transaction: Any, uid: str, reservation_ids: list[str], now: datetime) -> list[str]:
        registry = (await self._configuration.get()).registry
        open_holds: list[dict[str, Any]] = []
        for reservation_id in reservation_ids:
            ref = self._reservation_ref(uid, reservation_id)
            snapshot = await ref.get(transaction=transaction)
            if not snapshot.exists:
                raise RuntimeError(f"No reservation {reservation_id} for {uid}.")
            fields = document_data(snapshot)
            if enum_field(fields, "status", ref.path, RESERVATION_STATUSES) != "OPEN":
                continue
            if fields.get("inFlight") is True:
                raise self._needs_reconciliation(reservation_id)
            meter_key = string_field(fields, "meterKey", ref.path)
            meter = registry.meters.get(meter_key)
            if meter is None:
                raise EntitlementConfigError(
                    f'Reservation {reservation_id} is on meter "{meter_key}", which the registry no longer declares, so the hold cannot be returned to it.'
                )
            open_holds.append({
                "ref": ref,
                "id": reservation_id,
                "meter": meter,
                "quantity": integer_field(fields, "estimatedQuantity", ref.path, min_value=1),
            })
        by_meter: dict[str, dict[str, Any]] = {}
        for entry in open_holds:
            running = by_meter.get(entry["meter"].key)
            by_meter[entry["meter"].key] = {
                "meter": entry["meter"],
                "total": (0 if running is None else running["total"]) + entry["quantity"],
            }
        pending: list[dict[str, Any]] = []
        for item in by_meter.values():
            usage_ref = self._usage_ref(uid, item["meter"].key)
            snapshot = await usage_ref.get(transaction=transaction)
            period_start = period_start_for(item["meter"], now)
            state = self._state(snapshot, period_start, usage_ref.path)
            if state.reserved < item["total"]:
                raise RuntimeError(
                    f'Usage for {uid}/{item["meter"].key} holds {state.reserved} but the reservations being released claim {item["total"]}.'
                )
            pending.append({"ref": usage_ref, "meter": item["meter"], "state": state, "total": item["total"], "period_start": period_start})
        for entry in pending:
            self._write_usage(transaction, entry["ref"], entry["meter"], entry["state"].consumed, entry["state"].reserved - entry["total"], entry["period_start"])
        for entry in open_holds:
            transaction.update(entry["ref"], {"status": "RELEASED", "updatedAt": SERVER_TIMESTAMP})
        return [entry["id"] for entry in open_holds]

    def _needs_reconciliation(self, reservation_id: str) -> AppError:
        return AppError(
            code="usage/reconciliation-required",
            status_code=409,
            message="A provider operation has unresolved usage. Its allowance remains held for reconciliation.",
            details={"reservationId": reservation_id},
        )

    async def _close(
        self,
        uid: str,
        reservation_id: str,
        now: datetime,
        apply: Callable[..., _CloseOutcome],
        allow_in_flight: bool = True,
        expected_observed_quantity: int | None = None,
    ) -> bool:
        reservation_ref = self._reservation_ref(uid, reservation_id)
        registry = (await self._configuration.get()).registry

        async def txn(transaction: Any) -> bool:
            snapshot = await reservation_ref.get(transaction=transaction)
            if not snapshot.exists:
                raise RuntimeError(f"No reservation {reservation_id} for {uid}.")
            fields = document_data(snapshot)
            if enum_field(fields, "status", reservation_ref.path, RESERVATION_STATUSES) != "OPEN":
                return False
            if not allow_in_flight and fields.get("inFlight") is True:
                raise self._needs_reconciliation(reservation_id)
            if expected_observed_quantity is not None and isinstance(fields.get("observedQuantity"), (int, float)) and not isinstance(fields.get("observedQuantity"), bool):
                if fields["observedQuantity"] != expected_observed_quantity:
                    raise RuntimeError("Recorded usage changed during settlement; retry reconciliation.")
            meter_key = string_field(fields, "meterKey", reservation_ref.path)
            meter = registry.meters.get(meter_key)
            if meter is None:
                raise EntitlementConfigError(
                    f'Reservation {reservation_id} is on meter "{meter_key}", which the registry no longer declares, so the hold cannot be returned to it.'
                )
            estimated = integer_field(fields, "estimatedQuantity", reservation_ref.path, min_value=1)
            usage_ref = self._usage_ref(uid, meter_key)
            usage = await usage_ref.get(transaction=transaction)
            period_start = period_start_for(meter, now)
            state = self._state(usage, period_start, usage_ref.path)
            if state.reserved < estimated:
                raise RuntimeError(
                    f"Usage for {uid}/{meter_key} holds {state.reserved} but reservation {reservation_id} claims {estimated}."
                )
            outcome = apply(meter, estimated, transaction, usage_ref, state, period_start)
            update: dict[str, Any] = {"status": outcome.status, "updatedAt": SERVER_TIMESTAMP}
            if outcome.settled_quantity is not None:
                update["settledQuantity"] = outcome.settled_quantity
            if outcome.overrun_quantity is not None:
                update["overrunQuantity"] = outcome.overrun_quantity
            transaction.update(reservation_ref, update)
            return True

        return await run_transaction(self._firestore, txn)

    async def settle(self, *, uid: str, reservation_id: str, actual_quantity: int, record_overrun: bool = False, now: datetime) -> bool:
        def apply(meter: MeterDefinition, estimated: int, transaction: Any, usage_ref: Any, state: _UsageState, period_start: datetime) -> _CloseOutcome:
            if meter.kind != "COUNTER":
                raise EntitlementConfigError(
                    f'Reservation {reservation_id} is on the {meter.kind} meter "{meter.key}", which is released rather than settled.'
                )
            if not is_safe_integer(actual_quantity) or int(actual_quantity) < 0 or (actual_quantity > estimated and record_overrun is not True):
                raise RuntimeError(
                    f"Reservation {reservation_id} held {estimated} {meter.unit} and cannot settle at {actual_quantity}."
                )
            self._write_usage(transaction, usage_ref, meter, state.consumed + actual_quantity, state.reserved - estimated, period_start)
            return _CloseOutcome("SETTLED", actual_quantity, max(0, actual_quantity - estimated))

        return await self._close(uid, reservation_id, now, apply, True, actual_quantity)

    async def release(self, uid: str, reservation_id: str, now: datetime | None = None) -> bool:
        if now is None:
            now = datetime.now(timezone.utc)

        def apply(meter: MeterDefinition, estimated: int, transaction: Any, usage_ref: Any, state: _UsageState, period_start: datetime) -> _CloseOutcome:
            self._write_usage(transaction, usage_ref, meter, state.consumed, state.reserved - estimated, period_start)
            return _CloseOutcome("RELEASED")

        return await self._close(uid, reservation_id, now, apply, False)
