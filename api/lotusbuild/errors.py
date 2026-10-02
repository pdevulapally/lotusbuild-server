"""The single error shape the API returns, and safe diagnostics for logs."""

from __future__ import annotations

import math
from typing import Any

DIAGNOSTIC_CODES = frozenset({
    "release/recovery-protocol-incompatible", "session/recovery-protocol-incompatible",
    "usage/limit-reached", "usage/reconciliation-required", "entitlement/misconfigured",
    "session/cancelled", "session/lease-lost", "session/project-guard-lost",
    "session/project-state-inconsistent", "session/workspace-unrecoverable", "session/not-found",
    "session/ai-not-permitted", "session/model-not-permitted", "session/platform-not-permitted",
    "account/erasure-pending", "account/reconciliation-required", "project/deleting", "project/not-found",
    "project/persistence-failed", "sandbox/platform-unconfigured", "billing/provider-unavailable",
    "billing/bad-signature", "session/no-desktop", "desktop/capacity-reached", "auth/token-invalid",
    "auth/token-expired", "auth/token-revoked", "auth/email-not-verified",
    "runner/shutdown", "runner/execution-failed",
})
DIAGNOSTIC_STAGES = frozenset({
    "runner/work-failed", "workspace/salvage-authorization-failed", "workspace/salvage-failed",
    "sandbox/recovery-failed", "workspace/terminalization-failed", "workspace/save-failed",
    "workspace/save-and-cleanup-failed", "workspace/save-failed-without-mutations",
    "sandbox/cleanup-failed", "session/finalization-failed",
})


class AppError(Exception):
    def __init__(
        self,
        *,
        code: str,
        status_code: int,
        message: str,
        details: dict[str, Any] | None = None,
        cause: BaseException | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.status_code = status_code
        self.details = details
        self.__cause__ = cause


class EnvironmentError(Exception):
    def __init__(self, problems: list[str]) -> None:
        noun = "problem" if len(problems) == 1 else "problems"
        message = f"Invalid environment ({len(problems)} {noun}):\n" + "\n".join(
            f"  - {problem}" for problem in problems
        )
        super().__init__(message)
        self.name = "EnvironmentError"
        self.problems = tuple(problems)


def _diagnostic_field(value: object, key: str) -> object:
    if not isinstance(value, (object,)) or value is None or isinstance(value, (str, int, float, bool)):
        if not hasattr(value, key):
            return None
    try:
        if isinstance(value, dict):
            return value.get(key)
        return getattr(value, key, None) if key in getattr(value, "__dict__", {}) or hasattr(type(value), key) else (
            value[key] if isinstance(value, (list, tuple)) and key.isdigit() else getattr(value, key, None)
        )
    except Exception:
        return None


def _own(value: object, key: str) -> object:
    """Own data only: no coercion of provider payloads."""
    if value is None or isinstance(value, (str, int, float, bool)):
        return None
    try:
        if isinstance(value, dict):
            return value[key] if key in value else None
        if isinstance(value, (list, tuple)):
            if not key.isdigit():
                return None
            index = int(key)
            return value[index] if 0 <= index < len(value) else None
        if key in getattr(value, "__dict__", {}):
            return value.__dict__[key]
        if key == "code" and isinstance(value, AppError):
            return value.code
        if key == "name" and hasattr(value, "name"):
            return getattr(value, "name")
        if key == "status_code" and isinstance(value, AppError):
            return value.status_code
        if key == "statusCode" and isinstance(value, AppError):
            return value.status_code
        if key == "problems" and isinstance(value, EnvironmentError):
            return list(value.problems)
        if key == "cause":
            return getattr(value, "__cause__", None)
        if key == "errors" and isinstance(value, BaseExceptionGroup):
            return list(value.exceptions)
        return None
    except Exception:
        return None


def safe_error_diagnostic(error: object) -> dict[str, Any]:
    """Safe at log boundaries. At most 16 nodes, 8 children per node, depth 3."""
    seen: set[int] = set()
    remaining = 16

    def visit(value: object, depth: int) -> dict[str, Any]:
        nonlocal remaining
        remaining -= 1
        if remaining < 0 or depth > 3 or id(value) in seen:
            return {"category": "error/unknown", "truncated": True}
        if isinstance(value, (dict, list, tuple, BaseException)):
            seen.add(id(value))
        code = _own(value, "code")
        name = _own(value, "name")
        if name is None and isinstance(value, EnvironmentError):
            name = "EnvironmentError"
        if name is None and type(value).__name__ == "RunnerWorkError":
            name = "RunnerWorkError"
        primary = _own(value, "primaryCategory")
        secondary = _own(value, "secondaryStage")
        errors = value if isinstance(value, list) else _own(value, "errors")
        cause = _own(value, "cause")
        problems = _own(value, "problems") if name == "EnvironmentError" else None
        invalid_keys: set[str] = set()
        if isinstance(problems, (list, tuple)):
            from lotusbuild.config import CONFIGURATION_KEYS

            for index in range(min(len(problems), 64)):
                problem = problems[index]
                if isinstance(problem, str):
                    for key in CONFIGURATION_KEYS:
                        if problem.startswith(key + " "):
                            invalid_keys.add(key)
        if isinstance(value, AppError):
            category = code if isinstance(code, str) and len(code) <= 64 and code in DIAGNOSTIC_CODES else "application/error"
        elif name == "RunnerWorkError":
            category = "runner/work-failed"
        elif isinstance(errors, (list, tuple)):
            category = "error/aggregate"
        elif name == "EnvironmentError":
            category = "configuration/invalid"
        elif isinstance(value, BaseException):
            category = "error/runtime"
        else:
            category = "error/unknown"
        status = _own(value, "statusCode")
        if status is None:
            status = _own(value, "status_code")
        if status is None:
            status = _own(value, "status")
        exit_code = _own(value, "exitCode")
        count = (len(errors) if isinstance(errors, (list, tuple)) else 0) + (0 if cause is None else 1)
        nested: list[dict[str, Any]] = []

        def inspect_child(child: object) -> None:
            if len(nested) < 8 and remaining > 0:
                nested.append(visit(child, depth + 1))

        if cause is not None:
            inspect_child(cause)
        if isinstance(errors, (list, tuple)):
            for index in range(min(len(errors), 8)):
                if len(nested) >= 8 or remaining <= 0:
                    break
                inspect_child(errors[index])
        result: dict[str, Any] = {"category": category}
        if invalid_keys:
            result["configurationKeys"] = sorted(invalid_keys)
        if isinstance(status, int) and not isinstance(status, bool) and 100 <= status <= 599:
            result["statusCode"] = status
        if isinstance(exit_code, int) and not isinstance(exit_code, bool) and -128 <= exit_code <= 255:
            result["exitCode"] = exit_code
        if name == "RunnerWorkError" and isinstance(primary, str) and len(primary) <= 64 and primary in DIAGNOSTIC_CODES:
            result["primaryCategory"] = primary
        if name == "RunnerWorkError" and isinstance(secondary, str) and len(secondary) <= 64 and secondary in DIAGNOSTIC_STAGES:
            result["secondaryStage"] = secondary
        if count > 0:
            nested_categories: list[str] = []
            for item in nested:
                nested_categories.append(item["category"])
                nested_categories.extend(item.get("nestedCategories") or [])
            result["nestedCount"] = count
            result["nestedCategories"] = nested_categories[:16]
        if count > len(nested) or any(item.get("truncated") for item in nested):
            result["truncated"] = True
        return result

    try:
        return visit(error, 0)
    except Exception:
        return {"category": "error/unknown"}


def error_body(
    code: str,
    message: str,
    request_id: str,
    details: dict[str, Any] | None = None,
) -> dict[str, Any]:
    error: dict[str, Any] = {"code": code, "message": message}
    if details is not None:
        error["details"] = details
    return {"error": error, "requestId": request_id}


def is_safe_integer(value: object) -> bool:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    if isinstance(value, float):
        if not math.isfinite(value) or not value.is_integer():
            return False
        value = int(value)
    return -9007199254740991 <= int(value) <= 9007199254740991
