"""Durable snapshot cleanup used when a project is deleted."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from lotusbuild.firestore_util import DELETE_FIELD, SERVER_TIMESTAMP, document_data, run_transaction
from lotusbuild.support.documents import integer_field, string_field


class SnapshotMaintenance:
    def __init__(self, firestore: Any, metering: Any, snapshots: Any) -> None:
        self._firestore = firestore
        self._metering = metering
        self._snapshots = snapshots

    async def delete_project(self, project_id: str) -> None:
        while True:
            query = (
                self._firestore.collection("snapshotUploads")
                .where("projectId", "==", project_id)
                .where("status", "in", ["CANDIDATE", "CURRENT", "OBSOLETE", "CLEANING"])
                .limit(100)
            )
            page = [doc async for doc in query.stream()]
            if not page:
                return
            for doc in page:
                await self._collect(doc.id, True)

    async def _collect(self, upload_id: str, deleting_project: bool) -> None:
        ref = self._firestore.document(f"snapshotUploads/{upload_id}")

        async def claim(tx: Any) -> dict[str, Any] | None:
            snapshot = await ref.get(transaction=tx)
            fields = document_data(snapshot) if snapshot.exists else None
            if fields is None or fields.get("status") == "DELETED":
                return None
            project_id = string_field(fields, "projectId", ref.path)
            project = await self._firestore.document(f"projects/{project_id}").get(transaction=tx)
            project_data = document_data(project)
            if deleting_project:
                if project_data.get("status") != "deleting" or project_data.get("activeSessionId") is not None:
                    raise RuntimeError("Project deletion is not fenced.")
            elif fields.get("status") == "CURRENT" or project_data.get("snapshotUploadId") == upload_id:
                return None
            charged = fields.get("charged") is True or fields.get("status") in ("CURRENT", "OBSOLETE")
            tx.update(ref, {"status": "CLEANING", "charged": charged})
            return {**fields, "charged": charged}

        claimed = await run_transaction(self._firestore, claim)
        if claimed is None:
            return
        project_id = string_field(claimed, "projectId", ref.path)
        if claimed.get("legacy") is True:
            await self._snapshots.remove_stored(project_id, {"kind": "legacy"})
        else:
            await self._snapshots.remove_retired_upload(string_field(claimed, "objectName", ref.path))

        async def finish(tx: Any) -> None:
            snapshot = await ref.get(transaction=tx)
            fields = document_data(snapshot)
            if fields.get("status") == "DELETED":
                return
            if fields.get("status") != "CLEANING":
                raise RuntimeError("Snapshot cleanup lost its claim.")
            uid = string_field(fields, "ownerUid", ref.path)
            if fields.get("charged") is True:
                await self._metering.remove_stored_bytes_in(tx, uid, integer_field(fields, "bytes", ref.path, min_value=1))
            else:
                await self._metering.release_in(tx, uid, [string_field(fields, "reservationId", ref.path)], datetime.now(timezone.utc))
            tx.update(ref, {
                "status": "DELETED",
                "deletedAt": SERVER_TIMESTAMP,
                "ownerUid": DELETE_FIELD,
                "leaseToken": DELETE_FIELD,
                "reservationId": DELETE_FIELD,
                "projectId": DELETE_FIELD,
                "objectName": DELETE_FIELD,
            })

        await run_transaction(self._firestore, finish)
