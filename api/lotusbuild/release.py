"""The git revision packaged beside the process, when CI wrote release.json."""

from __future__ import annotations

import json
import re
from pathlib import Path

_REVISION = re.compile(r"^[0-9a-f]{40,64}$")


def release_revision(root: Path | None = None) -> str | None:
    base = Path(__file__).resolve().parents[2] if root is None else root
    path = base / "release.json"
    try:
        data = path.read_bytes()
    except FileNotFoundError:
        return None
    if len(data) > 4096:
        raise RuntimeError("release.json is larger than any release metadata should be.")
    metadata = json.loads(data.decode("utf8"))
    revision = metadata.get("revision") if isinstance(metadata, dict) else None
    if not isinstance(revision, str) or _REVISION.fullmatch(revision) is None:
        raise RuntimeError("release.json does not carry a valid revision.")
    return revision
