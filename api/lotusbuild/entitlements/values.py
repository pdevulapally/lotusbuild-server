"""Tagged entitlement values: {kind, value}."""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from typing import Any, Literal

from lotusbuild.errors import AppError

EntitlementValueKind = Literal["boolean", "number", "string", "stringList"]
ENTITLEMENT_VALUE_KINDS: tuple[str, ...] = ("boolean", "number", "string", "stringList")


@dataclass(frozen=True)
class EntitlementValue:
    kind: EntitlementValueKind
    value: bool | float | str | tuple[str, ...]


class EntitlementConfigError(AppError):
    def __init__(self, message: str) -> None:
        super().__init__(code="entitlement/misconfigured", status_code=500, message=message)
        self.name = "EntitlementConfigError"


def _valid(kind: str, value: object) -> bool:
    if kind == "boolean":
        return isinstance(value, bool)
    if kind == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value))
    if kind == "string":
        return isinstance(value, str)
    if kind == "stringList":
        return isinstance(value, list) and all(isinstance(item, str) for item in value)
    return False


def parse_entitlement_value(stored: object, expected_kind: str, where: str) -> EntitlementValue:
    if not isinstance(stored, dict):
        raise EntitlementConfigError(f"{where}: expected an object of the form {{kind, value}}.")
    kind = stored.get("kind")
    value = stored.get("value")
    if not isinstance(kind, str) or kind not in ENTITLEMENT_VALUE_KINDS:
        raise EntitlementConfigError(
            f'{where}: "kind" must be one of {", ".join(ENTITLEMENT_VALUE_KINDS)}, got {json.dumps(kind)}.'
        )
    if kind != expected_kind:
        raise EntitlementConfigError(
            f'{where}: the capability declares kind "{expected_kind}" but this value is "{kind}".'
        )
    if not _valid(kind, value):
        raise EntitlementConfigError(f"{where}: {json.dumps(value)} is not a valid {kind}.")
    if kind == "stringList":
        assert isinstance(value, list)
        return EntitlementValue(kind="stringList", value=tuple(dict.fromkeys(value)))
    if kind == "number":
        assert isinstance(value, (int, float)) and not isinstance(value, bool)
        return EntitlementValue(kind="number", value=value)
    if kind == "boolean":
        assert isinstance(value, bool)
        return EntitlementValue(kind="boolean", value=value)
    assert isinstance(value, str)
    return EntitlementValue(kind="string", value=value)
