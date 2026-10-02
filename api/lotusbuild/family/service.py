"""Family links grant access to specific projects, never the parent's identity or billing account."""

from __future__ import annotations

import hashlib
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from lotusbuild.errors import AppError
from lotusbuild.firestore_util import DELETE_FIELD, SERVER_TIMESTAMP, document_data, from_date, run_transaction
from lotusbuild.support.documents import string_field, timestamp_field
from lotusbuild.timeutil import to_iso
from lotusbuild.users.repository import AuthenticatedUser


def _denied() -> AppError:
    return AppError(code="family/access-denied", status_code=403, message="This family access is not authorized.")


def _verified(user: AuthenticatedUser) -> None:
    if not user.email_verified:
        raise AppError(code="family/email-verification-required", status_code=403, message="Verify your email before linking family accounts.")


class FamilyService:
    def __init__(self, db: Any, invitation_ttl_seconds: int) -> None:
        if not isinstance(invitation_ttl_seconds, int) or invitation_ttl_seconds <= 0:
            raise ValueError("Invalid family invitation lifetime.")
        self._db = db
        self._invitation_ttl = invitation_ttl_seconds

    async def invite(self, parent: AuthenticatedUser, *, adult_confirmed: bool, parental_responsibility_confirmed: bool) -> dict[str, Any]:
        _verified(parent)
        if not adult_confirmed or not parental_responsibility_confirmed:
            raise _denied()
        token = secrets.token_urlsafe(32)
        expires_at = datetime.now(timezone.utc) + timedelta(seconds=self._invitation_ttl)
        ref = self._db.document(f"familyInvitations/{parent.uid}")

        async def txn(tx: Any) -> None:
            own_link = await self._db.document(f"familyLinks/{parent.uid}").get(transaction=tx)
            erasure = await self._db.document(f"accountErasures/{parent.uid}").get(transaction=tx)
            if erasure.exists or own_link.exists:
                raise _denied()
            tx.set(ref, {
                "tokenHash": hashlib.sha256(token.encode()).hexdigest(),
                "parentUid": parent.uid,
                "status": "PENDING",
                "expiresAt": from_date(expires_at),
                "adultDeclared": True,
                "parentalResponsibilityDeclared": True,
                "declaredAt": SERVER_TIMESTAMP,
            })

        await run_transaction(self._db, txn)
        return {
            "parentUid": parent.uid,
            "token": token,
            "expiresAt": to_iso(expires_at),
            "assurance": "declarations-and-verified-email",
        }

    async def accept(self, child: AuthenticatedUser, parent_uid: str, token: str) -> dict[str, str]:
        _verified(child)
        if parent_uid == child.uid:
            raise _denied()
        invitation = self._db.document(f"familyInvitations/{parent_uid}")
        link = self._db.document(f"familyLinks/{child.uid}")

        async def txn(tx: Any) -> None:
            invite = await invitation.get(transaction=tx)
            old = await link.get(transaction=tx)
            child_account = await self._db.document(f"users/{child.uid}").get(transaction=tx)
            prior_parent = await self._db.document(f"familyInvitations/{child.uid}").get(transaction=tx)
            parent_erasure = await self._db.document(f"accountErasures/{parent_uid}").get(transaction=tx)
            child_erasure = await self._db.document(f"accountErasures/{child.uid}").get(transaction=tx)
            if parent_erasure.exists or child_erasure.exists:
                raise _denied()
            previous = document_data(old) if old.exists else {}
            if previous.get("parentUid") is not None:
                previous_parent = string_field(previous, "parentUid", link.path)
                previous_erasure = await self._db.document(f"accountErasures/{previous_parent}").get(transaction=tx)
                if previous_erasure.exists:
                    raise _denied()
            account = document_data(child_account)
            if account.get("projectCount", 0) != 0 or account.get("stripeCustomerId") is not None or prior_parent.exists:
                raise _denied()
            fields = document_data(invite)
            expires = timestamp_field(fields, "expiresAt", invitation.path) if fields else None
            token_hash = hashlib.sha256(token.encode()).hexdigest()
            if (
                fields.get("status") != "PENDING"
                or fields.get("tokenHash") != token_hash
                or expires is None
                or expires.timestamp() <= datetime.now(timezone.utc).timestamp()
                or (old.exists and document_data(old).get("status") != "REVOKED")
            ):
                raise _denied()
            tx.set(link, {
                "parentUid": parent_uid,
                "childUid": child.uid,
                "childEmail": child.email or "",
                "status": "PENDING",
                "createdAt": SERVER_TIMESTAMP,
            })
            tx.update(invitation, {"status": "CONSUMED", "tokenHash": DELETE_FIELD})

        await run_transaction(self._db, txn)
        return {"status": "PENDING", "message": "The parent must confirm this link before you can access any project."}

    async def confirm(self, parent: AuthenticatedUser, child_uid: str, approve: bool) -> None:
        _verified(parent)
        ref = self._db.document(f"familyLinks/{child_uid}")

        async def txn(tx: Any) -> None:
            snapshot = await ref.get(transaction=tx)
            data = document_data(snapshot)
            if data.get("parentUid") != parent.uid:
                raise _denied()
            if approve and data.get("status") != "PENDING":
                raise _denied()
            tx.update(ref, {"status": "ACTIVE" if approve else "REVOKED", "updatedAt": SERVER_TIMESTAMP})

        await run_transaction(self._db, txn)

    async def _require_link(self, tx: Any, child_uid: str, parent_uid: str | None = None) -> str:
        ref = self._db.document(f"familyLinks/{child_uid}")
        snapshot = await ref.get(transaction=tx)
        fields = document_data(snapshot)
        if fields.get("status") != "ACTIVE" or (parent_uid is not None and fields.get("parentUid") != parent_uid):
            raise _denied()
        return string_field(fields, "parentUid", ref.path)

    async def grant(self, parent: AuthenticatedUser, child_uid: str, project_id: str, enabled: bool) -> None:
        _verified(parent)

        async def txn(tx: Any) -> None:
            await self._require_link(tx, child_uid, parent.uid)
            project = await self._db.document(f"projects/{project_id}").get(transaction=tx)
            data = document_data(project)
            if data.get("ownerUid") != parent.uid or data.get("status") == "deleting":
                raise _denied()
            tx.set(self._db.document(f"familyLinks/{child_uid}/projects/{project_id}"), {
                "enabled": enabled, "updatedAt": SERVER_TIMESTAMP,
            })

        await run_transaction(self._db, txn)

    async def parent_for_project(self, child_uid: str, project_id: str) -> str:
        async def txn(tx: Any) -> str:
            parent_uid = await self._require_link(tx, child_uid)
            grant = await self._db.document(f"familyLinks/{child_uid}/projects/{project_id}").get(transaction=tx)
            project = await self._db.document(f"projects/{project_id}").get(transaction=tx)
            if document_data(grant).get("enabled") is not True or document_data(project).get("ownerUid") != parent_uid or document_data(project).get("status") == "deleting":
                raise _denied()
            erasure = await self._db.document(f"accountErasures/{parent_uid}").get(transaction=tx)
            if erasure.exists:
                raise _denied()
            return parent_uid

        return await run_transaction(self._db, txn)

    async def children(self, parent: AuthenticatedUser, limit: int = 100, after: str | None = None) -> list[dict[str, Any]]:
        _verified(parent)
        from google.cloud.firestore_v1.field_path import FieldPath

        query = self._db.collection("familyLinks").where("parentUid", "==", parent.uid).order_by(FieldPath.document_id())
        if after is not None:
            query = query.start_after({"__name__": after}) if False else query.start_after([after])
        page = query.limit(limit)
        return [{"childUid": doc.id, "email": (doc.to_dict() or {}).get("childEmail"), "status": (doc.to_dict() or {}).get("status")} async for doc in page.stream()]

    async def request_build(self, child_uid: str, project_id: str, *, prompt: str, model: str) -> dict[str, str]:
        ref = self._db.document(f"familyLinks/{child_uid}/buildRequests/{project_id}")

        async def txn(tx: Any) -> dict[str, str]:
            parent_uid = await self._require_link(tx, child_uid)
            grant = await self._db.document(f"familyLinks/{child_uid}/projects/{project_id}").get(transaction=tx)
            project = await self._db.document(f"projects/{project_id}").get(transaction=tx)
            old = await ref.get(transaction=tx)
            erasure = await self._db.document(f"accountErasures/{parent_uid}").get(transaction=tx)
            if erasure.exists or document_data(grant).get("enabled") is not True or document_data(project).get("ownerUid") != parent_uid or document_data(project).get("status") == "deleting":
                raise _denied()
            old_data = document_data(old)
            if old.exists and old_data.get("parentUid") != parent_uid:
                raise _denied()
            if old_data.get("status") in ("PENDING", "APPROVING"):
                raise AppError(code="family/request-pending", status_code=409, message="A build request is already waiting for this project.")
            request_id = str(uuid.uuid4())
            tx.set(ref, {"prompt": prompt, "model": model, "requestId": request_id, "parentUid": parent_uid, "status": "PENDING", "createdAt": SERVER_TIMESTAMP})
            return {"requestId": request_id, "status": "PENDING"}

        return await run_transaction(self._db, txn)

    async def build_requests(self, parent: AuthenticatedUser, child_uid: str, limit: int = 100, after: str | None = None) -> list[dict[str, Any]]:
        _verified(parent)
        await run_transaction(self._db, lambda tx: self._require_link(tx, child_uid, parent.uid))
        from google.cloud.firestore_v1.field_path import FieldPath

        query = (
            self._db.collection(f"familyLinks/{child_uid}/buildRequests")
            .where("parentUid", "==", parent.uid)
            .order_by(FieldPath.document_id())
        )
        if after is not None:
            query = query.start_after([after])
        page = query.limit(limit)
        result = []
        async for doc in page.stream():
            data = doc.to_dict() or {}
            result.append({
                "projectId": doc.id,
                "requestId": data.get("requestId"),
                "status": data.get("status"),
                "prompt": data.get("prompt"),
                "model": data.get("model"),
                "sessionId": data.get("sessionId"),
            })
        return result

    async def decide_build(self, parent: AuthenticatedUser, child_uid: str, project_id: str, request_id: str, approved: bool, sessions: Any) -> dict[str, Any]:
        _verified(parent)
        ref = self._db.document(f"familyLinks/{child_uid}/buildRequests/{project_id}")

        async def txn(tx: Any) -> dict[str, str] | None:
            await self._require_link(tx, child_uid, parent.uid)
            grant = await self._db.document(f"familyLinks/{child_uid}/projects/{project_id}").get(transaction=tx)
            snapshot = await ref.get(transaction=tx)
            fields = document_data(snapshot)
            if document_data(grant).get("enabled") is not True or fields.get("parentUid") != parent.uid or fields.get("requestId") != request_id:
                raise _denied()
            if not approved:
                if fields.get("status") != "PENDING":
                    raise _denied()
                tx.update(ref, {"status": "REJECTED", "prompt": DELETE_FIELD, "updatedAt": SERVER_TIMESTAMP})
                return None
            if str(fields.get("status")) not in ("PENDING", "APPROVING", "FULFILLED"):
                raise _denied()
            session_id = fields["sessionId"] if isinstance(fields.get("sessionId"), str) else f"family-{uuid.uuid4()}"
            if fields.get("status") == "PENDING":
                tx.update(ref, {"status": "APPROVING", "sessionId": session_id, "updatedAt": SERVER_TIMESTAMP})
            return {
                "sessionId": session_id,
                "prompt": string_field(fields, "prompt", ref.path),
                "model": string_field(fields, "model", ref.path),
            }

        request = await run_transaction(self._db, txn)
        if request is None:
            return {"status": "REJECTED"}
        session = await sessions.create(parent.uid, project_id, prompt=request["prompt"], model=request["model"], idempotency_id=request["sessionId"])

        async def fulfill(tx: Any) -> None:
            snapshot = await ref.get(transaction=tx)
            data = document_data(snapshot)
            if data.get("requestId") != request_id or data.get("sessionId") != session.id:
                raise RuntimeError("Family build request changed during approval.")
            tx.update(ref, {"status": "FULFILLED", "updatedAt": SERVER_TIMESTAMP})

        await run_transaction(self._db, fulfill)
        return {"status": "FULFILLED", "sessionId": session.id}
