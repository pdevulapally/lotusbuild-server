"""package.json is the one release capability declaration, shared with packaging."""

from __future__ import annotations

import json
from pathlib import Path

from lotusbuild.errors import AppError

_SUPPORTED: int | None = None


def _protocol(value: object) -> int:
    if not isinstance(value, dict):
        raise ValueError("Invalid protocol metadata.")
    version = value.get("runnerRecoveryProtocol")
    if not isinstance(version, int) or isinstance(version, bool) or version < 1 or version > 2147483647:
        raise ValueError("Invalid protocol metadata.")
    return version


def runner_recovery_protocol() -> int:
    global _SUPPORTED
    if _SUPPORTED is not None:
        return _SUPPORTED
    root = Path(__file__).resolve().parents[3]
    try:
        _SUPPORTED = _protocol(json.loads((root / "package.json").read_text(encoding="utf8")))
    except Exception as cause:
        raise AppError(
            code="release/recovery-protocol-incompatible",
            status_code=503,
            message="Release recovery protocol metadata is invalid.",
        ) from cause
    return _SUPPORTED
