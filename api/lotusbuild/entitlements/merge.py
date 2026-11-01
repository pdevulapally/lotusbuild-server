"""How two entitlement contributions combine. Direction is the security-critical part."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from lotusbuild.entitlements.values import EntitlementConfigError, EntitlementValue

MergeStrategy = Literal["OVERRIDE", "ADD", "MAX", "MIN", "UNION", "INTERSECTION", "HARD_DENY"]
MERGE_STRATEGIES: tuple[str, ...] = (
    "OVERRIDE", "ADD", "MAX", "MIN", "UNION", "INTERSECTION", "HARD_DENY",
)


@dataclass(frozen=True)
class CapabilityDefinition:
    key: str
    value_kind: str
    merge_strategy: str
    label: str


@dataclass(frozen=True)
class EntitlementContribution:
    source_key: str
    precedence: int
    value: EntitlementValue


def is_merge_strategy(value: object) -> bool:
    return isinstance(value, str) and value in MERGE_STRATEGIES


def _as_list(value: EntitlementValue) -> tuple[str, ...]:
    assert isinstance(value.value, tuple)
    return value.value


def _fold(strategy: str, left: EntitlementValue, right: EntitlementValue) -> EntitlementValue:
    if strategy == "OVERRIDE":
        return right
    if strategy == "ADD":
        return EntitlementValue(kind="number", value=left.value + right.value)  # type: ignore[operator, arg-type]
    if strategy == "MAX":
        if left.kind == "boolean":
            return EntitlementValue(kind="boolean", value=bool(left.value) or bool(right.value))
        return EntitlementValue(kind="number", value=max(left.value, right.value))  # type: ignore[type-var, arg-type]
    if strategy == "MIN":
        if left.kind == "boolean":
            return EntitlementValue(kind="boolean", value=bool(left.value) and bool(right.value))
        return EntitlementValue(kind="number", value=min(left.value, right.value))  # type: ignore[type-var, arg-type]
    if strategy == "UNION":
        return EntitlementValue(kind="stringList", value=tuple(dict.fromkeys([*_as_list(left), *_as_list(right)])))
    if strategy == "INTERSECTION":
        a, b = _as_list(left), _as_list(right)
        if len(a) == 0:
            return EntitlementValue(kind="stringList", value=b)
        if len(b) == 0:
            return EntitlementValue(kind="stringList", value=a)
        permitted = set(b)
        intersection = tuple(item for item in a if item in permitted)
        if len(intersection) == 0:
            raise EntitlementConfigError("Allowlist contributions have no permitted value in common.")
        return EntitlementValue(kind="stringList", value=intersection)
    raise EntitlementConfigError("HARD_DENY has no fold.")


_SUPPORTS: dict[str, tuple[str, ...]] = {
    "OVERRIDE": ("boolean", "number", "string", "stringList"),
    "ADD": ("number",),
    "MAX": ("boolean", "number"),
    "MIN": ("boolean", "number"),
    "UNION": ("stringList",),
    "INTERSECTION": ("stringList",),
    "HARD_DENY": (),
}
_UNAVAILABLE = {
    "HARD_DENY": (
        "HARD_DENY is not implemented: how it differs from MIN was lost with the previous "
        "backend, and guessing at an access-control rule is not acceptable. Specify it before "
        "any capability uses it."
    ),
}


def resolve_capability(capability: CapabilityDefinition, contributions: list[EntitlementContribution]) -> EntitlementValue:
    if len(contributions) == 0:
        raise EntitlementConfigError(f'Capability "{capability.key}" was resolved with no contributions.')
    unavailable = _UNAVAILABLE.get(capability.merge_strategy)
    if unavailable is not None:
        raise EntitlementConfigError(f'Capability "{capability.key}": {unavailable}')
    if capability.value_kind not in _SUPPORTS[capability.merge_strategy]:
        raise EntitlementConfigError(
            f'Capability "{capability.key}" declares strategy {capability.merge_strategy}, which does '
            f'not apply to kind "{capability.value_kind}".'
        )
    ordered = sorted(contributions, key=lambda item: item.precedence)
    for index in range(1, len(ordered)):
        previous, current = ordered[index - 1], ordered[index]
        if previous.precedence == current.precedence:
            raise EntitlementConfigError(
                f'Capability "{capability.key}": sources "{previous.source_key}" and "{current.source_key}" '
                f"share precedence {current.precedence}, so the winner would be arbitrary."
            )
    for contribution in ordered:
        if contribution.value.kind != capability.value_kind:
            raise EntitlementConfigError(
                f'Capability "{capability.key}": source "{contribution.source_key}" supplied a '
                f'"{contribution.value.kind}" where "{capability.value_kind}" is declared.'
            )
    accumulated = ordered[0].value
    for contribution in ordered[1:]:
        accumulated = _fold(capability.merge_strategy, accumulated, contribution.value)
    return accumulated
