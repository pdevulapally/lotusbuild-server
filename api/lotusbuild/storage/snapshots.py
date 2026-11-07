"""Durable project snapshots in Cloud Storage.

Only the gzipped `.git` directory is kept. What belongs in it is whatever the
project's own `.gitignore` says belongs in it.
"""

from __future__ import annotations

import asyncio
import re
from datetime import datetime, timedelta, timezone
from typing import Any

from google.api_core.exceptions import NotFound, PreconditionFailed
from google.cloud import storage

from lotusbuild.errors import AppError, EnvironmentError, is_safe_integer

SNAPSHOT_CONTENT_TYPE = "application/gzip"
_GENERATION = re.compile(r"^[1-9]\d*$")
_PROJECT_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


def missing_snapshot_error(project_id: str, snapshot: dict[str, Any]) -> AppError:
    details: dict[str, Any] = {"projectId": project_id, "snapshot": snapshot["kind"]}
    if snapshot["kind"] == "immutable":
        details["generation"] = snapshot["generation"]
    return AppError(
        code="project/snapshot-missing",
        status_code=500,
        message="The saved project could not be restored.",
        details=details,
    )


class SnapshotStore:
    def __init__(self, credentials: Any, project_id: str, bucket_name: str, ttl_seconds: int) -> None:
        if not is_safe_integer(ttl_seconds) or int(ttl_seconds) <= 0:
            raise ValueError("A signed URL lifetime must be a positive number of seconds.")
        self._ttl_seconds = int(ttl_seconds)
        self._bucket_name = bucket_name
        self._client = storage.Client(project=project_id, credentials=credentials)

    def _bucket(self) -> Any:
        return self._client.bucket(self._bucket_name)

    def _expiry(self) -> datetime:
        return datetime.now(timezone.utc) + timedelta(seconds=self._ttl_seconds)

    def candidate_name(self, project_id: str, lease_token: str) -> str:
        for name, value in (("projectId", project_id), ("leaseToken", lease_token)):
            if value.strip() == "" or "/" in value or "\\" in value:
                raise ValueError(f"A snapshot {name} must be a non-empty path segment.")
        return f"projects/{project_id}/snapshots/{lease_token}.tar.gz"

    async def assert_reachable(self) -> None:
        def check() -> None:
            bucket = self._bucket()
            try:
                exists = bucket.exists()
            except Exception as cause:
                raise EnvironmentError([
                    "FIREBASE_STORAGE_BUCKET could not be reached; check its configuration and access permissions.",
                ]) from cause
            if not exists:
                raise EnvironmentError(["FIREBASE_STORAGE_BUCKET does not exist, so no project could be saved."])
            bucket.reload()
            iam = bucket.iam_configuration
            uniform = getattr(iam, "uniform_bucket_level_access_enabled", None)
            prevention = getattr(iam, "public_access_prevention", None)
            if uniform is not True or prevention != "enforced":
                raise EnvironmentError([
                    "Snapshot storage requires uniform bucket-level access and explicitly enforced public access prevention.",
                ])
            policy = bucket.get_iam_policy(requested_policy_version=3)
            for binding in policy.bindings or []:
                members = binding.get("members") if isinstance(binding, dict) else getattr(binding, "members", None)
                if members and any(member in {"allUsers", "allAuthenticatedUsers"} for member in members):
                    raise EnvironmentError([
                        "Snapshot storage has a public IAM binding; remove it before starting the runner.",
                    ])

        await asyncio.to_thread(check)

    async def read_url(self, project_id: str, snapshot: dict[str, Any]) -> str:
        def sign() -> str:
            bucket = self._bucket()
            blob = (
                bucket.blob(f"projects/{project_id}/repo.tar.gz")
                if snapshot["kind"] == "legacy"
                else bucket.blob(snapshot["objectName"], generation=int(snapshot["generation"]))
            )
            if not blob.exists():
                raise missing_snapshot_error(project_id, snapshot)
            return blob.generate_signed_url(version="v4", expiration=self._expiry(), method="GET")

        return await asyncio.to_thread(sign)

    async def create_upload(self, project_id: str, lease_token: str, byte_count: int, before_sign) -> dict[str, str]:
        if not is_safe_integer(byte_count) or int(byte_count) <= 0:
            raise ValueError("A snapshot upload needs an exact positive byte count.")
        object_name = self.candidate_name(project_id, lease_token)
        expires_at = self._expiry()
        await before_sign(object_name, expires_at)
        if expires_at.timestamp() <= datetime.now(timezone.utc).timestamp():
            raise RuntimeError("Snapshot upload admission expired.")

        def sign() -> str:
            blob = self._bucket().blob(object_name)
            return blob.generate_signed_url(
                version="v4",
                expiration=expires_at,
                method="PUT",
                content_type=SNAPSHOT_CONTENT_TYPE,
                headers={
                    "x-goog-if-generation-match": "0",
                    "content-length": str(int(byte_count)),
                },
            )

        return {"objectName": object_name, "url": await asyncio.to_thread(sign)}

    async def inspect_upload(self, object_name: str) -> dict[str, Any]:
        def inspect() -> dict[str, Any]:
            blob = self._bucket().blob(object_name)
            blob.reload()
            generation = blob.generation
            generation_text = str(generation) if isinstance(generation, (str, int)) and not isinstance(generation, bool) else ""
            if not _GENERATION.fullmatch(generation_text):
                raise RuntimeError(f'Snapshot object "{object_name}" has no valid generation.')
            stored_size = blob.size
            if isinstance(stored_size, str) and stored_size.isdigit():
                byte_count: float = int(stored_size)
            elif isinstance(stored_size, (int, float)) and not isinstance(stored_size, bool):
                byte_count = stored_size
            else:
                byte_count = float("nan")
            if not is_safe_integer(byte_count) or int(byte_count) <= 0:
                raise RuntimeError(f'Snapshot object "{object_name}" has no valid byte size.')
            if blob.content_type != SNAPSHOT_CONTENT_TYPE:
                raise RuntimeError(
                    f'Snapshot object "{object_name}" has content type "{blob.content_type}" rather than "{SNAPSHOT_CONTENT_TYPE}".',
                )
            return {"objectName": object_name, "generation": generation_text, "bytes": int(byte_count)}

        return await asyncio.to_thread(inspect)

    async def retire_upload(self, object_name: str) -> None:
        def retire() -> None:
            blob = self._bucket().blob(object_name)
            for _attempt in range(3):
                generation: int | str = 0
                try:
                    blob.reload()
                    generation = blob.generation or 0
                except NotFound:
                    generation = 0
                if generation != 0 and not _GENERATION.fullmatch(str(generation)):
                    raise RuntimeError("Missing generation during snapshot retirement.")
                try:
                    blob.cache_control = "no-store"
                    blob.upload_from_string(
                        b"",
                        content_type="application/octet-stream",
                        if_generation_match=int(generation),
                    )
                    return
                except PreconditionFailed:
                    continue
            raise RuntimeError("Snapshot retirement raced an upload; cleanup remains pending.")

        await asyncio.to_thread(retire)

    async def remove_retired_upload(self, object_name: str) -> None:
        await self.retire_upload(object_name)
        page_token: str | None = None
        while True:
            rows, page_token = await asyncio.to_thread(self._page, object_name, page_token)
            for name, generation, size in rows:
                if name != object_name:
                    continue
                if not is_safe_integer(size) or int(size) < 0:
                    raise RuntimeError("Invalid object size during snapshot cleanup.")
                if int(size) == 0:
                    continue
                generation_text = str(generation or "")
                if not _GENERATION.fullmatch(generation_text):
                    raise RuntimeError("Missing object generation during snapshot cleanup.")
                await asyncio.to_thread(self._delete_generation, object_name, generation_text)
            if not page_token:
                return

    async def erase_project_content(self, project_id: str) -> None:
        if _PROJECT_ID.fullmatch(project_id) is None:
            raise ValueError("Invalid project id.")
        prefix = f"projects/{project_id}/"
        page_token: str | None = None
        while True:
            rows, page_token = await asyncio.to_thread(self._page, prefix, page_token)
            for name, generation, size in rows:
                if not is_safe_integer(size) or int(size) < 0:
                    raise RuntimeError("Invalid stored object size during erasure.")
                if int(size) == 0:
                    continue
                generation_text = str(generation or "")
                if not _GENERATION.fullmatch(generation_text):
                    raise RuntimeError("Missing object generation during erasure.")
                await self.retire_upload(name)
                await asyncio.to_thread(self._delete_generation, name, generation_text)
            if not page_token:
                return

    async def remove_stored(self, project_id: str, snapshot: dict[str, Any]) -> None:
        if snapshot.get("kind") == "none":
            return

        def delete() -> None:
            bucket = self._bucket()
            if snapshot["kind"] == "legacy":
                bucket.blob(f"projects/{project_id}/repo.tar.gz").delete(if_generation_match=None)
                return
            blob = bucket.blob(snapshot["objectName"], generation=int(snapshot["generation"]))
            try:
                blob.delete(if_generation_match=int(snapshot["generation"]))
            except NotFound:
                return

        def delete_legacy() -> None:
            try:
                self._bucket().blob(f"projects/{project_id}/repo.tar.gz").delete()
            except NotFound:
                return

        if snapshot["kind"] == "legacy":
            await asyncio.to_thread(delete_legacy)
            return
        await asyncio.to_thread(delete)

    async def remove(self, project_id: str) -> None:
        def wipe() -> None:
            try:
                self._bucket().blob(f"projects/{project_id}/repo.tar.gz").delete()
            except NotFound:
                pass
            self._bucket().delete_blobs(list(self._client.list_blobs(self._bucket_name, prefix=f"projects/{project_id}/snapshots/")))

        await asyncio.to_thread(wipe)

    def _page(self, prefix: str, page_token: str | None) -> tuple[list[tuple[str, Any, Any]], str | None]:
        iterator = self._client.list_blobs(
            self._bucket_name,
            prefix=prefix,
            versions=True,
            max_results=100,
            page_token=page_token,
        )
        page = next(iterator.pages, None)
        if page is None:
            return [], None
        rows = [(blob.name, blob.generation, blob.size) for blob in page]
        return rows, iterator.next_page_token

    def _delete_generation(self, object_name: str, generation: str) -> None:
        blob = self._bucket().blob(object_name, generation=int(generation))
        try:
            blob.delete(if_generation_match=int(generation))
        except NotFound:
            return
