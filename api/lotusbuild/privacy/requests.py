"""One active privacy request per kind and account."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from lotusbuild.firestore_util import SERVER_TIMESTAMP, document_data, from_date, run_transaction
from lotusbuild.support.documents import enum_field, string_field, timestamp_field
from lotusbuild.timeutil import to_iso

PRIVACY_REQUEST_KINDS = ("access", "erasure", "rectification", "complaint")
STATUSES = ("RECEIVED", "IN_PROGRESS", "COMPLETED")


class PrivacyRequests:
    def __init__(self, firestore: Any) -> None:
        self._firestore = firestore

    def _response(self, fields: dict[str, Any], path: str) -> dict[str, str]:
        return {
            "reference": string_field(fields, "reference", path),
            "kind": enum_field(fields, "kind", path, PRIVACY_REQUEST_KINDS),
            "status": enum_field(fields, "status", path, STATUSES),
            "receivedAt": to_iso(timestamp_field(fields, "receivedAt", path)),
        }

    async def submit(self, uid: str, kind: str) -> dict[str, str]:
        ref = self._firestore.document(f"privacyRequests/{uid}/requests/{kind}")

        async def txn(tx: Any) -> dict[str, str]:
            old = await ref.get(transaction=tx)
            if old.exists and document_data(old).get("status") != "COMPLETED":
                return self._response(document_data(old), ref.path)
            reference = str(uuid.uuid4())
            now = datetime.now(timezone.utc)
            tx.set(ref, {
                "reference": reference,
                "kind": kind,
                "status": "RECEIVED",
                "receivedAt": from_date(now),
                "updatedAt": SERVER_TIMESTAMP,
            })
            return {"reference": reference, "kind": kind, "status": "RECEIVED", "receivedAt": to_iso(now)}

        return await run_transaction(self._firestore, txn)

    async def list(self, uid: str) -> list[dict[str, str]]:
        page = self._firestore.collection(f"privacyRequests/{uid}/requests").limit(len(PRIVACY_REQUEST_KINDS))
        return [self._response(doc.to_dict() or {}, doc.reference.path) async for doc in page.stream()]
