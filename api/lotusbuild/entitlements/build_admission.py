"""One policy for creation, continuation and the provider-spend boundary."""

from __future__ import annotations

from lotusbuild.entitlements.service import UserEntitlements
from lotusbuild.errors import AppError


def assert_build_allowed(entitlements: UserEntitlements, platform: str, model: str) -> None:
    if not entitlements.capabilities.boolean("ai.run"):
        raise AppError(
            code="session/ai-not-permitted",
            status_code=403,
            message=f"The {entitlements.plan_name} plan cannot run builds.",
        )
    if not entitlements.capabilities.boolean(f"platform.{platform}"):
        raise AppError(
            code="session/platform-not-permitted",
            status_code=403,
            message=f"The {entitlements.plan_name} plan cannot build {platform} projects.",
        )
    if not entitlements.capabilities.allows("ai.model.allowlist", model):
        raise AppError(
            code="session/model-not-permitted",
            status_code=403,
            message=f"The {entitlements.plan_name} plan cannot use the selected model.",
            details={
                "model": model,
                "permitted": list(entitlements.capabilities.string_list("ai.model.allowlist")),
                "plan": entitlements.plan_key,
            },
        )
