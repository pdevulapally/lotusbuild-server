"""FastAPI port of the LotusBuild HTTP server."""

from __future__ import annotations

import asyncio
import itertools
import json
import logging
import math
import re
import time
from collections.abc import AsyncIterator
from typing import Any, Literal

from fastapi import Depends, FastAPI, Request, WebSocket
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field
from starlette.exceptions import HTTPException as StarletteHTTPException

from lotusbuild.desktop.tickets import DESKTOP_TICKET_TTL_SECONDS, DesktopGrant, redact_desktop_ticket
from lotusbuild.errors import AppError, error_body, safe_error_diagnostic
from lotusbuild.projects.repository import PROJECT_DESCRIPTION_MAX_LENGTH, PROJECT_NAME_MAX_LENGTH
from lotusbuild.sessions.events import closing_frame, compare_stream_ids, frame, parse_stream_id
from lotusbuild.sessions.repository import PROMPT_MAX_LENGTH
from lotusbuild.timeutil import to_iso
from lotusbuild.users.repository import AuthenticatedUser

EXPOSED_RESPONSE_HEADERS = ("Retry-After", "X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset")
BODY_LIMIT = 1_048_576
DOCUMENT_ID = r"^[A-Za-z0-9_-]{1,128}$"
PRINTABLE = "^[^\u0000-\u001F\u007F]+$"
PROMPT_TEXT = "^[^\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]+$"
MODEL_ID = r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$"
PLAN_KEY = r"^[a-z0-9][a-z0-9_-]{0,63}$"
INVITE_TOKEN = r"^[A-Za-z0-9_-]{43}$"
_REQUEST_IDS = itertools.count(1)
log = logging.getLogger("lotusbuild")

RATE_LIMIT_SCRIPT = """
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then ttl = tonumber(ARGV[1]) end
return {current, ttl}
"""


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CreateProjectBody(_Strict):
    name: str = Field(min_length=1, max_length=PROJECT_NAME_MAX_LENGTH, pattern=PRINTABLE)
    description: str | None = Field(default=None, max_length=PROJECT_DESCRIPTION_MAX_LENGTH, pattern=PRINTABLE)


class UpdateProjectBody(_Strict):
    name: str | None = Field(default=None, min_length=1, max_length=PROJECT_NAME_MAX_LENGTH, pattern=PRINTABLE)
    description: str | None = Field(default=None, max_length=PROJECT_DESCRIPTION_MAX_LENGTH, pattern=PRINTABLE)


class PublicPreviewBody(_Strict):
    enabled: bool


class CreateSessionBody(_Strict):
    prompt: str = Field(min_length=1, max_length=PROMPT_MAX_LENGTH, pattern=PROMPT_TEXT)
    model: str = Field(pattern=MODEL_ID)


class AppendMessageBody(_Strict):
    prompt: str = Field(min_length=1, max_length=PROMPT_MAX_LENGTH, pattern=PROMPT_TEXT)
    steer: bool | None = None


class CheckoutBody(_Strict):
    planKey: str = Field(pattern=PLAN_KEY)


class PrivacyBody(_Strict):
    kind: str = Field(pattern="^(access|erasure|rectification|complaint)$")


class InviteBody(_Strict):
    adultConfirmed: Literal[True]
    parentalResponsibilityConfirmed: Literal[True]


class AcceptBody(_Strict):
    parentUid: str = Field(pattern=DOCUMENT_ID)
    token: str = Field(pattern=INVITE_TOKEN)


class ConfirmChildBody(_Strict):
    approved: bool


class GrantBody(_Strict):
    enabled: bool


class DecideBody(_Strict):
    requestId: str = Field(pattern=DOCUMENT_ID)
    approved: bool


def client_ip(request: Request) -> str:
    peer = request.client.host if request.client is not None else "unknown"
    if peer in {"127.0.0.1", "::1", "localhost"}:
        forwarded = request.headers.get("x-forwarded-for")
        if forwarded:
            return forwarded.split(",")[0].strip() or peer
    return peer


def _request_id(request: Request) -> str:
    existing = getattr(request.state, "request_id", None)
    if isinstance(existing, str):
        return existing
    request_id = f"req-{next(_REQUEST_IDS)}"
    request.state.request_id = request_id
    return request_id


def _origin_allowed(request: Request, origin: str | None) -> bool:
    if origin is None:
        return False
    allowed = {url.origin for url in request.app.state.config.CORS_ALLOWED_ORIGINS}
    return origin in allowed


def _apply_cors(request: Request, response: Response) -> None:
    origin = request.headers.get("origin")
    if not _origin_allowed(request, origin):
        return
    response.headers["access-control-allow-origin"] = origin or ""
    response.headers["access-control-expose-headers"] = ", ".join(EXPOSED_RESPONSE_HEADERS)
    vary = response.headers.get("vary")
    response.headers["vary"] = "Origin" if not vary else f"{vary}, Origin"


def _apply_security(response: Response) -> None:
    response.headers.setdefault("x-content-type-options", "nosniff")
    response.headers.setdefault("x-frame-options", "SAMEORIGIN")
    response.headers.setdefault("cross-origin-resource-policy", "cross-origin")
    response.headers.setdefault("referrer-policy", "no-referrer")
    response.headers.setdefault("x-dns-prefetch-control", "off")
    response.headers.setdefault("x-permitted-cross-domain-policies", "none")
    response.headers.setdefault("x-download-options", "noopen")


def _copy_rate_headers(request: Request, response: Response) -> None:
    headers = getattr(request.state, "rate_headers", None)
    if isinstance(headers, dict):
        for name, value in headers.items():
            response.headers[name] = value
    if getattr(request.state, "no_store", False):
        response.headers["cache-control"] = "no-store"


async def _consume_ip_limit(redis: Any, key: str, window_ms: int) -> tuple[int, int]:
    rate_limit = getattr(redis, "rate_limit", None)
    if rate_limit is not None:
        count, ttl = await rate_limit(key, window_ms)
        return int(count), int(ttl)
    raw = await redis.eval(RATE_LIMIT_SCRIPT, 1, f"rl:{key}", str(window_ms))
    count, ttl = raw
    return int(count), int(ttl)


def _limit_for(request: Request) -> int:
    path = request.url.path
    if request.method == "GET" and path == "/plans":
        return 120
    if request.method == "POST" and path == "/webhooks/stripe":
        return 300
    return int(request.app.state.config.HTTP_MAX_REQUESTS_PER_MINUTE)


async def _guard(request: Request, call_next):
    request_id = _request_id(request)
    content_length = request.headers.get("content-length")
    if content_length is not None and content_length.isdigit() and int(content_length) > BODY_LIMIT:
        response = JSONResponse(
            error_body("request/invalid", "Request body is too large.", request_id, {"reason": "FST_ERR_CTP_BODY_TOO_LARGE"}),
            status_code=413,
        )
        _apply_security(response)
        _apply_cors(request, response)
        return response
    maximum = _limit_for(request)
    try:
        count, ttl_ms = await _consume_ip_limit(request.app.state.redis, f"ip:{client_ip(request)}", 60_000)
    except Exception as cause:
        log.error("rate limiter store failed: %s", safe_error_diagnostic(cause))
        response = JSONResponse(error_body("internal/unexpected", "An unexpected error occurred.", request_id), status_code=500)
        _apply_security(response)
        _apply_cors(request, response)
        return response
    ttl_seconds = max(0, math.ceil(ttl_ms / 1000))
    remaining = max(0, maximum - count)
    request.state.rate_headers = {
        "x-ratelimit-limit": str(maximum),
        "x-ratelimit-remaining": str(remaining if count <= maximum else 0),
        "x-ratelimit-reset": str(ttl_seconds),
    }
    if count > maximum:
        request.state.rate_headers["retry-after"] = str(ttl_seconds)
        response = JSONResponse(
            error_body("rate-limit/exceeded", f"Rate limit exceeded, retry in {ttl_seconds} seconds", request_id),
            status_code=429,
        )
        _copy_rate_headers(request, response)
        _apply_security(response)
        _apply_cors(request, response)
        return response
    if request.method == "OPTIONS":
        response = Response(status_code=204)
        if _origin_allowed(request, request.headers.get("origin")):
            response.headers["access-control-allow-methods"] = "GET, POST, PATCH, DELETE"
            response.headers["access-control-allow-headers"] = "Authorization, Content-Type, Last-Event-ID"
            response.headers["access-control-max-age"] = "600"
        _copy_rate_headers(request, response)
        _apply_security(response)
        _apply_cors(request, response)
        return response
    response = await call_next(request)
    _copy_rate_headers(request, response)
    _apply_security(response)
    _apply_cors(request, response)
    return response


def _json_error(request: Request, status: int, code: str, message: str, details: dict[str, Any] | None = None) -> JSONResponse:
    response = JSONResponse(error_body(code, message, _request_id(request), details), status_code=status)
    _copy_rate_headers(request, response)
    _apply_security(response)
    _apply_cors(request, response)
    return response


def bearer_token(header: str | None) -> str:
    if header is None:
        raise AppError(code="auth/missing-token", status_code=401, message="This endpoint requires an Authorization header.")
    parts = header.split(" ")
    if len(parts) != 2 or parts[0].lower() != "bearer" or parts[1] == "":
        raise AppError(code="auth/malformed-header", status_code=401, message='The Authorization header must be "Bearer <firebase-id-token>".')
    return parts[1]


_TOKEN_FAILURES = {
    "auth/id-token-expired": "auth/token-expired",
    "auth/id-token-revoked": "auth/token-revoked",
    "auth/user-disabled": "auth/user-disabled",
}


async def require_auth(request: Request) -> AuthenticatedUser:
    token = bearer_token(request.headers.get("authorization"))
    try:
        decoded = await asyncio.to_thread(request.app.state.firebase_auth.verify_id_token, token, True)
    except AppError:
        raise
    except Exception as cause:
        firebase_code = getattr(cause, "code", None)
        code = _TOKEN_FAILURES.get(str(firebase_code)) if firebase_code is not None else None
        raise AppError(
            code=code or "auth/token-invalid",
            status_code=401,
            message="The supplied Firebase ID token is not valid.",
            cause=cause,
        ) from cause
    name = decoded.get("name") if isinstance(decoded, dict) else getattr(decoded, "get", lambda *_: None)("name")
    user = AuthenticatedUser(
        uid=decoded["uid"],
        email=decoded.get("email"),
        email_verified=decoded.get("email_verified") is True,
        display_name=name if isinstance(name, str) and name.strip() else None,
        photo_url=decoded.get("picture") if isinstance(decoded.get("picture"), str) and decoded.get("picture").strip() else None,
        auth_time=int(decoded["auth_time"]),
        expires_at=int(decoded["exp"]) if decoded.get("exp") is not None else None,
    )
    request.state.user = user
    request.state.no_store = True
    request.state.bearer = token
    return user


async def require_verified_email(user: AuthenticatedUser = Depends(require_auth)) -> AuthenticatedUser:
    if not user.email_verified:
        raise AppError(code="auth/email-not-verified", status_code=403, message="Verify your email address to use this feature.")
    return user


def enforce_rate_limit(route_class: str):
    async def dependency(request: Request, user: AuthenticatedUser = Depends(require_auth)) -> AuthenticatedUser:
        resolved = await request.app.state.entitlements.for_user(user.uid)
        limit = resolved.rate_limits.get(route_class)
        if limit is None:
            raise AppError(
                code="config/rate-limit-missing",
                status_code=500,
                message=f'Plan "{resolved.plan_key}" declares no "{route_class}" rate limit.',
            )
        count, ttl_ms = await _consume_ip_limit(
            request.app.state.redis,
            f"{route_class}:{user.uid}",
            limit.window_seconds * 1000,
        )
        ttl_seconds = max(0, math.ceil(ttl_ms / 1000))
        headers = {
            "x-ratelimit-limit": str(limit.max_requests),
            "x-ratelimit-remaining": str(max(0, limit.max_requests - count)),
            "x-ratelimit-reset": str(ttl_seconds),
        }
        if count > limit.max_requests:
            headers["retry-after"] = str(ttl_seconds)
            request.state.rate_headers = headers
            raise AppError(
                code="rate-limit/exceeded",
                status_code=429,
                message=f"Too many {route_class} requests. Retry in {ttl_seconds}s.",
                details={
                    "routeClass": route_class,
                    "limit": limit.max_requests,
                    "windowSeconds": limit.window_seconds,
                    "retryAfterSeconds": ttl_seconds,
                },
            )
        request.state.rate_headers = headers
        return user

    return dependency


def _project_response(project: Any) -> dict[str, Any]:
    return {
        "id": project.id,
        "name": project.name,
        "description": project.description,
        "platform": project.platform,
        "status": project.status,
        "publicPreviewEnabled": project.public_preview_enabled is True,
        "createdAt": to_iso(project.created_at),
    }


def _session_response(session: Any) -> dict[str, Any]:
    return {
        "id": session.id,
        "projectId": session.project_id,
        "status": session.status,
        "model": session.model,
        "effort": session.effort,
        "sandboxId": session.sandbox_id,
        "error": session.error,
        "messageCount": session.message_count,
        "heartbeatAt": None if session.heartbeat_at is None else to_iso(session.heartbeat_at),
        "createdAt": to_iso(session.created_at),
    }


def _queued_response(message: Any) -> dict[str, Any]:
    return {
        "id": message.id,
        "sessionId": message.session_id,
        "prompt": message.prompt,
        "createdAt": to_iso(message.created_at),
    }


def _check_id(value: str) -> str:
    if re.fullmatch(DOCUMENT_ID, value) is None:
        raise AppError(code="request/invalid", status_code=400, message="request/invalid")
    return value


def create_app(config: Any, dependencies: Any) -> FastAPI:
    app = FastAPI(title="LotusBuild API", docs_url=None, redoc_url=None, openapi_url=None)
    app.state.config = config
    app.state.redis = dependencies.redis
    app.state.firebase_auth = getattr(dependencies, "firebase_auth", None)
    app.state.configuration = getattr(dependencies, "configuration", None)
    app.state.entitlements = getattr(dependencies, "entitlements", None)
    app.state.users = getattr(dependencies, "users", None)
    app.state.metering = getattr(dependencies, "metering", None)
    app.state.projects = getattr(dependencies, "projects", None)
    app.state.sessions = getattr(dependencies, "sessions", None)
    app.state.session_events = getattr(dependencies, "session_events", None)
    app.state.family = getattr(dependencies, "family", None)
    app.state.privacy = getattr(dependencies, "privacy_requests", None)
    app.state.billing = getattr(dependencies, "billing", None)
    app.state.stripe = getattr(dependencies, "stripe", None)
    app.state.revision = getattr(dependencies, "revision", None)
    app.state.desktop_relay = getattr(dependencies, "desktop_relay", None)
    app.state.desktop_tickets = getattr(dependencies, "desktop_tickets", None)
    app.state.open_streams = 0
    app.state.streams_by_user = {}
    app.middleware("http")(_guard)

    @app.exception_handler(AppError)
    async def app_error(request: Request, error: AppError) -> JSONResponse:
        if error.status_code >= 500:
            log.error("internal request failure %s", safe_error_diagnostic(error))
            return _json_error(request, error.status_code, error.code, "The request could not be completed. Contact support with this request ID.")
        log.info("request rejected %s", safe_error_diagnostic(error))
        return _json_error(request, error.status_code, error.code, str(error), error.details)

    @app.exception_handler(RequestValidationError)
    async def invalid(request: Request, error: RequestValidationError) -> JSONResponse:
        return _json_error(request, 400, "request/invalid", "Request validation failed.")

    @app.exception_handler(StarletteHTTPException)
    async def http_error(request: Request, error: StarletteHTTPException) -> JSONResponse:
        if error.status_code == 404:
            return _json_error(request, 404, "request/not-found", "No route matches this request.")
        if 400 <= error.status_code < 500:
            return _json_error(request, error.status_code, "request/invalid", str(error.detail), {"reason": "unspecified"})
        return _json_error(request, 500, "internal/unexpected", "An unexpected error occurred.")

    @app.exception_handler(Exception)
    async def unexpected(request: Request, error: Exception) -> JSONResponse:
        log.error("unhandled error %s", safe_error_diagnostic(error))
        return _json_error(request, 500, "internal/unexpected", "An unexpected error occurred.")

    read = enforce_rate_limit("read")
    write = enforce_rate_limit("write")
    build = enforce_rate_limit("build")
    stream = enforce_rate_limit("stream")
    verified_write = [Depends(require_verified_email), Depends(write)]
    verified_build = [Depends(require_verified_email), Depends(build)]

    @app.get("/health")
    async def health() -> dict[str, str]:
        await app.state.configuration.get()
        if app.state.revision is None:
            return {"status": "ok"}
        return {"status": "ok", "revision": app.state.revision}

    @app.get("/me", dependencies=[Depends(read)])
    async def me(request: Request, user: AuthenticatedUser = Depends(require_auth)) -> dict[str, Any]:
        stored = await app.state.users.ensure(user)
        resolved = await app.state.entitlements.for_user(user.uid)
        return {
            "uid": stored.uid,
            "email": stored.email,
            "emailVerified": user.email_verified,
            "displayName": stored.display_name,
            "photoUrl": stored.photo_url,
            "projectCount": stored.project_count,
            "plan": {"key": resolved.plan_key, "name": resolved.plan_name},
            "subscriptionStatus": resolved.subscription_status,
            "capabilities": resolved.capabilities.entries(),
            "limits": [
                {
                    "meterKey": limit.meter_key,
                    "includedAllowance": limit.included_allowance,
                    "hardLimit": limit.hard_limit,
                    "overageEnabled": limit.overage_enabled,
                }
                for limit in resolved.meter_limits.values()
            ],
        }

    @app.get("/me/usage", dependencies=[Depends(read)])
    async def usage(user: AuthenticatedUser = Depends(require_auth)) -> dict[str, Any]:
        stored = await app.state.users.ensure(user)
        resolved = await app.state.entitlements.for_user(user.uid)
        breakdown = await app.state.metering.read_usage_breakdown(user.uid, resolved)
        return {
            "uid": stored.uid,
            "plan": {"key": resolved.plan_key, "name": resolved.plan_name},
            "meters": [
                {
                    "meterKey": entry.meter_key,
                    "unit": entry.unit,
                    "label": entry.label,
                    "kind": entry.kind,
                    "resetPeriod": entry.reset_period,
                    "consumed": entry.consumed,
                    "reserved": entry.reserved,
                    "totalUsed": entry.consumed + entry.reserved,
                    "includedAllowance": entry.included_allowance,
                    "hardLimit": entry.hard_limit,
                    "overageEnabled": entry.overage_enabled,
                    "periodStart": to_iso(entry.period_start),
                }
                for entry in breakdown
            ],
        }

    @app.get("/plans")
    async def plans() -> dict[str, Any]:
        catalogue = getattr(app.state, "catalogue", None)
        if catalogue is None:
            from lotusbuild.billing.catalogue import plan_catalogue

            app.state.catalogue = plan_catalogue(app.state.configuration, int(app.state.config.CONFIG_CACHE_TTL_SECONDS) * 1000)
            catalogue = app.state.catalogue
        return {"plans": await catalogue.get()}

    @app.post("/projects", status_code=201, dependencies=verified_write)
    async def create_project(body: CreateProjectBody, user: AuthenticatedUser = Depends(require_auth)) -> dict[str, Any]:
        project = await app.state.projects.create(user.uid, name=body.name.strip(), description=None if body.description is None else body.description.strip(), platform="web")
        return _project_response(project)

    @app.get("/projects", dependencies=[Depends(read)])
    async def list_projects(user: AuthenticatedUser = Depends(require_auth), limit: int = 25) -> dict[str, Any]:
        if limit < 1 or limit > 100:
            raise AppError(code="request/invalid", status_code=400, message="Request validation failed.")
        owned = await app.state.projects.list_owned_by(user.uid, limit)
        return {"projects": [_project_response(project) for project in owned]}

    @app.get("/projects/{project_id}", dependencies=[Depends(read)])
    async def read_project(project_id: str, user: AuthenticatedUser = Depends(require_auth)) -> dict[str, Any]:
        _check_id(project_id)
        return _project_response(await app.state.projects.read_owned(user.uid, project_id))

    @app.patch("/projects/{project_id}", dependencies=[Depends(write)])
    async def update_project(project_id: str, body: UpdateProjectBody, user: AuthenticatedUser = Depends(require_auth)) -> dict[str, Any]:
        _check_id(project_id)
        project = await app.state.projects.update(
            user.uid, project_id,
            name=None if body.name is None else body.name.strip(),
            description=None if body.description is None else body.description.strip(),
        )
        return _project_response(project)

    @app.delete("/projects/{project_id}", status_code=204, dependencies=[Depends(write)])
    async def delete_project(project_id: str, user: AuthenticatedUser = Depends(require_auth)) -> Response:
        _check_id(project_id)
        await app.state.projects.delete(user.uid, project_id)
        return Response(status_code=204)

    @app.patch("/projects/{project_id}/public-preview", dependencies=[Depends(write)])
    async def public_preview(project_id: str, body: PublicPreviewBody, user: AuthenticatedUser = Depends(require_auth)) -> JSONResponse:
        _check_id(project_id)
        result = await app.state.projects.set_public_preview(user.uid, project_id, body.enabled)
        message = (
            "Public preview access is being revoked by terminating the active session. Access may persist until sandbox termination succeeds."
            if result["terminationPending"]
            else "Future build previews will be publicly accessible. Anyone with the URL may view and copy their content."
            if result["enabled"]
            else "Future build previews will remain private."
        )
        return JSONResponse({**result, "message": message}, status_code=202 if result["terminationPending"] else 200)

    @app.post("/projects/{project_id}/sessions", status_code=201, dependencies=verified_build)
    async def create_session(project_id: str, body: CreateSessionBody, request: Request, user: AuthenticatedUser = Depends(require_auth)) -> dict[str, Any]:
        _check_id(project_id)
        session = await app.state.sessions.create(user.uid, project_id, prompt=body.prompt.strip(), model=body.model)
        _publish(request, session.id, "session.queued", {"status": session.status, "model": session.model, "effort": session.effort})
        return _session_response(session)

    @app.get("/projects/{project_id}/sessions", dependencies=[Depends(read)])
    async def list_sessions(project_id: str, user: AuthenticatedUser = Depends(require_auth), limit: int = 25) -> dict[str, Any]:
        _check_id(project_id)
        if limit < 1 or limit > 100:
            raise AppError(code="request/invalid", status_code=400, message="Request validation failed.")
        owned = await app.state.sessions.list_for_project(user.uid, project_id, limit)
        return {"sessions": [_session_response(session) for session in owned]}

    @app.get("/sessions/{session_id}", dependencies=[Depends(read)])
    async def read_session(session_id: str, user: AuthenticatedUser = Depends(require_auth)) -> dict[str, Any]:
        _check_id(session_id)
        return _session_response(await app.state.sessions.read_owned(user.uid, session_id))

    @app.get("/sessions/{session_id}/messages", dependencies=[Depends(read)])
    async def list_messages(session_id: str, user: AuthenticatedUser = Depends(require_auth), limit: int = 100) -> dict[str, Any]:
        _check_id(session_id)
        if limit < 1 or limit > 200:
            raise AppError(code="request/invalid", status_code=400, message="Request validation failed.")
        messages = await app.state.sessions.list_messages(user.uid, session_id, limit)
        return {"messages": [{"seq": message.seq, "role": message.role, "content": message.content, "createdAt": to_iso(message.created_at)} for message in messages]}

    @app.post("/sessions/{session_id}/messages", dependencies=verified_build)
    async def append_message(session_id: str, body: AppendMessageBody, request: Request, user: AuthenticatedUser = Depends(require_auth)) -> JSONResponse:
        _check_id(session_id)
        prompt = body.prompt.strip()
        current = await app.state.sessions.read_owned(user.uid, session_id)
        if body.steer is True:
            if current.status == "RUNNING":
                await app.state.sessions.queue_steer_message(user.uid, current.id, prompt)
                _publish(request, current.id, "session.steer", {"prompt": prompt})
                return JSONResponse({"steered": True, "sessionId": current.id})
            if current.status == "QUEUED":
                queued = await app.state.sessions.enqueue_message(user.uid, current.id, prompt)
                _publish(request, current.id, "session.message_queued", {"queuedMessageId": queued.id, "prompt": queued.prompt})
                return JSONResponse({"queued": True, "queuedMessage": _queued_response(queued)}, status_code=202)
        if current.status in ("QUEUED", "RUNNING"):
            queued = await app.state.sessions.enqueue_message(user.uid, current.id, prompt)
            _publish(request, current.id, "session.message_queued", {"queuedMessageId": queued.id, "prompt": queued.prompt})
            return JSONResponse({"queued": True, "queuedMessage": _queued_response(queued)}, status_code=202)
        session = await app.state.sessions.append_prompt(user.uid, current.id, prompt)
        _publish(request, session.id, "session.queued", {"status": session.status, "messageCount": session.message_count})
        return JSONResponse({"queued": False, "session": _session_response(session)}, status_code=202)

    @app.get("/sessions/{session_id}/queued-messages", dependencies=[Depends(read)])
    async def list_queued(session_id: str, user: AuthenticatedUser = Depends(require_auth), limit: int = 100, after: str | None = None) -> dict[str, Any]:
        _check_id(session_id)
        if after is not None:
            _check_id(after)
        if limit < 1 or limit > 200:
            raise AppError(code="request/invalid", status_code=400, message="Request validation failed.")
        queued = await app.state.sessions.list_queued_messages(user.uid, session_id, limit, after)
        return {
            "queuedMessages": [_queued_response(message) for message in queued],
            "nextCursor": queued[-1].id if len(queued) == limit else None,
        }

    @app.delete("/sessions/{session_id}/queued-messages/{message_id}", status_code=204, dependencies=[Depends(write)])
    async def delete_queued(session_id: str, message_id: str, request: Request, user: AuthenticatedUser = Depends(require_auth)) -> Response:
        _check_id(session_id)
        _check_id(message_id)
        await app.state.sessions.delete_queued_message(user.uid, session_id, message_id)
        _publish(request, session_id, "session.message_dequeued", {"queuedMessageId": message_id})
        return Response(status_code=204)

    @app.post("/sessions/{session_id}/cancel", dependencies=[Depends(write)])
    async def cancel_session(session_id: str, request: Request, user: AuthenticatedUser = Depends(require_auth)) -> dict[str, Any]:
        _check_id(session_id)
        session = await app.state.sessions.cancel(user.uid, session_id)
        if session.status == "FAILED":
            _publish(request, session.id, "session.failed", {"error": session.error or "Cancelled by user"})
        elif session.cancel_requested is True:
            _publish(request, session.id, "session.cancel_requested", {"sessionId": session.id})
        return _session_response(session)

    @app.get("/sessions/{session_id}/events", dependencies=[Depends(stream)])
    async def session_events(session_id: str, request: Request, user: AuthenticatedUser = Depends(require_auth)) -> StreamingResponse:
        _check_id(session_id)
        session = await app.state.sessions.read_owned(user.uid, session_id)
        per_user = app.state.streams_by_user.get(user.uid, 0)
        if per_user >= app.state.config.SSE_MAX_CONNECTIONS_PER_USER:
            raise AppError(code="stream/account-capacity-reached", status_code=429, message="Close an existing event stream before opening another.")
        if app.state.open_streams >= app.state.config.SSE_MAX_CONNECTIONS:
            raise AppError(
                code="stream/capacity-reached",
                status_code=503,
                message="This server is holding as many event streams as it can. Try again shortly.",
                details={"openStreams": app.state.open_streams, "maxConnections": app.state.config.SSE_MAX_CONNECTIONS},
            )
        app.state.open_streams += 1
        app.state.streams_by_user[user.uid] = per_user + 1
        return StreamingResponse(_event_stream(request, user, session), media_type="text/event-stream", headers={
            "cache-control": "no-store, no-transform",
            "connection": "keep-alive",
            "x-accel-buffering": "no",
        })

    @app.post("/me/privacy-requests", status_code=202, dependencies=[Depends(write)])
    async def submit_privacy(body: PrivacyBody, user: AuthenticatedUser = Depends(require_auth)) -> dict[str, Any]:
        return {
            "request": await app.state.privacy.submit(user.uid, body.kind),
            "message": "Your request has been recorded for review. This acknowledgement does not mean that your data has already been exported, changed or erased.",
        }

    @app.get("/me/privacy-requests", dependencies=[Depends(read)])
    async def list_privacy(user: AuthenticatedUser = Depends(require_auth)) -> dict[str, Any]:
        return {"requests": await app.state.privacy.list(user.uid)}

    _register_family(app, read, write, build)
    _register_billing(app, write)
    _register_desktop(app, stream)
    return app


def _publish(request: Request, session_id: str, event_type: str, data: dict[str, Any]) -> None:
    events = request.app.state.session_events

    async def run() -> None:
        try:
            await events.append(session_id, event_type, data)
        except Exception as cause:
            log.error("session event was not published %s", safe_error_diagnostic(cause))

    asyncio.get_running_loop().create_task(run())


def _release_stream(app: FastAPI, uid: str) -> None:
    app.state.open_streams = max(0, app.state.open_streams - 1)
    remaining = app.state.streams_by_user.get(uid, 1) - 1
    if remaining <= 0:
        app.state.streams_by_user.pop(uid, None)
    else:
        app.state.streams_by_user[uid] = remaining


async def _event_stream(request: Request, user: AuthenticatedUser, session: Any) -> AsyncIterator[str]:
    app = request.app
    events = app.state.session_events
    resume = parse_stream_id(request.headers.get("last-event-id"))
    queue: asyncio.Queue[tuple[str, Any]] = asyncio.Queue()
    pending: list[Any] = []
    pending_bytes = 0
    replaying = True
    max_buffered = app.state.config.SSE_BUFFER_MAX_BYTES
    token_expiry = math.inf if user.expires_at is None else float(user.expires_at)
    release = None

    def listener(event: Any) -> None:
        nonlocal pending_bytes
        encoded = frame(event).encode()
        if len(encoded) > max_buffered:
            queue.put_nowait(("close", "slow-consumer"))
            return
        if replaying:
            pending_bytes += len(encoded)
            if pending_bytes > max_buffered:
                queue.put_nowait(("close", "slow-consumer"))
                return
            pending.append(event)
            return
        queue.put_nowait(("event", event))

    try:
        release = await events.subscribe(session.id, listener)
        last_replayed: str | None = None
        async for event in events.replay(session.id, resume):
            if await request.is_disconnected():
                return
            yield frame(event)
            last_replayed = event.id
        replaying = False
        if not queue.empty():
            kind, payload = queue.get_nowait()
            if kind == "close":
                yield closing_frame(str(payload))
                return
        buffered = list(pending)
        pending.clear()
        for event in buffered:
            if last_replayed is not None and compare_stream_ids(event.id, last_replayed) <= 0:
                continue
            yield frame(event)
        while True:
            if await request.is_disconnected():
                return
            try:
                kind, payload = await asyncio.wait_for(queue.get(), timeout=app.state.config.SSE_HEARTBEAT_SECONDS)
            except TimeoutError:
                if time.time() >= token_expiry:
                    yield closing_frame("token-expired")
                    return
                try:
                    await asyncio.to_thread(app.state.firebase_auth.verify_id_token, request.state.bearer, True)
                    await app.state.sessions.read_owned(user.uid, session.id)
                except Exception:
                    yield closing_frame("token-expired" if time.time() >= token_expiry else "authorization-failed")
                    return
                yield ": keep-alive\n\n"
                continue
            if kind == "close":
                yield closing_frame(payload)
                return
            yield frame(payload)
    except Exception as cause:
        log.error("event stream failed %s", safe_error_diagnostic(cause))
        yield closing_frame("stream-error")
    finally:
        if release is not None:
            release()
        _release_stream(app, user.uid)


def _register_family(app: FastAPI, read, write, build) -> None:
    @app.post("/family/projects/{project_id}/build-requests", status_code=202, dependencies=[Depends(write)])
    async def request_build(project_id: str, body: CreateSessionBody, user: AuthenticatedUser = Depends(require_auth)) -> dict[str, Any]:
        _check_id(project_id)
        return await app.state.family.request_build(user.uid, project_id, prompt=body.prompt, model=body.model)

    @app.get("/family/children/{child_uid}/build-requests", dependencies=[Depends(read)])
    async def build_requests(child_uid: str, user: AuthenticatedUser = Depends(require_auth), limit: int = 100, after: str | None = None) -> dict[str, Any]:
        _check_id(child_uid)
        if after is not None:
            _check_id(after)
        requests = await app.state.family.build_requests(user, child_uid, limit, after)
        return {"requests": requests, "nextCursor": requests[-1]["projectId"] if len(requests) == limit else None}

    @app.post("/family/children/{child_uid}/projects/{project_id}/build-requests/decision", dependencies=[Depends(build)])
    async def decide(child_uid: str, project_id: str, body: DecideBody, user: AuthenticatedUser = Depends(require_auth)) -> dict[str, Any]:
        _check_id(child_uid)
        _check_id(project_id)
        return await app.state.family.decide_build(user, child_uid, project_id, body.requestId, body.approved, app.state.sessions)

    @app.post("/family/invitations", status_code=201, dependencies=[Depends(write)])
    async def invite(body: InviteBody, user: AuthenticatedUser = Depends(require_auth)) -> JSONResponse:
        if body.adultConfirmed is not True or body.parentalResponsibilityConfirmed is not True:
            raise AppError(code="family/access-denied", status_code=403, message="This family access is not authorized.")
        payload = await app.state.family.invite(user, adult_confirmed=True, parental_responsibility_confirmed=True)
        return JSONResponse(payload, status_code=201, headers={"cache-control": "no-store"})

    @app.post("/family/accept", status_code=202, dependencies=[Depends(write)])
    async def accept(body: AcceptBody, user: AuthenticatedUser = Depends(require_auth)) -> dict[str, Any]:
        return await app.state.family.accept(user, body.parentUid, body.token)

    @app.get("/family/children", dependencies=[Depends(read)])
    async def children(user: AuthenticatedUser = Depends(require_auth), limit: int = 100, after: str | None = None) -> dict[str, Any]:
        if after is not None:
            _check_id(after)
        page = await app.state.family.children(user, limit, after)
        return {"children": page, "nextCursor": page[-1]["childUid"] if len(page) == limit else None}

    @app.patch("/family/children/{child_uid}", status_code=204, dependencies=[Depends(write)])
    async def confirm_child(child_uid: str, body: ConfirmChildBody, user: AuthenticatedUser = Depends(require_auth)) -> Response:
        _check_id(child_uid)
        await app.state.family.confirm(user, child_uid, body.approved)
        return Response(status_code=204)

    @app.patch("/family/children/{child_uid}/projects/{project_id}", status_code=204, dependencies=[Depends(write)])
    async def grant(child_uid: str, project_id: str, body: GrantBody, user: AuthenticatedUser = Depends(require_auth)) -> Response:
        _check_id(child_uid)
        _check_id(project_id)
        await app.state.family.grant(user, child_uid, project_id, body.enabled)
        return Response(status_code=204)

    @app.get("/family/projects/{project_id}", dependencies=[Depends(read)])
    async def family_project(project_id: str, user: AuthenticatedUser = Depends(require_auth)) -> dict[str, Any]:
        _check_id(project_id)
        parent = await app.state.family.parent_for_project(user.uid, project_id)
        project = await app.state.projects.read_owned(parent, project_id)
        return {"id": project.id, "name": project.name, "platform": project.platform, "access": "parent-supervised", "permissions": ["read", "request-build"]}

    @app.get("/family/projects/{project_id}/sessions/{session_id}/messages", dependencies=[Depends(read)])
    async def family_messages(project_id: str, session_id: str, user: AuthenticatedUser = Depends(require_auth)) -> dict[str, Any]:
        _check_id(project_id)
        _check_id(session_id)
        parent = await app.state.family.parent_for_project(user.uid, project_id)
        session = await app.state.sessions.read_owned(parent, session_id)
        if session.project_id != project_id:
            raise AppError(code="session/not-found", status_code=404, message="No such session.")
        messages = await app.state.sessions.list_messages(parent, session.id, 100)
        return {"messages": [
            {"seq": message.seq, "role": message.role, "content": message.content, "createdAt": to_iso(message.created_at)}
            for message in messages
        ]}


def _register_billing(app: FastAPI, write) -> None:
    @app.post("/billing/checkout", dependencies=[Depends(require_verified_email), Depends(write)])
    async def checkout(body: CheckoutBody, user: AuthenticatedUser = Depends(require_auth)) -> dict[str, str]:
        from lotusbuild.billing.stripe_client import current_subscription, through_stripe

        configuration = await app.state.configuration.get()
        plan = configuration.plans.get(body.planKey)
        purchasable = [candidate.key for candidate in configuration.plans.values() if candidate.price is not None and candidate.status == "ACTIVE"]
        if plan is None or plan.status != "ACTIVE" or plan.price is None:
            raise AppError(code="billing/plan-not-purchasable", status_code=404, message="No such plan is available to buy.", details={"available": purchasable})
        customer = await app.state.billing.customer_id_for(user.uid)
        if customer is None:
            stored = await app.state.users.read(user.uid)

            async def create_customer() -> Any:
                return await asyncio.to_thread(
                    app.state.stripe.customers.create,
                    {"email": stored.email, "metadata": {"uid": user.uid}},
                    {"idempotency_key": f"customer:{user.uid}"},
                )

            created = await through_stripe("open an account", create_customer, lambda error: log.error("%s", safe_error_diagnostic(error)))
            await app.state.billing.link_customer(user.uid, created.id)
            customer = created.id

        async def existing() -> Any:
            page = await asyncio.to_thread(app.state.stripe.subscriptions.list, {"customer": customer, "status": "all", "limit": 100})
            if getattr(page, "has_more", False):
                raise AppError(code="billing/history-too-large", status_code=503, message="Subscription history requires reconciliation before this operation can complete.")
            return current_subscription(list(page.data))

        if await through_stripe("check existing subscriptions", existing, lambda error: log.error("%s", safe_error_diagnostic(error))):
            raise AppError(code="billing/already-subscribed", status_code=409, message="This account already has a subscription. Use the billing portal to change it.")
        from lotusbuild.billing.stripe_client import ensure_price_id

        price_id = await ensure_price_id(app.state.stripe, plan)
        operation = await app.state.billing.checkout_operation(user.uid, plan.key, price_id)

        async def start() -> Any:
            return await asyncio.to_thread(app.state.stripe.checkout.sessions.create, {
                "mode": "subscription",
                "customer": customer,
                "line_items": [{"price": operation.price_id, "quantity": 1}],
                "expires_at": operation.expires_at,
                "success_url": str(app.state.config.STRIPE_CHECKOUT_SUCCESS_URL),
                "cancel_url": str(app.state.config.STRIPE_CHECKOUT_CANCEL_URL),
                "client_reference_id": user.uid,
                "subscription_data": {"metadata": {"uid": user.uid, "planKey": plan.key}},
            }, {"idempotency_key": f"checkout:{user.uid}:{operation.id}"})

        session = await through_stripe("start checkout", start, lambda error: log.error("%s", safe_error_diagnostic(error)))
        if not getattr(session, "url", None):
            raise AppError(code="billing/checkout-unavailable", status_code=502, message="Stripe did not return a checkout page.")
        return {"url": session.url}

    @app.post("/billing/portal", dependencies=[Depends(write)])
    async def portal(user: AuthenticatedUser = Depends(require_auth)) -> dict[str, str]:
        from lotusbuild.billing.stripe_client import through_stripe

        customer_id = await app.state.billing.customer_id_for(user.uid)
        await app.state.users.read(user.uid)
        if customer_id is None:
            raise AppError(code="billing/no-customer", status_code=409, message="This account has never subscribed, so there is nothing to manage.")

        async def open_portal() -> Any:
            return await asyncio.to_thread(app.state.stripe.billing_portal.sessions.create, {
                "customer": customer_id,
                "return_url": str(app.state.config.STRIPE_PORTAL_RETURN_URL),
            })

        session = await through_stripe("open the billing portal", open_portal, lambda error: log.error("%s", safe_error_diagnostic(error)))
        return {"url": session.url}

    @app.post("/webhooks/stripe")
    async def stripe_webhook(request: Request) -> JSONResponse:
        import stripe

        signature = request.headers.get("stripe-signature")
        if not isinstance(signature, str):
            raise AppError(code="billing/unsigned-webhook", status_code=400, message="This endpoint only accepts signed Stripe events.")
        payload = await request.body()
        if len(payload) > BODY_LIMIT:
            raise AppError(code="request/invalid", status_code=413, message="Request body is too large.")
        try:
            event = stripe.Webhook.construct_event(payload, signature, app.state.config.STRIPE_WEBHOOK_SECRET)
        except Exception as cause:
            log.warning("rejected an unverifiable Stripe event")
            raise AppError(code="billing/bad-signature", status_code=400, message="This event could not be verified.") from cause
        claim = await app.state.billing.claim_event(event["id"])
        if claim["kind"] == "completed":
            return JSONResponse({"received": True, "duplicate": True})
        try:
            handled = await _handle_stripe_event(app, event)
            await app.state.billing.complete_event(event["id"], claim["token"])
            log.info("stripe event %s %s %s", event["id"], event["type"], handled)
            return JSONResponse({"received": True})
        except Exception:
            await app.state.billing.release_event(event["id"], claim["token"])
            raise


async def _handle_stripe_event(app: FastAPI, event: Any) -> str:
    from lotusbuild.billing.stripe_client import current_subscription, read_subscription, through_stripe

    subscription_events = {
        "customer.subscription.created",
        "customer.subscription.updated",
        "customer.subscription.paused",
        "customer.subscription.resumed",
    }
    if event["type"] not in subscription_events and event["type"] != "customer.subscription.deleted":
        return "ignored"
    subscription = event["data"]["object"]
    customer = subscription["customer"] if isinstance(subscription, dict) else subscription.customer
    if isinstance(customer, str):
        customer_id = customer
    elif isinstance(customer, dict):
        customer_id = customer["id"]
    else:
        customer_id = customer.id
    uid = await app.state.billing.uid_for_customer(customer_id)
    if uid is None:
        return "unknown-customer"
    configuration = await app.state.configuration.get()

    async def read() -> Any:
        async def listed() -> Any:
            page = await asyncio.to_thread(
                app.state.stripe.subscriptions.list,
                {"customer": customer_id, "status": "all", "limit": 100},
            )
            if getattr(page, "has_more", False):
                raise AppError(
                    code="billing/history-too-large",
                    status_code=503,
                    message="Subscription history requires reconciliation before this operation can complete.",
                )
            return current_subscription(list(page.data))

        current = await through_stripe("read the subscription", listed, lambda error: log.error("%s", safe_error_diagnostic(error)))
        if current is None:
            return None
        return read_subscription(current, configuration.plans)

    await app.state.billing.synchronize_subscription(uid, read)
    return "synchronized"


def _register_desktop(app: FastAPI, stream) -> None:
    @app.post("/sessions/{session_id}/desktop-ticket", dependencies=[Depends(stream)])
    async def desktop_ticket(session_id: str, user: AuthenticatedUser = Depends(require_auth)) -> dict[str, Any]:
        _check_id(session_id)
        await app.state.sessions.read_owned(user.uid, session_id)
        exists = await app.state.redis.exists(f"dkh:{session_id}")
        if exists != 1 and exists is not True:
            raise AppError(code="session/no-desktop", status_code=409, message="No desktop is running for this session.")
        relay = app.state.desktop_relay
        if relay is not None and not relay.has_capacity(user.uid, session_id):
            raise AppError(code="desktop/capacity-reached", status_code=429, message="Close another desktop view before opening this one.")
        ticket = await app.state.desktop_tickets.issue(DesktopGrant(user.uid, session_id))
        return {"ticket": ticket, "expiresInSeconds": DESKTOP_TICKET_TTL_SECONDS, "path": f"/sessions/{session_id}/desktop"}

    @app.websocket("/sessions/{session_id}/desktop")
    async def desktop_socket(websocket: WebSocket, session_id: str, ticket: str | None = None) -> None:
        if re.fullmatch(DOCUMENT_ID, session_id) is None:
            await websocket.accept()
            await websocket.close(4400, "protocol-abuse")
            return
        relay = app.state.desktop_relay
        if relay is None:
            await websocket.accept()
            await websocket.close(4500, "relay-error")
            return
        await relay.serve(websocket, session_id=session_id, origin=websocket.headers.get("origin"), ticket=ticket)

