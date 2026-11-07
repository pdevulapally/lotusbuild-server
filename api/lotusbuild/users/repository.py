"""Account records. Created on first /me, then relied on by every later route."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from lotusbuild.errors import AppError
from lotusbuild.firestore_util import DELETE_FIELD, SERVER_TIMESTAMP, document_data, run_transaction
from lotusbuild.support.documents import integer_field, optional_string_field, string_field

USERS_COLLECTION_PATH = "users"


@dataclass(frozen=True)
class AuthenticatedUser:
    uid: str
    email: str | None
    email_verified: bool
    display_name: str | None
    photo_url: str | None
    auth_time: int
    expires_at: int | None = None


@dataclass(frozen=True)
class UserRecord:
    uid: str
    email: str
    display_name: str | None
    photo_url: str | None
    project_count: int


def parse_user(fields: dict[str, Any], where: str) -> UserRecord:
    return UserRecord(
        uid=string_field(fields, "uid", where),
        email=string_field(fields, "email", where),
        display_name=optional_string_field(fields, "displayName"),
        photo_url=optional_string_field(fields, "photoUrl"),
        project_count=integer_field(fields, "projectCount", where, min_value=0),
    )


class UserRepository:
    def __init__(self, firestore: Any) -> None:
        self._firestore = firestore

    def ref_for(self, uid: str) -> Any:
        return self._firestore.document(f"{USERS_COLLECTION_PATH}/{uid}")

    async def ensure(self, user: AuthenticatedUser) -> UserRecord:
        ref = self.ref_for(user.uid)

        async def txn(transaction: Any) -> UserRecord:
            erased = await self._firestore.document(f"accountErasures/{user.uid}").get(transaction=transaction)
            if erased.exists:
                raise AppError(code="account/erasure-pending", status_code=403, message="This account is closed or being erased.")
            snapshot = await ref.get(transaction=transaction)
            if not snapshot.exists:
                created = UserRecord(user.uid, user.email or "", user.display_name, user.photo_url, 0)
                if created.email == "":
                    raise AppError(
                        code="auth/email-required",
                        status_code=403,
                        message="This account has no email address, which this service requires.",
                    )
                transaction.create(ref, {
                    "uid": created.uid,
                    "email": created.email,
                    "displayName": created.display_name,
                    "photoUrl": created.photo_url,
                    "projectCount": created.project_count,
                    "createdAt": SERVER_TIMESTAMP,
                    "updatedAt": SERVER_TIMESTAMP,
                })
                return created
            stored = parse_user(document_data(snapshot), ref.path)
            changed = (
                (user.email is not None and user.email != stored.email)
                or user.display_name != stored.display_name
                or user.photo_url != stored.photo_url
            )
            if not changed:
                return stored
            refreshed = UserRecord(
                stored.uid,
                user.email or stored.email,
                user.display_name,
                user.photo_url,
                stored.project_count,
            )
            transaction.update(ref, {
                "email": refreshed.email,
                "displayName": refreshed.display_name if refreshed.display_name is not None else DELETE_FIELD,
                "photoUrl": refreshed.photo_url if refreshed.photo_url is not None else DELETE_FIELD,
                "updatedAt": SERVER_TIMESTAMP,
            })
            return refreshed

        return await run_transaction(self._firestore, txn)

    async def read_in_transaction(self, transaction: Any, uid: str) -> UserRecord:
        ref = self.ref_for(uid)
        snapshot = await ref.get(transaction=transaction)
        family = await self._firestore.document(f"familyLinks/{uid}").get(transaction=transaction)
        erased = await self._firestore.document(f"accountErasures/{uid}").get(transaction=transaction)
        if erased.exists:
            raise AppError(code="account/erasure-pending", status_code=403, message="This account is closed or being erased.")
        if family.exists:
            raise AppError(
                code="family/parent-owned-account-required",
                status_code=403,
                message="Linked child accounts use projects owned and controlled by their parent.",
            )
        if not snapshot.exists:
            raise AppError(
                code="user/not-initialised",
                status_code=409,
                message="This account has not been initialised. Call /me once before creating resources.",
            )
        return parse_user(document_data(snapshot), ref.path)

    async def read(self, uid: str) -> UserRecord:
        ref = self.ref_for(uid)
        family = await self._firestore.document(f"familyLinks/{uid}").get()
        erasure = await self._firestore.document(f"accountErasures/{uid}").get()
        if family.exists or erasure.exists:
            raise AppError(
                code="account/billing-unavailable",
                status_code=403,
                message="Billing is unavailable for linked child accounts and accounts being erased.",
            )
        snapshot = await ref.get()
        if not snapshot.exists:
            raise AppError(
                code="user/not-initialised",
                status_code=409,
                message="This account has not been initialised. Call /me once before creating resources.",
            )
        return parse_user(document_data(snapshot), ref.path)
