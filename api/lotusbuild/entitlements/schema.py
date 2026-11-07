"""Plan and registry document parsing."""

from __future__ import annotations

import ipaddress
import math
import re
from dataclasses import dataclass
from typing import Any, Literal

from lotusbuild.entitlements.merge import MERGE_STRATEGIES, CapabilityDefinition, is_merge_strategy
from lotusbuild.entitlements.values import ENTITLEMENT_VALUE_KINDS, EntitlementValue, parse_entitlement_value
from lotusbuild.support.documents import (
    DocumentShapeError,
    Fields,
    boolean_field,
    enum_field,
    index_by_key,
    integer_field,
    object_array_field,
    string_field,
)

METER_KINDS = ("COUNTER", "GAUGE")
RESET_PERIODS = ("NEVER", "DAILY", "MONTHLY")
PLAN_STATUSES = ("ACTIVE", "DEPRECATED")
RATE_LIMIT_CLASSES = ("read", "write", "build", "stream")
PLATFORMS = ("web", "mobile")
SANDBOX_PROVIDER_KEYS = ("e2b", "vps")
SUBSCRIPTION_STATUSES = ("TRIALING", "ACTIVE", "PAST_DUE", "CANCELED", "INCOMPLETE")
BILLING_INTERVALS = ("day", "week", "month", "year")

PLAN_NETWORK_POLICIES: dict[str, dict[str, Any]] = {
    "free": {"mode": "unrestricted"},
    "pro": {"mode": "unrestricted"},
    "business": {"mode": "restricted", "allowedDomains": []},
}

SCREENSHOT_LONG_EDGE_LIMIT = 2576
SCREENSHOT_VISUAL_TOKEN_LIMIT = 4784
SCREENSHOT_SQUARE = 28

RateLimitClass = Literal["read", "write", "build", "stream"]
Platform = Literal["web", "mobile"]
SubscriptionStatus = Literal["TRIALING", "ACTIVE", "PAST_DUE", "CANCELED", "INCOMPLETE"]

_DOMAIN = re.compile(r"^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$")


def _is_ip(value: str) -> bool:
    try:
        ipaddress.ip_address(value)
        return True
    except ValueError:
        return False


@dataclass(frozen=True)
class MeterDefinition:
    key: str
    unit: str
    kind: str
    reset_period: str
    label: str


@dataclass(frozen=True)
class DesktopSettings:
    width: int
    height: int
    computer_models: tuple[str, ...] | None = None


@dataclass(frozen=True)
class SandboxProvider:
    platform: str
    provider: str
    template: str
    timeout_seconds: int
    memory_mb: int
    cpus: int
    concurrency_meter_key: str
    workdir: str
    idle_grace_seconds: int
    agent_instructions: str
    validation_profiles: dict[str, str]
    desktop: DesktopSettings | None = None


@dataclass(frozen=True)
class EntitlementSource:
    key: str
    precedence: int


@dataclass(frozen=True)
class SpecialistDefinition:
    key: str
    label: str
    purpose: str
    instructions: str
    parallel_safe: bool
    validation: bool


@dataclass(frozen=True)
class Registry:
    default_plan_key: str
    sandbox_time_meter_key: str
    build_meter_key: str
    input_token_meter_key: str
    output_token_meter_key: str
    storage_meter_key: str
    entitling_subscription_statuses: tuple[str, ...]
    capabilities: dict[str, CapabilityDefinition]
    meters: dict[str, MeterDefinition]
    entitlement_sources: dict[str, EntitlementSource]
    sandbox_providers: dict[str, SandboxProvider]
    specialists: dict[str, SpecialistDefinition]


@dataclass(frozen=True)
class PlanPrice:
    amount_minor: int
    currency: str
    interval: str


@dataclass(frozen=True)
class MeterLimit:
    meter_key: str
    included_allowance: int
    hard_limit: int
    overage_enabled: bool


@dataclass(frozen=True)
class RateLimit:
    route_class: str
    max_requests: int
    window_seconds: int


@dataclass(frozen=True)
class Plan:
    key: str
    name: str
    status: str
    rank: int
    sandbox_network: dict[str, Any]
    price: PlanPrice | None
    entitlements: dict[str, EntitlementValue]
    meter_limits: dict[str, MeterLimit]
    rate_limits: dict[str, RateLimit]


def parse_sandbox_network(value: object, where: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise DocumentShapeError(f"{where}: sandboxNetwork must be explicitly configured.")
    if value.get("mode") == "unrestricted" and len(value) == 1:
        return {"mode": "unrestricted"}
    domains = value.get("allowedDomains")
    if value.get("mode") != "restricted" or not isinstance(domains, list) or any(
        key not in ("mode", "allowedDomains") for key in value
    ):
        raise DocumentShapeError(f"{where}: expected unrestricted mode or restricted mode with allowedDomains.")
    if any(
        not isinstance(domain, str) or len(domain) > 253 or _DOMAIN.fullmatch(domain) is None or _is_ip(domain)
        for domain in domains
    ) or len(set(domains)) != len(domains):
        raise DocumentShapeError(
            f"{where}: allowedDomains must contain unique exact lowercase DNS names, without URLs, IP addresses or wildcards."
        )
    return {"mode": "restricted", "allowedDomains": list(domains)}


def _parse_desktop(entry: Fields, at: str) -> DesktopSettings | None:
    if "desktop" not in entry:
        return None
    value = entry["desktop"]
    if not isinstance(value, dict):
        raise DocumentShapeError(f'{at}: field "desktop" must be an object with a width and a height.')
    where = f"{at}.desktop"
    width = integer_field(value, "width", where, min_value=640, max_value=3840)
    height = integer_field(value, "height", where, min_value=480, max_value=2160)
    if "computerModels" not in value:
        return DesktopSettings(width, height)
    models = value["computerModels"]
    if (
        not isinstance(models, list)
        or len(models) == 0
        or any(not isinstance(model, str) or model.strip() == "" or model != model.strip() for model in models)
        or len(set(models)) != len(models)
    ):
        raise DocumentShapeError(f'{where}: "computerModels" must be a non-empty list of unique model names.')
    visual_tokens = math.ceil(width / SCREENSHOT_SQUARE) * math.ceil(height / SCREENSHOT_SQUARE)
    if max(width, height) > SCREENSHOT_LONG_EDGE_LIMIT or visual_tokens > SCREENSHOT_VISUAL_TOKEN_LIMIT:
        raise DocumentShapeError(
            f"{where}: a {width}x{height} screen is larger than a screenshot can be ({SCREENSHOT_LONG_EDGE_LIMIT} px on the "
            f"long edge, {SCREENSHOT_VISUAL_TOKEN_LIMIT} visual tokens), so its models cannot be given the computer tool."
        )
    return DesktopSettings(width, height, tuple(models))


def _parse_validation_profiles(entry: Fields, at: str) -> dict[str, str]:
    value = entry.get("validationProfiles")
    if not isinstance(value, dict):
        raise DocumentShapeError(f'{at}: field "validationProfiles" must be an object mapping operations to commands.')
    profiles: dict[str, str] = {}
    for operation, command in value.items():
        if not isinstance(command, str) or command.strip() == "":
            raise DocumentShapeError(f"{at}.validationProfiles.{operation} must be a non-empty command string.")
        profiles[operation] = command
    return profiles


def parse_registry(fields: Fields, where: str) -> Registry:
    capabilities = index_by_key(
        [
            _capability(entry, f"{where}.capabilities[{index}]")
            for index, entry in enumerate(object_array_field(fields, "capabilities", where))
        ],
        lambda item: item.key,
        f"{where}.capabilities",
    )
    meters = index_by_key(
        [
            MeterDefinition(
                key=string_field(entry, "key", f"{where}.meters[{index}]"),
                unit=string_field(entry, "unit", f"{where}.meters[{index}]"),
                kind=enum_field(entry, "kind", f"{where}.meters[{index}]", METER_KINDS),
                reset_period=enum_field(entry, "resetPeriod", f"{where}.meters[{index}]", RESET_PERIODS),
                label=string_field(entry, "label", f"{where}.meters[{index}]"),
            )
            for index, entry in enumerate(object_array_field(fields, "meters", where))
        ],
        lambda item: item.key,
        f"{where}.meters",
    )
    entitlement_sources = index_by_key(
        [
            EntitlementSource(
                key=string_field(entry, "key", f"{where}.entitlementSources[{index}]"),
                precedence=integer_field(entry, "precedence", f"{where}.entitlementSources[{index}]", min_value=0),
            )
            for index, entry in enumerate(object_array_field(fields, "entitlementSources", where))
        ],
        lambda item: item.key,
        f"{where}.entitlementSources",
    )
    seen: dict[int, str] = {}
    for source in entitlement_sources.values():
        clash = seen.get(source.precedence)
        if clash is not None:
            raise DocumentShapeError(
                f'{where}.entitlementSources: "{clash}" and "{source.key}" share precedence {source.precedence}.'
            )
        seen[source.precedence] = source.key

    providers: list[SandboxProvider] = []
    for index, entry in enumerate(object_array_field(fields, "sandboxProviders", where)):
        at = f"{where}.sandboxProviders[{index}]"
        concurrency = string_field(entry, "concurrencyMeterKey", at)
        if concurrency not in meters:
            raise DocumentShapeError(f'{at}: concurrencyMeterKey "{concurrency}" is not a declared meter.')
        providers.append(SandboxProvider(
            platform=enum_field(entry, "platform", at, PLATFORMS),
            provider=enum_field(entry, "provider", at, SANDBOX_PROVIDER_KEYS),
            template=string_field(entry, "template", at),
            timeout_seconds=integer_field(entry, "timeoutSeconds", at, min_value=1),
            memory_mb=integer_field(entry, "memoryMb", at, min_value=1),
            cpus=integer_field(entry, "cpus", at, min_value=1),
            concurrency_meter_key=concurrency,
            workdir=string_field(entry, "workdir", at),
            idle_grace_seconds=integer_field(entry, "idleGraceSeconds", at, min_value=0),
            agent_instructions=string_field(entry, "agentInstructions", at),
            validation_profiles=_parse_validation_profiles(entry, at),
            desktop=_parse_desktop(entry, at),
        ))

    specialists: list[SpecialistDefinition] = []
    if "specialists" in fields:
        for index, entry in enumerate(object_array_field(fields, "specialists", where)):
            at = f"{where}.specialists[{index}]"
            parallel_safe = boolean_field(entry, "parallelSafe", at)
            validation = boolean_field(entry, "validation", at)
            if parallel_safe and validation:
                raise DocumentShapeError(f"{at}: a specialist cannot be both parallelSafe and validation-capable.")
            specialists.append(SpecialistDefinition(
                key=string_field(entry, "key", at),
                label=string_field(entry, "label", at),
                purpose=string_field(entry, "purpose", at),
                instructions=string_field(entry, "instructions", at),
                parallel_safe=parallel_safe,
                validation=validation,
            ))

    default_plan_key = string_field(fields, "defaultPlanKey", where)
    sandbox_time_meter_key = string_field(fields, "sandboxTimeMeterKey", where)
    build_meter_key = string_field(fields, "buildMeterKey", where)
    input_token_meter_key = string_field(fields, "inputTokenMeterKey", where)
    output_token_meter_key = string_field(fields, "outputTokenMeterKey", where)
    storage_meter_key = string_field(fields, "storageMeterKey", where)
    entitling = fields.get("entitlingSubscriptionStatuses")
    if not isinstance(entitling, list) or len(entitling) == 0:
        raise DocumentShapeError(f"{where}: entitlingSubscriptionStatuses must be a non-empty array.")
    statuses: list[str] = []
    for index, status in enumerate(entitling):
        if status not in SUBSCRIPTION_STATUSES:
            raise DocumentShapeError(
                f'{where}.entitlingSubscriptionStatuses[{index}]: "{status}" is not one of {", ".join(SUBSCRIPTION_STATUSES)}.'
            )
        statuses.append(status)
    if sandbox_time_meter_key not in meters:
        raise DocumentShapeError(f'{where}: sandboxTimeMeterKey "{sandbox_time_meter_key}" is not a declared meter.')
    for field, key in (
        ("buildMeterKey", build_meter_key),
        ("inputTokenMeterKey", input_token_meter_key),
        ("outputTokenMeterKey", output_token_meter_key),
    ):
        meter = meters.get(key)
        if meter is None:
            raise DocumentShapeError(f'{where}: {field} "{key}" is not a declared meter.')
        if meter.kind != "COUNTER":
            raise DocumentShapeError(
                f'{where}: {field} "{key}" is a {meter.kind}, but what it measures is consumed rather than held, so it must be a COUNTER.'
            )
    storage_meter = meters.get(storage_meter_key)
    if storage_meter is None:
        raise DocumentShapeError(f'{where}: storageMeterKey "{storage_meter_key}" is not a declared meter.')
    if storage_meter.kind != "GAUGE":
        raise DocumentShapeError(
            f'{where}: storageMeterKey "{storage_meter_key}" is a {storage_meter.kind}, but stored bytes are occupied rather than consumed, so it must be a GAUGE.'
        )
    return Registry(
        default_plan_key=default_plan_key,
        sandbox_time_meter_key=sandbox_time_meter_key,
        build_meter_key=build_meter_key,
        input_token_meter_key=input_token_meter_key,
        output_token_meter_key=output_token_meter_key,
        storage_meter_key=storage_meter_key,
        entitling_subscription_statuses=tuple(statuses),
        capabilities=capabilities,
        meters=meters,
        entitlement_sources=entitlement_sources,
        sandbox_providers=index_by_key(providers, lambda item: item.platform, f"{where}.sandboxProviders"),
        specialists=index_by_key(specialists, lambda item: item.key, f"{where}.specialists"),
    )


def _capability(entry: Fields, at: str) -> CapabilityDefinition:
    merge_strategy = string_field(entry, "mergeStrategy", at)
    if not is_merge_strategy(merge_strategy):
        raise DocumentShapeError(f'{at}: mergeStrategy must be one of {", ".join(MERGE_STRATEGIES)}, got "{merge_strategy}".')
    return CapabilityDefinition(
        key=string_field(entry, "key", at),
        value_kind=enum_field(entry, "valueKind", at, ENTITLEMENT_VALUE_KINDS),
        merge_strategy=merge_strategy,
        label=string_field(entry, "label", at),
    )


def _parse_plan_price(fields: Fields, where: str) -> PlanPrice | None:
    raw = fields.get("price")
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise DocumentShapeError(f"{where}.price must be an object when it is present.")
    at = f"{where}.price"
    return PlanPrice(
        amount_minor=integer_field(raw, "amountMinor", at, min_value=1),
        currency=string_field(raw, "currency", at),
        interval=enum_field(raw, "interval", at, BILLING_INTERVALS),
    )


def parse_plan(fields: Fields, where: str, registry: Registry) -> Plan:
    key = string_field(fields, "key", where)
    entitlements: dict[str, EntitlementValue] = {}
    for index, entry in enumerate(object_array_field(fields, "entitlements", where)):
        at = f"{where}.entitlements[{index}]"
        capability_key = string_field(entry, "capabilityKey", at)
        capability = registry.capabilities.get(capability_key)
        if capability is None:
            raise DocumentShapeError(f'{at}: "{capability_key}" is not a declared capability.')
        if capability_key in entitlements:
            raise DocumentShapeError(f'{at}: "{capability_key}" appears more than once.')
        entitlements[capability_key] = parse_entitlement_value(entry.get("value"), capability.value_kind, f"{at}.value")
    meter_limits: dict[str, MeterLimit] = {}
    for index, entry in enumerate(object_array_field(fields, "meterLimits", where)):
        at = f"{where}.meterLimits[{index}]"
        meter_key = string_field(entry, "meterKey", at)
        if meter_key not in registry.meters:
            raise DocumentShapeError(f'{at}: "{meter_key}" is not a declared meter.')
        if meter_key in meter_limits:
            raise DocumentShapeError(f'{at}: "{meter_key}" appears more than once.')
        included = integer_field(entry, "includedAllowance", at, min_value=0)
        hard = integer_field(entry, "hardLimit", at, min_value=0)
        if included > hard:
            raise DocumentShapeError(f"{at}: includedAllowance {included} exceeds hardLimit {hard}.")
        meter_limits[meter_key] = MeterLimit(meter_key, included, hard, boolean_field(entry, "overageEnabled", at))
    rate_limits: dict[str, RateLimit] = {}
    for index, entry in enumerate(object_array_field(fields, "rateLimits", where)):
        at = f"{where}.rateLimits[{index}]"
        route_class = enum_field(entry, "routeClass", at, RATE_LIMIT_CLASSES)
        if route_class in rate_limits:
            raise DocumentShapeError(f'{at}: "{route_class}" appears more than once.')
        rate_limits[route_class] = RateLimit(
            route_class,
            integer_field(entry, "maxRequests", at, min_value=1),
            integer_field(entry, "windowSeconds", at, min_value=1),
        )
    network_source = fields.get("sandboxNetwork")
    if "sandboxNetwork" not in fields and key in PLAN_NETWORK_POLICIES:
        network_source = PLAN_NETWORK_POLICIES[key]
    return Plan(
        key=key,
        name=string_field(fields, "name", where),
        status=enum_field(fields, "status", where, PLAN_STATUSES),
        rank=integer_field(fields, "rank", where, min_value=0),
        sandbox_network=parse_sandbox_network(network_source, where),
        price=_parse_plan_price(fields, where),
        entitlements=entitlements,
        meter_limits=meter_limits,
        rate_limits=rate_limits,
    )


def assert_sandbox_allowances_are_usable(registry: Registry, plans: list[Plan], sandbox_time_meter_key: str) -> None:
    meter = registry.meters.get(sandbox_time_meter_key)
    if meter is None:
        raise DocumentShapeError(f'The sandbox time meter "{sandbox_time_meter_key}" is not declared in the registry.')
    longest: SandboxProvider | None = None
    for provider in registry.sandbox_providers.values():
        if longest is None or provider.timeout_seconds > longest.timeout_seconds:
            longest = provider
    if longest is None:
        raise DocumentShapeError("No sandbox providers are configured.")
    for plan in plans:
        if plan.status != "ACTIVE":
            continue
        limit = plan.meter_limits.get(sandbox_time_meter_key)
        if limit is None:
            raise DocumentShapeError(
                f'Plan "{plan.key}" declares no limit for "{sandbox_time_meter_key}", so a sandbox could run unmetered.'
            )
        if limit.hard_limit < longest.timeout_seconds:
            raise DocumentShapeError(
                f'Plan "{plan.key}" caps "{sandbox_time_meter_key}" at {limit.hard_limit}s, below the '
                f'{longest.timeout_seconds}s lifetime of the "{longest.platform}" sandbox. Every build on this plan would be refused before starting.'
            )
