"""Typed reads of untyped Firestore documents."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from lotusbuild.errors import AppError, is_safe_integer

Fields = dict[str, Any]
MAX_SAFE = 9007199254740991
MIN_SAFE = -9007199254740991


class DocumentShapeError(AppError):
    def __init__(self, message: str) -> None:
        super().__init__(code="config/malformed-document", status_code=500, message=message)
        self.name = "DocumentShapeError"


def _raw(fields: Fields, name: str, where: str) -> Any:
    value = fields.get(name)
    if value is None:
        raise DocumentShapeError(f'{where}: field "{name}" is missing.')
    return value


def string_field(fields: Fields, name: str, where: str) -> str:
    value = _raw(fields, name, where)
    if not isinstance(value, str) or value.strip() == "":
        raise DocumentShapeError(f'{where}: field "{name}" must be a non-empty string.')
    return value


def boolean_field(fields: Fields, name: str, where: str) -> bool:
    value = _raw(fields, name, where)
    if not isinstance(value, bool):
        raise DocumentShapeError(f'{where}: field "{name}" must be a boolean.')
    return value


def integer_field(
    fields: Fields,
    name: str,
    where: str,
    *,
    min_value: int = MIN_SAFE,
    max_value: int = MAX_SAFE,
) -> int:
    value = _raw(fields, name, where)
    if not is_safe_integer(value):
        raise DocumentShapeError(f'{where}: field "{name}" must be a safe integer.')
    number = int(value)
    if number < min_value or number > max_value:
        raise DocumentShapeError(f'{where}: field "{name}" must be between {min_value} and {max_value}.')
    return number


def count_field(fields: Fields, name: str, where: str) -> int:
    value = fields.get(name)
    if value is None:
        return 0
    return integer_field(fields, name, where, min_value=0)


def _as_datetime(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)
    to_datetime = getattr(value, "to_datetime", None) or getattr(value, "ToDatetime", None)
    if callable(to_datetime):
        converted = to_datetime()
        if isinstance(converted, datetime):
            return converted if converted.tzinfo is not None else converted.replace(tzinfo=timezone.utc)
    return None


def timestamp_field(fields: Fields, name: str, where: str) -> datetime:
    value = _raw(fields, name, where)
    date = _as_datetime(value)
    if date is None or date.timestamp() != date.timestamp():
        raise DocumentShapeError(f'{where}: field "{name}" must be a Firestore timestamp.')
    return date


def optional_timestamp_field(fields: Fields, name: str, where: str) -> datetime | None:
    value = fields.get(name)
    if value is None:
        return None
    return timestamp_field(fields, name, where)


def optional_string_field(fields: Fields, name: str) -> str | None:
    value = fields.get(name)
    if isinstance(value, str) and value.strip() != "":
        return value
    return None


def string_array_field(fields: Fields, name: str, where: str) -> tuple[str, ...]:
    value = fields.get(name)
    if value is None:
        return ()
    if not isinstance(value, list):
        raise DocumentShapeError(f'{where}: field "{name}" must be an array of strings.')
    result: list[str] = []
    for index, entry in enumerate(value):
        if not isinstance(entry, str) or entry.strip() == "":
            raise DocumentShapeError(f"{where}: {name}[{index}] must be a non-empty string.")
        result.append(entry)
    return tuple(result)


def enum_field(fields: Fields, name: str, where: str, allowed: tuple[str, ...] | list[str]) -> str:
    value = string_field(fields, name, where)
    if value not in allowed:
        raise DocumentShapeError(
            f'{where}: field "{name}" must be one of {", ".join(allowed)}, got "{value}".'
        )
    return value


def object_array_field(fields: Fields, name: str, where: str) -> list[Fields]:
    value = _raw(fields, name, where)
    if not isinstance(value, list):
        raise DocumentShapeError(f'{where}: field "{name}" must be an array.')
    result: list[Fields] = []
    for index, entry in enumerate(value):
        if not isinstance(entry, dict):
            raise DocumentShapeError(f"{where}: {name}[{index}] must be an object.")
        result.append(entry)
    return result


def index_by_key(entries: list[Any], key_of, where: str) -> dict[str, Any]:
    by_key: dict[str, Any] = {}
    for entry in entries:
        key = key_of(entry)
        if key in by_key:
            raise DocumentShapeError(f'{where}: "{key}" appears more than once.')
        by_key[key] = entry
    return by_key
