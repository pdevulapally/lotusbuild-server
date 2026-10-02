"""Build sessions. The runner still reads these Firestore documents, so the shape matches the TypeScript server."""

from __future__ import annotations

import re
import uuid
from collections.abc import Callable, Sequence
from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

from google.cloud.firestore_v1.transforms import ArrayRemove, ArrayUnion

from lotusbuild.entitlements.build_admission import assert_build_allowed
from lotusbuild.errors import AppError, is_safe_integer
from lotusbuild.firestore_util import (
    DELETE_FIELD,
    SERVER_TIMESTAMP,
    FieldPath,
    Increment,
    document_data,
    from_date,
    from_millis,
    run_transaction,
)
from lotusbuild.projects.repository import project_session_active_error, project_session_guard_unmigrated_error
from lotusbuild.sessions.recovery import runner_recovery_protocol
from lotusbuild.support.documents import (
    boolean_field,
    enum_field,
    integer_field,
    optional_string_field,
    optional_timestamp_field,
    string_array_field,
    string_field,
    timestamp_field,
)

SESSIONS_COLLECTION_PATH = "sessions"
MESSAGES_COLLECTION_NAME = "messages"
QUEUED_MESSAGES_COLLECTION_NAME = "queued_messages"
# IDLE is not finished: the session is waiting for the next user turn.
BUILD_SESSION_STATUSES = ("QUEUED", "RUNNING", "IDLE", "FAILED")
MESSAGE_ROLES = ("user", "assistant")
PROMPT_MAX_LENGTH = 8000
MESSAGE_ID_WIDTH = 6
_IDEMPOTENCY = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_RECOVERY_KEYS = frozenset({"protocol", "status", "sandboxId", "reason"})


@dataclass(frozen=True)
class WorkspaceRecovery:
    status: str
    sandbox_id: str
    protocol: int | None = None
    reason: str | None = None


@dataclass(frozen=True)
class BuildSession:
    id: str
    project_id: str
    owner_uid: str
    status: str
    model: str
    effort: str
    sandbox_id: str | None
    claimed_by: str | None
    lease_token: str | None
    heartbeat_at: datetime | None
    error: str | None
    cancel_requested: bool | None
    workspace_recovery: WorkspaceRecovery | None
    queued_turn_pending: bool | None
    pending_steer: str | None
    reservation_ids: tuple[str, ...]
    specialist_reservation_ids: tuple[str, ...]
    message_count: int
    created_at: datetime


@dataclass(frozen=True)
class ClaimedSession(BuildSession):
    """A session this runner holds. status is RUNNING and the lease fields are set."""


@dataclass(frozen=True)
class SessionLease:
    session_id: str
    runner_id: str
    token: str


@dataclass(frozen=True)
class SessionMessage:
    seq: int
    role: str
    content: str
    created_at: datetime


@dataclass(frozen=True)
class QueuedMessage:
    id: str
    session_id: str
    prompt: str
    created_at: datetime


@dataclass(frozen=True)
class SessionOutcome:
    status: Literal["IDLE", "FAILED"]
    error: str | None = None


@dataclass(frozen=True)
class UploadedSnapshot:
    object_name: str
    generation: str
    bytes: int


@dataclass(frozen=True)
class PublishedSnapshot:
    project_id: str
    previous: dict[str, Any]


def message_id(seq: int) -> str:
    text = str(seq).zfill(MESSAGE_ID_WIDTH)
    if len(text) > MESSAGE_ID_WIDTH:
        raise RuntimeError(f"Session message {seq} exceeds the {MESSAGE_ID_WIDTH}-digit ordering width.")
    return text


def _ms(value: datetime) -> int:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    else:
        value = value.astimezone(timezone.utc)
    return int(value.timestamp() * 1000)


def _now(value: datetime | None = None) -> datetime:
    return datetime.now(timezone.utc) if value is None else value


def _check_signal(signal: Any) -> None:
    if signal is not None:
        signal.throw_if_aborted()


def _unique(values: Sequence[str]) -> list[str]:
    return list(dict.fromkeys(values))


def _recovery_fields(recovery: WorkspaceRecovery, **overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {"status": recovery.status, "sandboxId": recovery.sandbox_id}
    if recovery.protocol is not None:
        payload["protocol"] = recovery.protocol
    if recovery.reason is not None:
        payload["reason"] = recovery.reason
    payload.update(overrides)
    return payload


def _session_of(kind: type[BuildSession], session: BuildSession, **changes: Any) -> BuildSession:
    values = {name: getattr(session, name) for name in session.__dataclass_fields__}
    values.update(changes)
    return kind(**values)


def _workspace_recovery(fields: dict[str, Any], where: str) -> WorkspaceRecovery | None:
    if "workspaceRecovery" not in fields:
        return None
    try:
        value = fields["workspaceRecovery"]
        if not isinstance(value, dict):
            raise ValueError("Invalid recovery state.")
        if any(key not in _RECOVERY_KEYS for key in value) or (
            "protocol" in value and value["protocol"] != runner_recovery_protocol()
        ):
            raise ValueError("Unsupported recovery protocol.")
        return WorkspaceRecovery(
            status=enum_field(value, "status", where, ("REQUIRED", "COMPLETED", "UNRECOVERABLE")),
            sandbox_id=string_field(value, "sandboxId", where),
            protocol=None if "protocol" not in value else runner_recovery_protocol(),
            reason=None if "reason" not in value else string_field(value, "reason", where),
        )
    except Exception:
        raise AppError(
            code="session/recovery-protocol-incompatible",
            status_code=503,
            message="Workspace recovery metadata is invalid or unsupported. Execution is blocked.",
        ) from None


def parse_session(session_id: str, fields: dict[str, Any], where: str) -> BuildSession:
    return BuildSession(
        id=session_id,
        project_id=string_field(fields, "projectId", where),
        owner_uid=string_field(fields, "ownerUid", where),
        status=enum_field(fields, "status", where, BUILD_SESSION_STATUSES),
        model=string_field(fields, "model", where),
        effort=string_field(fields, "effort", where),
        sandbox_id=optional_string_field(fields, "sandboxId"),
        claimed_by=optional_string_field(fields, "claimedBy"),
        lease_token=optional_string_field(fields, "leaseToken"),
        heartbeat_at=optional_timestamp_field(fields, "heartbeatAt", where),
        error=optional_string_field(fields, "error"),
        cancel_requested=True if fields.get("cancelRequested") is True else None,
        workspace_recovery=_workspace_recovery(fields, where),
        queued_turn_pending=None if "queuedTurnPending" not in fields else boolean_field(fields, "queuedTurnPending", where),
        pending_steer=None if "pendingSteer" not in fields else string_field(fields, "pendingSteer", where),
        reservation_ids=string_array_field(fields, "reservationIds", where),
        specialist_reservation_ids=string_array_field(fields, "specialistReservationIds", where),
        message_count=integer_field(fields, "messageCount", where, min_value=1),
        created_at=timestamp_field(fields, "createdAt", where),
    )


def parse_message(document_id: str, fields: dict[str, Any], where: str) -> SessionMessage:
    return SessionMessage(
        seq=int(document_id),
        role=enum_field(fields, "role", where, MESSAGE_ROLES),
        content=string_field(fields, "content", where),
        created_at=timestamp_field(fields, "createdAt", where),
    )


def parse_queued_message(document_id: str, session_id: str, fields: dict[str, Any], where: str) -> QueuedMessage:
    return QueuedMessage(
        id=document_id,
        session_id=session_id,
        prompt=string_field(fields, "prompt", where),
        created_at=timestamp_field(fields, "createdAt", where),
    )


def _missing() -> AppError:
    return AppError(code="session/not-found", status_code=404, message="No such session.")


def _is_active(status: str) -> bool:
    return status == "QUEUED" or status == "RUNNING"


class SessionRepository:
    def __init__(
        self,
        firestore: Any,
        projects: Any,
        entitlements: Any,
        configuration: Any,
        metering: Any,
        lease_seconds: int,
    ) -> None:
        if not is_safe_integer(lease_seconds) or int(lease_seconds) <= 0:
            raise ValueError(f"The session lease must be a positive number of seconds, got {lease_seconds}.")
        self._firestore = firestore
        self._projects = projects
        self._entitlements = entitlements
        self._configuration = configuration
        self._metering = metering
        self._lease_seconds = int(lease_seconds)

    def _ref(self, session_id: str) -> Any:
        return self._firestore.document(f"{SESSIONS_COLLECTION_PATH}/{session_id}")

    def _lease_expiry(self, now: datetime) -> datetime:
        return from_date(now + timedelta(seconds=self._lease_seconds))

    def _assert_project_guard(self, project: Any, session: BuildSession) -> None:
        if project.active_session_id != session.id:
            raise AppError(
                code="session/project-guard-lost",
                status_code=409,
                message="This session no longer owns the project workspace.",
                details={"sessionId": session.id, "projectId": session.project_id, "status": session.status},
            )

    def _assert_project_can_activate(self, project: Any, session_id: str | None = None) -> None:
        # Absent activeSessionId is unmigrated. Explicit null is unlocked.
        if not project.active_session_known:
            raise project_session_guard_unmigrated_error()
        if project.active_session_id is not None:
            if session_id is not None and project.active_session_id == session_id:
                raise AppError(
                    code="session/project-state-inconsistent",
                    status_code=409,
                    message="This session and its project are in an inconsistent state.",
                    details={"sessionId": session_id, "projectId": project.id},
                )
            raise project_session_active_error()

    def _assert_prompt_recovery_eligible(self, session: BuildSession) -> None:
        if session.workspace_recovery is not None and session.workspace_recovery.status == "UNRECOVERABLE":
            raise AppError(
                code="session/workspace-unrecoverable",
                status_code=409,
                message="The latest unsaved workspace state could not be recovered. This session cannot accept new work.",
            )

    def _validate_prompt(self, prompt: str) -> None:
        if prompt.strip() == "" or len(prompt) > PROMPT_MAX_LENGTH:
            raise AppError(
                code="session/invalid-prompt",
                status_code=400,
                message="Prompt must contain text within the permitted length.",
            )

    async def _queue_limit(self, entitlements: Any) -> int:
        # Reuse the plan's build-meter hard limit rather than a second queue rule.
        registry = (await self._configuration.get()).registry
        limit = entitlements.meter_limits.get(registry.build_meter_key)
        if limit is None:
            raise RuntimeError("The build meter limit is missing.")
        return limit.hard_limit

    async def _require_runner_lease(
        self,
        transaction: Any,
        ref: Any,
        authority: SessionLease,
        allow_cancelled: bool = False,
    ) -> BuildSession:
        snapshot = await ref.get(transaction=transaction)
        if not snapshot.exists:
            raise _missing()
        fields = document_data(snapshot)
        session = parse_session(snapshot.id, fields, ref.path)
        if session.cancel_requested is True and not allow_cancelled:
            raise AppError(
                code="session/cancelled",
                status_code=409,
                message="Cancelled by user",
                details={"sessionId": session.id},
            )
        expires_at = optional_timestamp_field(fields, "claimableAt", ref.path)
        if (
            session.id != authority.session_id
            or session.status != "RUNNING"
            or session.claimed_by != authority.runner_id
            or session.lease_token != authority.token
            or expires_at is None
            or _ms(expires_at) <= _ms(datetime.now(timezone.utc))
        ):
            raise AppError(
                code="session/lease-lost",
                status_code=409,
                message=f"This session is {session.status} and is not held by {authority.runner_id}.",
                details={"status": session.status, "claimedBy": session.claimed_by},
            )
        return session

    async def _require_lease_state(
        self,
        transaction: Any,
        ref: Any,
        authority: SessionLease,
        allow_cancelled: bool = False,
    ) -> tuple[BuildSession, Any]:
        session = await self._require_runner_lease(transaction, ref, authority, allow_cancelled)
        project = await self._projects.read_owned_in_transaction(
            transaction, session.owner_uid, session.project_id, allow_cancelled,
        )
        self._assert_project_guard(project, session)
        return session, project

    async def _require_lease(
        self,
        transaction: Any,
        ref: Any,
        authority: SessionLease,
        allow_cancelled: bool = False,
    ) -> BuildSession:
        session, _project = await self._require_lease_state(transaction, ref, authority, allow_cancelled)
        return session

    async def _require_persistence_lease(
        self,
        transaction: Any,
        ref: Any,
        authority: SessionLease,
        cleanup: bool = False,
    ) -> tuple[BuildSession, Any]:
        session, project = await self._require_lease_state(transaction, ref, authority, cleanup)
        # Cancellation may save work already written. It does not bypass account erasure.
        if cleanup:
            await self._projects.read_owned_in_transaction(transaction, session.owner_uid, session.project_id)
        if session.lease_token != authority.token:
            raise AppError(
                code="session/lease-lost",
                status_code=409,
                message="This runner no longer owns the persistence lease for the session.",
                details={"sessionId": session.id, "claimedBy": session.claimed_by},
            )
        return session, project

    async def _with_lease(
        self,
        session_id: str,
        authority: SessionLease,
        write: Callable[[Any, Any, BuildSession], None],
        allow_cancelled: bool = False,
    ) -> None:
        ref = self._ref(session_id)

        async def txn(transaction: Any) -> None:
            session = await self._require_lease(transaction, ref, authority, allow_cancelled)
            write(transaction, ref, session)

        await run_transaction(self._firestore, txn)

    async def create(
        self,
        uid: str,
        project_id: str,
        *,
        prompt: str,
        model: str,
        idempotency_id: str | None = None,
    ) -> BuildSession:
        self._validate_prompt(prompt)
        if idempotency_id is not None and _IDEMPOTENCY.fullmatch(idempotency_id) is None:
            raise RuntimeError("Invalid internal session id.")
        project = await self._projects.read_owned(uid, project_id)
        entitlements = await self._entitlements.for_user(uid)
        assert_build_allowed(entitlements, project.platform, model)
        # Effort comes from the plan, never the request.
        effort = entitlements.capabilities.string("ai.effort")
        registry = (await self._configuration.get()).registry
        now = datetime.now(timezone.utc)
        collection = self._firestore.collection(SESSIONS_COLLECTION_PATH)
        ref = collection.document() if idempotency_id is None else collection.document(idempotency_id)
        first_message = ref.collection(MESSAGES_COLLECTION_NAME).document(message_id(0))

        async def txn(transaction: Any) -> BuildSession | None:
            if idempotency_id is not None:
                prior = await ref.get(transaction=transaction)
                if prior.exists:
                    parsed = parse_session(prior.id, document_data(prior), ref.path)
                    if parsed.owner_uid != uid or parsed.project_id != project_id:
                        raise RuntimeError("Idempotent session scope disagrees.")
                    return parsed
            current_project = await self._projects.read_owned_in_transaction(transaction, uid, project.id)
            self._assert_project_can_activate(current_project)
            await self._metering.consume_in(
                transaction, uid=uid, entitlements=entitlements, meter_key=registry.build_meter_key, quantity=1, now=now,
            )
            transaction.create(ref, {
                "projectId": project.id,
                "ownerUid": uid,
                "status": "QUEUED",
                "model": model,
                "effort": effort,
                "messageCount": 1,
                "claimableAt": from_date(now),
                "createdAt": SERVER_TIMESTAMP,
                "updatedAt": SERVER_TIMESTAMP,
            })
            transaction.create(first_message, {"role": "user", "content": prompt, "createdAt": SERVER_TIMESTAMP})
            transaction.update(self._projects.ref_for(project.id), {
                "activeSessionId": ref.id,
                "updatedAt": SERVER_TIMESTAMP,
            })
            return None

        existing = await run_transaction(self._firestore, txn)
        if existing is not None:
            return existing
        return BuildSession(
            id=ref.id,
            project_id=project.id,
            owner_uid=uid,
            status="QUEUED",
            model=model,
            effort=effort,
            sandbox_id=None,
            claimed_by=None,
            lease_token=None,
            heartbeat_at=None,
            error=None,
            cancel_requested=None,
            workspace_recovery=None,
            queued_turn_pending=None,
            pending_steer=None,
            reservation_ids=(),
            specialist_reservation_ids=(),
            message_count=1,
            created_at=now,
        )

    async def read_owned(self, owner_uid: str, session_id: str) -> BuildSession:
        ref = self._ref(session_id)
        snapshot = await ref.get()
        if not snapshot.exists:
            raise _missing()
        session = parse_session(snapshot.id, document_data(snapshot), ref.path)
        if session.owner_uid != owner_uid:
            raise _missing()
        await self._projects.read_owned(owner_uid, session.project_id)
        return session

    async def list_for_project(self, owner_uid: str, project_id: str, limit: int) -> list[BuildSession]:
        # Project ownership is what grants sight of its sessions, so it is proven before the query.
        project = await self._projects.read_owned(owner_uid, project_id)
        query = (
            self._firestore.collection(SESSIONS_COLLECTION_PATH)
            .where("projectId", "==", project.id)
            .order_by("createdAt", direction="DESCENDING")
            .limit(limit)
        )
        return [parse_session(doc.id, document_data(doc), doc.reference.path) async for doc in query.stream()]

    async def list_messages(self, owner_uid: str, session_id: str, limit: int) -> list[SessionMessage]:
        session = await self.read_owned(owner_uid, session_id)
        query = (
            self._ref(session.id)
            .collection(MESSAGES_COLLECTION_NAME)
            .order_by(FieldPath.document_id(), direction="DESCENDING")
            .limit(limit)
        )
        messages = [parse_message(doc.id, document_data(doc), doc.reference.path) async for doc in query.stream()]
        messages.reverse()
        return messages

    async def append_prompt(self, uid: str, session_id: str, prompt: str) -> BuildSession:
        self._validate_prompt(prompt)
        session = await self.read_owned(uid, session_id)
        entitlements = await self._entitlements.for_user(uid)
        registry = (await self._configuration.get()).registry
        now = datetime.now(timezone.utc)
        ref = self._ref(session.id)

        async def txn(transaction: Any) -> BuildSession:
            snapshot = await ref.get(transaction=transaction)
            if not snapshot.exists:
                raise _missing()
            current = parse_session(snapshot.id, document_data(snapshot), ref.path)
            if current.owner_uid != uid:
                raise _missing()
            self._assert_prompt_recovery_eligible(current)
            if current.status in ("QUEUED", "RUNNING"):
                raise AppError(
                    code="session/busy",
                    status_code=409,
                    message="This session is still working. Wait for it to finish before sending more.",
                    details={"status": current.status},
                )
            project = await self._projects.read_owned_in_transaction(transaction, uid, current.project_id)
            self._assert_project_can_activate(project, current.id)
            assert_build_allowed(entitlements, project.platform, current.model)
            seq = current.message_count
            message_ref = ref.collection(MESSAGES_COLLECTION_NAME).document(message_id(seq))
            await self._metering.consume_in(
                transaction, uid=uid, entitlements=entitlements, meter_key=registry.build_meter_key, quantity=1, now=now,
            )
            transaction.create(message_ref, {"role": "user", "content": prompt, "createdAt": SERVER_TIMESTAMP})
            transaction.update(ref, {
                "status": "QUEUED",
                "messageCount": Increment(1),
                "claimableAt": from_date(now),
                "cancelRequested": DELETE_FIELD,
                "error": DELETE_FIELD,
                "updatedAt": SERVER_TIMESTAMP,
            })
            transaction.update(self._projects.ref_for(current.project_id), {
                "activeSessionId": current.id,
                "updatedAt": SERVER_TIMESTAMP,
            })
            return replace(current, status="QUEUED", error=None, cancel_requested=None, message_count=seq + 1)

        return await run_transaction(self._firestore, txn)

    async def enqueue_message(self, uid: str, session_id: str, prompt: str) -> QueuedMessage:
        self._validate_prompt(prompt)
        entitlements = await self._entitlements.for_user(uid)
        limit = await self._queue_limit(entitlements)
        parent = self._ref(session_id)
        ref = parent.collection(QUEUED_MESSAGES_COLLECTION_NAME).document()

        async def txn(transaction: Any) -> None:
            snapshot = await parent.get(transaction=transaction)
            data = document_data(snapshot)
            if not snapshot.exists or data.get("ownerUid") != uid:
                raise _missing()
            session = parse_session(snapshot.id, data, parent.path)
            self._assert_prompt_recovery_eligible(session)
            if not _is_active(session.status) or session.cancel_requested is True:
                raise AppError(
                    code="session/not-active",
                    status_code=409,
                    message="This session is no longer accepting queued messages.",
                )
            project = await self._projects.read_owned_in_transaction(transaction, uid, session.project_id)
            self._assert_project_guard(project, session)
            assert_build_allowed(entitlements, project.platform, session.model)
            queued = parent.collection(QUEUED_MESSAGES_COLLECTION_NAME).limit(limit + 1)
            page = [doc async for doc in queued.stream(transaction=transaction)]
            if len(page) >= limit:
                raise AppError(code="session/queue-full", status_code=429, message="The session message queue is full.")
            transaction.create(ref, {"prompt": prompt, "createdAt": SERVER_TIMESTAMP})
            # Enqueue and deletion share this parent document as the conflict boundary.
            transaction.update(parent, {"updatedAt": SERVER_TIMESTAMP})

        await run_transaction(self._firestore, txn)
        return QueuedMessage(id=ref.id, session_id=session_id, prompt=prompt, created_at=datetime.now(timezone.utc))

    async def list_queued_messages(
        self,
        uid: str,
        session_id: str,
        limit: int = 100,
        after: str | None = None,
    ) -> list[QueuedMessage]:
        session = await self.read_owned(uid, session_id)
        if not is_safe_integer(limit) or limit < 1 or limit > 200:
            raise RuntimeError("Invalid queue page size.")
        query = (
            self._ref(session.id)
            .collection(QUEUED_MESSAGES_COLLECTION_NAME)
            .order_by("createdAt")
            .order_by(FieldPath.document_id())
        )
        if after is not None:
            cursor = await self._ref(session.id).collection(QUEUED_MESSAGES_COLLECTION_NAME).document(after).get()
            if not cursor.exists:
                raise AppError(
                    code="session/cursor-missing",
                    status_code=400,
                    message="Queue cursor no longer exists; restart pagination.",
                )
            query = query.start_after(cursor)
        page = query.limit(limit)
        return [
            parse_queued_message(doc.id, session.id, document_data(doc), doc.reference.path)
            async for doc in page.stream()
        ]

    async def delete_queued_message(self, uid: str, session_id: str, queued_message_id: str) -> None:
        session = await self.read_owned(uid, session_id)
        ref = self._ref(session.id).collection(QUEUED_MESSAGES_COLLECTION_NAME).document(queued_message_id)
        snapshot = await ref.get()
        if not snapshot.exists:
            raise AppError(
                code="session/queued-message-not-found",
                status_code=404,
                message="No such queued message.",
            )
        await ref.delete()

    async def dequeue_next_message(
        self,
        session_id: str,
        authority: SessionLease,
        signal: Any = None,
    ) -> QueuedMessage | None:
        _check_signal(signal)
        ref = self._ref(session_id)
        now = datetime.now(timezone.utc)

        async def txn(transaction: Any) -> QueuedMessage | None:
            session = await self._require_lease(transaction, ref, authority)
            queued = ref.collection(QUEUED_MESSAGES_COLLECTION_NAME).order_by("createdAt").limit(1)
            queued_docs = [doc async for doc in queued.stream(transaction=transaction)]
            if not queued_docs:
                return None
            next_doc = queued_docs[0]
            next_data = parse_queued_message(next_doc.id, session_id, document_data(next_doc), next_doc.reference.path)
            entitlements = await self._entitlements.for_user(session.owner_uid)
            registry = (await self._configuration.get()).registry
            project = await self._projects.read_owned_in_transaction(transaction, session.owner_uid, session.project_id)
            assert_build_allowed(entitlements, project.platform, session.model)
            seq = session.message_count
            message_ref = ref.collection(MESSAGES_COLLECTION_NAME).document(message_id(seq))
            await self._metering.consume_in(
                transaction,
                uid=session.owner_uid,
                entitlements=entitlements,
                meter_key=registry.build_meter_key,
                quantity=1,
                now=now,
            )
            _check_signal(signal)
            transaction.create(message_ref, {"role": "user", "content": next_data.prompt, "createdAt": SERVER_TIMESTAMP})
            transaction.delete(next_doc.reference)
            transaction.update(ref, {"messageCount": Increment(1), "updatedAt": SERVER_TIMESTAMP})
            return next_data

        return await run_transaction(self._firestore, txn)

    async def queue_steer_message(self, uid: str, session_id: str, prompt: str) -> None:
        self._validate_prompt(prompt)
        entitlements = await self._entitlements.for_user(uid)
        ref = self._ref(session_id)

        async def txn(transaction: Any) -> None:
            snapshot = await ref.get(transaction=transaction)
            data = document_data(snapshot)
            if not snapshot.exists or data.get("ownerUid") != uid:
                raise _missing()
            session = parse_session(snapshot.id, data, ref.path)
            self._assert_prompt_recovery_eligible(session)
            if session.status != "RUNNING" or session.cancel_requested is True:
                raise AppError(
                    code="session/not-running",
                    status_code=409,
                    message="This session is no longer accepting steering instructions.",
                )
            project = await self._projects.read_owned_in_transaction(transaction, uid, session.project_id)
            self._assert_project_guard(project, session)
            assert_build_allowed(entitlements, project.platform, session.model)
            transaction.update(ref, {"pendingSteer": prompt, "updatedAt": SERVER_TIMESTAMP})

        await run_transaction(self._firestore, txn)

    async def drain_steer_message(self, session_id: str, authority: SessionLease) -> str | None:
        ref = self._ref(session_id)

        async def txn(transaction: Any) -> str | None:
            session = await self._require_lease(transaction, ref, authority)
            prompt = session.pending_steer
            if prompt is None:
                return None
            message_ref = ref.collection(MESSAGES_COLLECTION_NAME).document(message_id(session.message_count))
            transaction.create(message_ref, {"role": "user", "content": prompt, "createdAt": SERVER_TIMESTAMP})
            transaction.update(ref, {
                "pendingSteer": DELETE_FIELD,
                "messageCount": Increment(1),
                "updatedAt": SERVER_TIMESTAMP,
            })
            return prompt

        return await run_transaction(self._firestore, txn)

    async def start_pending_turn(self, session_id: str, authority: SessionLease, signal: Any = None) -> bool:
        _check_signal(signal)
        ref = self._ref(session_id)

        async def txn(transaction: Any) -> bool:
            session = await self._require_lease(transaction, ref, authority)
            if session.queued_turn_pending is not True:
                raise RuntimeError("Session has no pending turn to start.")
            queued = ref.collection(QUEUED_MESSAGES_COLLECTION_NAME).order_by("createdAt").limit(1)
            queued_docs = [doc async for doc in queued.stream(transaction=transaction)]
            next_doc = queued_docs[0] if queued_docs else None
            prompt = session.pending_steer
            if prompt is None and next_doc is not None:
                prompt = parse_queued_message(
                    next_doc.id, session_id, document_data(next_doc), next_doc.reference.path,
                ).prompt
            if prompt is None:
                return False
            entitlements = await self._entitlements.for_user(session.owner_uid)
            project = await self._projects.read_owned_in_transaction(transaction, session.owner_uid, session.project_id)
            assert_build_allowed(entitlements, project.platform, session.model)
            message_ref = ref.collection(MESSAGES_COLLECTION_NAME).document(message_id(session.message_count))
            if session.pending_steer is None:
                if next_doc is None:
                    raise RuntimeError("Pending message disappeared inside the transaction.")
                registry = (await self._configuration.get()).registry
                await self._metering.consume_in(
                    transaction,
                    uid=session.owner_uid,
                    entitlements=entitlements,
                    meter_key=registry.build_meter_key,
                    quantity=1,
                    now=datetime.now(timezone.utc),
                )
                transaction.delete(next_doc.reference)
            _check_signal(signal)
            transaction.create(message_ref, {"role": "user", "content": prompt, "createdAt": SERVER_TIMESTAMP})
            transaction.update(ref, {
                "queuedTurnPending": DELETE_FIELD,
                "pendingSteer": DELETE_FIELD,
                "messageCount": Increment(1),
                "updatedAt": SERVER_TIMESTAMP,
            })
            return True

        return await run_transaction(self._firestore, txn)

    async def cancel(self, uid: str, session_id: str) -> BuildSession:
        await self.read_owned(uid, session_id)
        entitlements = await self._entitlements.for_user(uid)
        registry = (await self._configuration.get()).registry
        ref = self._ref(session_id)
        now = datetime.now(timezone.utc)

        async def txn(transaction: Any) -> BuildSession:
            snapshot = await ref.get(transaction=transaction)
            if not snapshot.exists:
                raise _missing()
            fields = document_data(snapshot)
            current = parse_session(snapshot.id, fields, ref.path)
            if current.owner_uid != uid:
                raise _missing()
            if current.status in ("IDLE", "FAILED"):
                raise AppError(
                    code="session/not-cancellable",
                    status_code=409,
                    message=f"Cannot cancel a session that is already {current.status}.",
                    details={"status": current.status},
                )
            project = await self._projects.read_owned_in_transaction(transaction, uid, current.project_id, True)
            self._assert_project_guard(project, current)
            if current.status == "QUEUED":
                if current.queued_turn_pending is not True:
                    await self._metering.refund_in(
                        transaction,
                        uid=uid,
                        entitlements=entitlements,
                        meter_key=registry.build_meter_key,
                        quantity=1,
                        charged_at=timestamp_field(fields, "claimableAt", ref.path),
                        now=now,
                    )
                transaction.update(ref, {
                    "status": "FAILED",
                    "error": "Cancelled by user",
                    "leaseToken": DELETE_FIELD,
                    "claimableAt": DELETE_FIELD,
                    "queuedTurnPending": DELETE_FIELD,
                    "pendingSteer": DELETE_FIELD,
                    "updatedAt": SERVER_TIMESTAMP,
                })
                transaction.update(self._projects.ref_for(current.project_id), {
                    "activeSessionId": None,
                    "updatedAt": SERVER_TIMESTAMP,
                })
                return replace(current, status="FAILED", error="Cancelled by user", cancel_requested=None)
            transaction.update(ref, {"cancelRequested": True, "updatedAt": SERVER_TIMESTAMP})
            return replace(current, cancel_requested=True)

        return await run_transaction(self._firestore, txn)

    async def claim(self, runner_id: str, now: datetime | None = None, signal: Any = None) -> ClaimedSession | None:
        _check_signal(signal)
        instant = _now(now)
        # claimableAt is written from the caller's clock only, never a server timestamp.
        query = (
            self._firestore.collection(SESSIONS_COLLECTION_PATH)
            .where("claimableAt", "<=", from_date(instant))
            .order_by("claimableAt")
            .limit(1)
        )
        candidates = [doc async for doc in query.stream()]
        if not candidates:
            return None
        candidate = candidates[0]
        ref = candidate.reference
        lease_token = str(uuid.uuid4())

        async def txn(transaction: Any) -> ClaimedSession | None:
            snapshot = await ref.get(transaction=transaction)
            if not snapshot.exists:
                return None
            fields = document_data(snapshot)
            claimable_at = optional_timestamp_field(fields, "claimableAt", ref.path)
            if claimable_at is None or _ms(claimable_at) > _ms(instant):
                return None
            session = parse_session(snapshot.id, fields, ref.path)
            if not _is_active(session.status):
                raise AppError(
                    code="session/project-state-inconsistent",
                    status_code=409,
                    message="This queued session is in an inconsistent state.",
                    details={"sessionId": session.id, "projectId": session.project_id, "status": session.status},
                )
            try:
                project = await self._projects.read_owned_in_transaction(
                    transaction, session.owner_uid, session.project_id, session.status == "RUNNING",
                )
            except AppError as error:
                recovery = session.workspace_recovery
                if (
                    recovery is None
                    or recovery.status != "REQUIRED"
                    or error.code not in ("project/not-found", "project/deleting")
                ):
                    raise
                # No publication lease once destructive intent revoked project access.
                transaction.update(ref, {
                    "workspaceRecovery": _recovery_fields(recovery, status="UNRECOVERABLE", reason="persistence-revoked"),
                    "error": "Workspace recovery is unrecoverable: persistence-revoked",
                    "updatedAt": SERVER_TIMESTAMP,
                })
                return None
            self._assert_project_guard(project, session)
            _check_signal(signal)
            transaction.update(ref, {
                "status": "RUNNING",
                "claimedBy": runner_id,
                "leaseToken": lease_token,
                "heartbeatAt": from_date(instant),
                "claimableAt": self._lease_expiry(instant),
                "error": DELETE_FIELD,
                "updatedAt": SERVER_TIMESTAMP,
            })
            return _session_of(
                ClaimedSession,
                session,
                status="RUNNING",
                claimed_by=runner_id,
                lease_token=lease_token,
                heartbeat_at=instant,
                error=None,
            )

        return await run_transaction(self._firestore, txn)

    async def assert_persistence_lease(self, authority: SessionLease, cleanup: bool = False) -> None:
        ref = self._ref(authority.session_id)

        async def txn(transaction: Any) -> None:
            await self._require_persistence_lease(transaction, ref, authority, cleanup)

        await run_transaction(self._firestore, txn)

    async def reserve_snapshot_upload(
        self,
        authority: SessionLease,
        entitlements: Any,
        *,
        upload_id: str,
        object_name: str,
        bytes_count: int,
        expires_at: datetime,
        cleanup: bool = False,
    ) -> None:
        registry = (await self._configuration.get()).registry

        async def txn(transaction: Any) -> None:
            session, project = await self._require_persistence_lease(
                transaction, self._ref(authority.session_id), authority, cleanup,
            )
            if (
                object_name != f"projects/{project.id}/snapshots/{upload_id}.tar.gz"
                or _ms(expires_at) <= _ms(datetime.now(timezone.utc))
            ):
                raise RuntimeError("Invalid snapshot upload admission.")
            upload_ref = self._firestore.document(f"snapshotUploads/{upload_id}")
            reservation = await self._metering.reserve_in(
                transaction,
                uid=session.owner_uid,
                entitlements=entitlements,
                meter_key=registry.storage_meter_key,
                quantity=bytes_count,
                operation_id=f"snapshot:{upload_id}",
                now=datetime.now(timezone.utc),
            )
            transaction.create(upload_ref, {
                "ownerUid": session.owner_uid,
                "projectId": project.id,
                "leaseToken": authority.token,
                "objectName": object_name,
                "bytes": bytes_count,
                "expiresAt": from_date(expires_at),
                "status": "CANDIDATE",
                "reservationId": reservation.id,
                "createdAt": SERVER_TIMESTAMP,
            })

        await run_transaction(self._firestore, txn)

    async def publish_snapshot(
        self,
        authority: SessionLease,
        entitlements: Any,
        snapshot: UploadedSnapshot,
        upload_id: str,
        cleanup: bool = False,
    ) -> PublishedSnapshot:
        # `entitlements` matches the TypeScript signature. Admission was checked when the upload was reserved.
        _ = entitlements
        ref = self._ref(authority.session_id)

        async def txn(transaction: Any) -> PublishedSnapshot:
            session, project = await self._require_persistence_lease(transaction, ref, authority, cleanup)
            upload_ref = self._firestore.document(f"snapshotUploads/{upload_id}")
            upload = await upload_ref.get(transaction=transaction)
            fields = document_data(upload)
            if (
                fields.get("status") != "CANDIDATE"
                or fields.get("leaseToken") != authority.token
                or fields.get("objectName") != snapshot.object_name
                or fields.get("bytes") != snapshot.bytes
                or _ms(timestamp_field(fields, "expiresAt", upload_ref.path)) <= _ms(datetime.now(timezone.utc))
            ):
                raise RuntimeError("Snapshot does not match its live upload admission.")
            obsolete_ref = None
            if project.snapshot_upload_id is None and project.snapshot["kind"] != "none":
                obsolete_ref = self._firestore.collection("snapshotUploads").document()
            await self._metering.commit_storage_in(
                transaction,
                session.owner_uid,
                string_field(fields, "reservationId", upload_ref.path),
                snapshot.bytes,
            )
            transaction.update(upload_ref, {"status": "CURRENT", "generation": snapshot.generation})
            if project.snapshot_upload_id is not None:
                transaction.update(
                    self._firestore.document(f"snapshotUploads/{project.snapshot_upload_id}"),
                    {"status": "OBSOLETE"},
                )
            elif obsolete_ref is not None:
                obsolete: dict[str, Any] = {
                    "ownerUid": session.owner_uid,
                    "projectId": project.id,
                    "bytes": project.snapshot_bytes,
                    "status": "OBSOLETE",
                    "expiresAt": from_millis(0),
                    "legacy": project.snapshot["kind"] == "legacy",
                }
                if project.snapshot["kind"] == "immutable":
                    obsolete["objectName"] = project.snapshot["objectName"]
                    obsolete["generation"] = project.snapshot["generation"]
                transaction.create(obsolete_ref, obsolete)
            transaction.update(self._projects.ref_for(project.id), {
                "snapshotBytes": snapshot.bytes,
                "snapshotObjectName": snapshot.object_name,
                "snapshotObjectGeneration": snapshot.generation,
                "snapshotUploadId": upload_id,
                "snapshotUpdatedAt": SERVER_TIMESTAMP,
                "updatedAt": SERVER_TIMESTAMP,
            })
            # Publication and salvage completion are one commit.
            recovery = session.workspace_recovery
            if recovery is not None and recovery.status == "REQUIRED":
                if recovery.sandbox_id != session.sandbox_id:
                    raise RuntimeError("Workspace recovery identity mismatch.")
                transaction.update(ref, {"workspaceRecovery": _recovery_fields(recovery, status="COMPLETED")})
            return PublishedSnapshot(project_id=project.id, previous=project.snapshot)

        return await run_transaction(self._firestore, txn)

    async def heartbeat(
        self,
        session_id: str,
        authority: SessionLease,
        now: datetime | None = None,
        cleanup: bool = False,
    ) -> None:
        instant = _now(now)

        def write(transaction: Any, ref: Any, _session: BuildSession) -> None:
            transaction.update(ref, {
                "heartbeatAt": from_date(instant),
                "claimableAt": self._lease_expiry(instant),
                "updatedAt": SERVER_TIMESTAMP,
            })

        await self._with_lease(session_id, authority, write, cleanup)

    async def attach_sandbox(
        self,
        session_id: str,
        authority: SessionLease,
        *,
        sandbox_id: str,
        reservation_ids: Sequence[str],
    ) -> None:
        def write(transaction: Any, ref: Any, session: BuildSession) -> None:
            if session.workspace_recovery is not None and session.workspace_recovery.status == "REQUIRED":
                raise RuntimeError("Unsaved workspace must be recovered before replacement.")
            transaction.update(ref, {
                "sandboxId": sandbox_id,
                "reservationIds": list(reservation_ids),
                "workspaceRecovery": DELETE_FIELD,
                "updatedAt": SERVER_TIMESTAMP,
            })

        await self._with_lease(session_id, authority, write)

    async def append_assistant_message(self, session_id: str, authority: SessionLease, content: str) -> None:
        ref = self._ref(session_id)

        async def txn(transaction: Any) -> None:
            session = await self._require_lease(transaction, ref, authority)
            message_ref = ref.collection(MESSAGES_COLLECTION_NAME).document(message_id(session.message_count))
            transaction.create(message_ref, {"role": "assistant", "content": content, "createdAt": SERVER_TIMESTAMP})
            transaction.update(ref, {"messageCount": Increment(1), "updatedAt": SERVER_TIMESTAMP})

        await run_transaction(self._firestore, txn)

    async def reserve_specialist_tokens(
        self,
        session_id: str,
        runner_id: str,
        *,
        lease_token: str,
        entitlements: Any,
        meter_key: str,
        quantity: int,
        operation_id: str,
        now: datetime,
    ) -> Any:
        ref = self._ref(session_id)

        async def txn(transaction: Any) -> Any:
            # Lease, project guard, then the usage read inside reserve_in. Nothing is written before that.
            session, project = await self._require_persistence_lease(
                transaction, ref, SessionLease(session_id, runner_id, lease_token),
            )
            assert_build_allowed(entitlements, project.platform, session.model)
            reservation = await self._metering.reserve_in(
                transaction,
                uid=session.owner_uid,
                entitlements=entitlements,
                meter_key=meter_key,
                quantity=quantity,
                operation_id=operation_id,
                now=now,
            )
            transaction.update(ref, {
                "specialistReservationIds": ArrayUnion([reservation.id]),
                "updatedAt": SERVER_TIMESTAMP,
            })
            return reservation

        return await run_transaction(self._firestore, txn)

    async def forget_specialist_reservation(
        self,
        session_id: str,
        authority: SessionLease,
        reservation_id: str,
    ) -> None:
        def write(transaction: Any, ref: Any, _session: BuildSession) -> None:
            transaction.update(ref, {
                "specialistReservationIds": ArrayRemove([reservation_id]),
                "updatedAt": SERVER_TIMESTAMP,
            })

        await self._with_lease(session_id, authority, write, True)

    async def yield_for_recovery(self, session_id: str, authority: SessionLease) -> None:
        # Shutdown keeps the turn, queue, project guard, and any recovery evidence.
        def write(transaction: Any, ref: Any, _session: BuildSession) -> None:
            transaction.update(ref, {
                "claimableAt": datetime.now(timezone.utc),
                "claimedBy": DELETE_FIELD,
                "leaseToken": DELETE_FIELD,
                "updatedAt": SERVER_TIMESTAMP,
            })

        await self._with_lease(session_id, authority, write, True)

    async def require_workspace_salvage(self, authority: SessionLease, sandbox_id: str) -> None:
        def write(transaction: Any, ref: Any, session: BuildSession) -> None:
            if session.sandbox_id != sandbox_id:
                raise RuntimeError("Workspace recovery identity mismatch.")
            transaction.update(ref, {
                "workspaceRecovery": {
                    "protocol": runner_recovery_protocol(),
                    "status": "REQUIRED",
                    "sandboxId": sandbox_id,
                },
                "updatedAt": SERVER_TIMESTAMP,
            })

        await self._with_lease(authority.session_id, authority, write)

    async def workspace_recovery_state(self, authority: SessionLease) -> WorkspaceRecovery | None:
        ref = self._ref(authority.session_id)

        async def txn(transaction: Any) -> WorkspaceRecovery | None:
            session = await self._require_runner_lease(transaction, ref, authority, True)
            return session.workspace_recovery

        return await run_transaction(self._firestore, txn)

    async def mark_workspace_unrecoverable(
        self,
        authority: SessionLease,
        reason: Literal["sandbox-absent", "invalid-attachment", "persistence-revoked"],
    ) -> None:
        ref = self._ref(authority.session_id)

        async def txn(transaction: Any) -> None:
            session = await self._require_runner_lease(transaction, ref, authority, True)
            recovery = session.workspace_recovery
            if recovery is None or recovery.status != "REQUIRED":
                raise RuntimeError("No pending workspace salvage.")
            transaction.update(ref, {
                "workspaceRecovery": _recovery_fields(recovery, status="UNRECOVERABLE", reason=reason),
                "error": "Workspace recovery is unrecoverable: " + reason,
                "updatedAt": SERVER_TIMESTAMP,
            })

        await run_transaction(self._firestore, txn)

    async def detach_sandbox(self, session_id: str, authority: SessionLease) -> None:
        def write(transaction: Any, ref: Any, session: BuildSession) -> None:
            if session.workspace_recovery is not None and session.workspace_recovery.status == "REQUIRED":
                raise RuntimeError("Unsaved workspace must be recovered before detachment.")
            transaction.update(ref, {
                "sandboxId": DELETE_FIELD,
                "reservationIds": DELETE_FIELD,
                "updatedAt": SERVER_TIMESTAMP,
            })

        await self._with_lease(session_id, authority, write, True)

    async def finish_unrecoverable(self, authority: SessionLease) -> None:
        ref = self._ref(authority.session_id)

        async def txn(transaction: Any) -> None:
            session, _project = await self._require_lease_state(transaction, ref, authority, True)
            recovery = session.workspace_recovery
            if recovery is None or recovery.status != "UNRECOVERABLE":
                raise RuntimeError("Workspace loss is not confirmed.")
            sandbox_ids = [recovery.sandbox_id]
            if session.sandbox_id is not None:
                sandbox_ids.append(session.sandbox_id)
            await self._metering.assert_sandboxes_stopped_in(
                transaction,
                session.owner_uid,
                _unique([*session.reservation_ids, *session.specialist_reservation_ids]),
                _unique(sandbox_ids),
            )
            # Reservation documents and both id lists stay. Their status, not this session, governs accounting.
            transaction.update(ref, {
                "status": "FAILED",
                "error": "The latest unsaved workspace changes could not be recovered.",
                "sandboxId": DELETE_FIELD,
                "claimedBy": DELETE_FIELD,
                "leaseToken": DELETE_FIELD,
                "claimableAt": DELETE_FIELD,
                "queuedTurnPending": DELETE_FIELD,
                "pendingSteer": DELETE_FIELD,
                "updatedAt": SERVER_TIMESTAMP,
            })
            transaction.update(self._projects.ref_for(session.project_id), {
                "activeSessionId": None,
                "updatedAt": SERVER_TIMESTAMP,
            })

        await run_transaction(self._firestore, txn)

    async def finish(
        self,
        session_id: str,
        authority: SessionLease,
        outcome: SessionOutcome,
        now: datetime | None = None,
    ) -> Literal["IDLE", "FAILED", "QUEUED"]:
        ref = self._ref(session_id)
        instant = _now(now)

        async def txn(transaction: Any) -> Literal["IDLE", "FAILED", "QUEUED"]:
            session, _project = await self._require_lease_state(transaction, ref, authority, True)
            if session.workspace_recovery is not None and session.workspace_recovery.status == "REQUIRED":
                raise RuntimeError("Unsaved workspace prevents finalization.")
            if session.cancel_requested is True and outcome.status == "IDLE":
                raise AppError(
                    code="session/cancelled",
                    status_code=409,
                    message="Cancelled by user",
                    details={"sessionId": session.id},
                )
            queued_count = 0
            if outcome.status == "IDLE":
                queued = ref.collection(QUEUED_MESSAGES_COLLECTION_NAME).limit(1)
                queued_count = len([doc async for doc in queued.stream(transaction=transaction)])
            pending = outcome.status == "IDLE" and (session.pending_steer is not None or queued_count > 0)
            status: Literal["IDLE", "FAILED", "QUEUED"] = "QUEUED" if pending else outcome.status
            if session.specialist_reservation_ids:
                await self._metering.release_in(
                    transaction, session.owner_uid, list(session.specialist_reservation_ids), instant,
                )
            updates: dict[str, Any] = {
                "status": status,
                "error": outcome.error if outcome.status == "FAILED" else DELETE_FIELD,
                "claimedBy": DELETE_FIELD,
                "leaseToken": DELETE_FIELD,
                "claimableAt": from_date(instant) if pending else DELETE_FIELD,
                "queuedTurnPending": True if pending else DELETE_FIELD,
                "specialistReservationIds": DELETE_FIELD,
                "updatedAt": SERVER_TIMESTAMP,
            }
            if not pending:
                updates["pendingSteer"] = DELETE_FIELD
            transaction.update(ref, updates)
            transaction.update(self._projects.ref_for(session.project_id), {
                "activeSessionId": session.id if pending else None,
                "updatedAt": SERVER_TIMESTAMP,
            })
            return status

        return await run_transaction(self._firestore, txn)
