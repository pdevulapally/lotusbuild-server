"""Projects owned by an account, including the single active-session guard."""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from lotusbuild.errors import AppError
from lotusbuild.firestore_util import DELETE_FIELD, Increment, SERVER_TIMESTAMP, document_data, run_transaction
from lotusbuild.support.documents import (
    DocumentShapeError,
    count_field,
    enum_field,
    optional_string_field,
    string_field,
    timestamp_field,
)
from lotusbuild.entitlements.schema import PLATFORMS

PROJECTS_COLLECTION_PATH = "projects"
SESSIONS_COLLECTION_PATH = "sessions"
MESSAGES_COLLECTION_NAME = "messages"
PROJECT_NAME_MAX_LENGTH = 100
PROJECT_DESCRIPTION_MAX_LENGTH = 500
PROJECT_STATUSES = ("draft", "deleting")
_GENERATION = re.compile(r"^[1-9]\d*$")


@dataclass(frozen=True)
class Project:
    id: str
    owner_uid: str
    name: str
    description: str | None
    platform: str
    status: str
    snapshot_bytes: int
    snapshot: dict[str, Any]
    snapshot_upload_id: str | None
    public_preview_enabled: bool
    active_session_id: str | None
    active_session_known: bool
    created_at: datetime


def project_session_active_error() -> AppError:
    return AppError(code="project/session-active", status_code=409, message="Another session is currently active for this project.")


def project_session_guard_unmigrated_error() -> AppError:
    return AppError(code="project/session-guard-unmigrated", status_code=503, message="This project is not ready to start a session yet.")


def _active_session_id(fields: dict[str, Any], where: str) -> tuple[bool, str | None]:
    if "activeSessionId" not in fields:
        return False, None
    value = fields["activeSessionId"]
    if value is None:
        return True, None
    if not isinstance(value, str) or value.strip() == "":
        raise DocumentShapeError(f'{where}: field "activeSessionId" must be a non-empty string or null.')
    return True, value


def _stored_snapshot(fields: dict[str, Any], where: str, snapshot_bytes: int) -> dict[str, Any]:
    has_name = "snapshotObjectName" in fields
    has_generation = "snapshotObjectGeneration" in fields
    if has_name != has_generation:
        raise DocumentShapeError(f"{where}: snapshotObjectName and snapshotObjectGeneration must either both exist or both be absent.")
    if not has_name:
        return {"kind": "none"} if snapshot_bytes == 0 else {"kind": "legacy"}
    if snapshot_bytes == 0:
        raise DocumentShapeError(f"{where}: an immutable snapshot cannot have zero recorded bytes.")
    object_name = string_field(fields, "snapshotObjectName", where)
    generation = string_field(fields, "snapshotObjectGeneration", where)
    if _GENERATION.fullmatch(generation) is None:
        raise DocumentShapeError(f'{where}: field "snapshotObjectGeneration" must be a positive decimal generation.')
    return {"kind": "immutable", "objectName": object_name, "generation": generation}


def parse_project(project_id: str, fields: dict[str, Any], where: str) -> Project:
    snapshot_bytes = count_field(fields, "snapshotBytes", where)
    known, active = _active_session_id(fields, where)
    upload = fields.get("snapshotUploadId")
    return Project(
        id=project_id,
        owner_uid=string_field(fields, "ownerUid", where),
        name=string_field(fields, "name", where),
        description=optional_string_field(fields, "description"),
        platform=enum_field(fields, "platform", where, PLATFORMS),
        status=enum_field(fields, "status", where, PROJECT_STATUSES),
        snapshot_bytes=snapshot_bytes,
        snapshot=_stored_snapshot(fields, where, snapshot_bytes),
        snapshot_upload_id=upload if isinstance(upload, str) else None,
        public_preview_enabled=fields.get("publicPreviewEnabled") is True,
        active_session_id=active,
        active_session_known=known,
        created_at=timestamp_field(fields, "createdAt", where),
    )


class ProjectRepository:
    def __init__(
        self,
        firestore: Any,
        users: Any,
        entitlements: Any,
        metering: Any = None,
        configuration: Any = None,
        snapshots: Any = None,
        erase_session_events: Any = None,
    ) -> None:
        self._firestore = firestore
        self._users = users
        self._entitlements = entitlements
        self._metering = metering
        self._configuration = configuration
        self._snapshots = snapshots
        self._erase_session_events = erase_session_events

    def ref_for(self, project_id: str) -> Any:
        return self._firestore.document(f"{PROJECTS_COLLECTION_PATH}/{project_id}")

    def _validate_name(self, name: str) -> None:
        if name.strip() == "":
            raise AppError(code="project/invalid-name", status_code=400, message="Project name must contain a non-whitespace character.")

    async def create(self, owner_uid: str, *, name: str, description: str | None, platform: str) -> Project:
        self._validate_name(name)
        entitlements = await self._entitlements.for_user(owner_uid)
        platform_capability = f"platform.{platform}"
        if not entitlements.capabilities.boolean(platform_capability):
            raise AppError(
                code="project/platform-not-permitted",
                status_code=403,
                message=f"The {entitlements.plan_name} plan cannot build {platform} projects.",
                details={"platform": platform, "plan": entitlements.plan_key},
            )
        limit = entitlements.capabilities.number("projects.max")
        ref = self._firestore.collection(PROJECTS_COLLECTION_PATH).document()
        user_ref = self._users.ref_for(owner_uid)

        async def txn(transaction: Any) -> datetime:
            user = await self._users.read_in_transaction(transaction, owner_uid)
            if user.project_count >= limit:
                raise AppError(
                    code="project/limit-reached",
                    status_code=403,
                    message=f"The {entitlements.plan_name} plan allows {limit} projects.",
                    details={"limit": limit, "current": user.project_count, "plan": entitlements.plan_key},
                )
            transaction.create(ref, {
                "ownerUid": owner_uid,
                "name": name,
                "description": description,
                "platform": platform,
                "status": "draft",
                "activeSessionId": None,
                "createdAt": SERVER_TIMESTAMP,
                "updatedAt": SERVER_TIMESTAMP,
            })
            transaction.update(user_ref, {"projectCount": Increment(1), "updatedAt": SERVER_TIMESTAMP})
            return datetime.now(timezone.utc)

        created_at = await run_transaction(self._firestore, txn)
        return Project(ref.id, owner_uid, name, description, platform, "draft", 0, {"kind": "none"}, None, False, None, True, created_at)

    async def update(self, owner_uid: str, project_id: str, *, name: str | None = None, description: str | None = None) -> Project:
        if name is not None:
            self._validate_name(name)
        existing = await self.read_owned(owner_uid, project_id)
        if name is None and description is None:
            return existing
        updates: dict[str, Any] = {"updatedAt": SERVER_TIMESTAMP}
        if name is not None:
            updates["name"] = name
        if description is not None:
            updates["description"] = DELETE_FIELD if description == "" else description
        await self.ref_for(project_id).update(updates)
        return Project(
            existing.id, existing.owner_uid,
            name if name is not None else existing.name,
            None if description == "" else (description if description is not None else existing.description),
            existing.platform, existing.status, existing.snapshot_bytes, existing.snapshot,
            existing.snapshot_upload_id, existing.public_preview_enabled, existing.active_session_id,
            existing.active_session_known, existing.created_at,
        )

    async def set_public_preview(self, owner_uid: str, project_id: str, enabled: bool) -> dict[str, bool]:
        ref = self.ref_for(project_id)

        async def txn(transaction: Any) -> dict[str, bool]:
            snapshot = await ref.get(transaction=transaction)
            project = self._owned_from_snapshot(owner_uid, ref.path, snapshot)
            if not project.active_session_known:
                raise project_session_guard_unmigrated_error()
            if enabled and project.active_session_id is not None:
                raise AppError(code="project/session-active", status_code=409, message="Finish the current session before enabling public previews.")
            active = None if project.active_session_id is None else self._firestore.document(f"sessions/{project.active_session_id}")
            termination_pending = False
            if active is not None:
                session = await active.get(transaction=transaction)
                data = document_data(session)
                if data.get("ownerUid") != owner_uid or data.get("projectId") != project_id:
                    raise RuntimeError("Project session guard disagrees.")
                termination_pending = project.public_preview_enabled is True and data.get("status") == "RUNNING"
            transaction.update(ref, {"publicPreviewEnabled": enabled, "updatedAt": SERVER_TIMESTAMP})
            if active is not None and termination_pending:
                transaction.update(active, {"cancelRequested": True, "updatedAt": SERVER_TIMESTAMP})
            return {"enabled": enabled, "terminationPending": termination_pending}

        return await run_transaction(self._firestore, txn)

    async def delete(self, owner_uid: str, project_id: str) -> None:
        ref = self.ref_for(project_id)
        user_ref = self._users.ref_for(owner_uid)

        async def mark(transaction: Any) -> None:
            snapshot = await ref.get(transaction=transaction)
            project = self._owned_from_snapshot(owner_uid, ref.path, snapshot, allow_deleting=True)
            if not project.active_session_known:
                raise project_session_guard_unmigrated_error()
            if project.active_session_id is not None:
                raise project_session_active_error()
            transaction.update(ref, {"status": "deleting", "updatedAt": SERVER_TIMESTAMP})

        await run_transaction(self._firestore, mark)
        while True:
            page = []
            query = (
                self._firestore.collection(SESSIONS_COLLECTION_PATH)
                .where("projectId", "==", project_id)
                .limit(100)
            )
            async for doc in query.stream():
                page.append(doc)
            if not page:
                break
            for session in page:
                if self._erase_session_events is None:
                    raise RuntimeError("Session event erasure is not configured.")
                await self._erase_session_events(session.id)
                await self._firestore.recursive_delete(session.reference.collection(MESSAGES_COLLECTION_NAME))
                await self._firestore.recursive_delete(session.reference.collection("queued_messages"))
                await session.reference.delete()
        if self._snapshots is None:
            raise RuntimeError("Project deletion requires the snapshot store. Cleanup remains pending.")
        if self._metering is None:
            raise RuntimeError("Storage accounting is not configured.")
        from lotusbuild.storage.maintenance import SnapshotMaintenance

        await SnapshotMaintenance(self._firestore, self._metering, self._snapshots).delete_project(project_id)
        deleting = await ref.get()
        deleting_project = self._owned_from_snapshot(owner_uid, ref.path, deleting, allow_deleting=True)
        if deleting_project.snapshot_upload_id is None:
            await self._snapshots.remove_stored(project_id, deleting_project.snapshot)
        await self._snapshots.erase_project_content(project_id)

        async def finalize(transaction: Any) -> None:
            snapshot = await ref.get(transaction=transaction)
            if not snapshot.exists:
                return
            project = self._owned_from_snapshot(owner_uid, ref.path, snapshot, allow_deleting=True)
            if project.status != "deleting" or project.active_session_id is not None:
                raise RuntimeError("Project deletion lost its tombstone.")
            if project.snapshot_bytes > 0 and project.snapshot_upload_id is None:
                if self._metering is None or self._configuration is None:
                    raise RuntimeError("Project deletion requires storage accounting.")
                registry = (await self._configuration.get()).registry
                await self._metering.set_gauge_in(
                    transaction,
                    uid=owner_uid,
                    entitlements=await self._entitlements.for_user(owner_uid),
                    meter_key=registry.storage_meter_key,
                    previous_quantity=project.snapshot_bytes,
                    quantity=0,
                    now=datetime.now(timezone.utc),
                )
            transaction.delete(ref)
            transaction.update(user_ref, {"projectCount": Increment(-1), "updatedAt": SERVER_TIMESTAMP})

        await run_transaction(self._firestore, finalize)

    async def read_owned_in_transaction(self, transaction: Any, owner_uid: str, project_id: str, allow_erasing: bool = False) -> Project:
        ref = self.ref_for(project_id)
        snapshot = await ref.get(transaction=transaction)
        if not allow_erasing:
            erasure = await self._firestore.document(f"accountErasures/{owner_uid}").get(transaction=transaction)
            if erasure.exists:
                raise AppError(code="account/erasure-pending", status_code=403, message="This account is closed or being erased.")
        return self._owned_from_snapshot(owner_uid, ref.path, snapshot)

    async def list_owned_by(self, owner_uid: str, limit: int) -> list[Project]:
        query = (
            self._firestore.collection(PROJECTS_COLLECTION_PATH)
            .where("ownerUid", "==", owner_uid)
            .order_by("createdAt", direction="DESCENDING")
            .limit(limit)
        )
        return [parse_project(doc.id, doc.to_dict() or {}, doc.reference.path) async for doc in query.stream()]

    async def read_owned(self, owner_uid: str, project_id: str) -> Project:
        ref = self.ref_for(project_id)
        snapshot = await ref.get()
        return self._owned_from_snapshot(owner_uid, ref.path, snapshot)

    def _owned_from_snapshot(self, owner_uid: str, path: str, snapshot: Any, allow_deleting: bool = False) -> Project:
        missing = AppError(code="project/not-found", status_code=404, message="No such project.")
        if not snapshot.exists:
            raise missing
        project = parse_project(snapshot.id, document_data(snapshot), path)
        if project.owner_uid != owner_uid:
            raise missing
        if project.status == "deleting" and not allow_deleting:
            raise AppError(
                code="project/deleting",
                status_code=409,
                message="This project is being deleted. Retry deletion to complete pending cleanup.",
            )
        return project
