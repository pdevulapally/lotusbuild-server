"""Fail-fast environment loading. Values are never defaulted."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable
from urllib.parse import urlparse

from lotusbuild.errors import EnvironmentError


@dataclass(frozen=True)
class Url:
    """Enough of the WHATWG URL the TypeScript server stores."""

    raw: str
    scheme: str
    host: str

    @property
    def origin(self) -> str:
        return f"{self.scheme}//{self.host}"

    @property
    def protocol(self) -> str:
        return self.scheme if self.scheme.endswith(":") else f"{self.scheme}:"

    def __str__(self) -> str:
        return self.raw


Parser = Callable[[str], Any]


@dataclass(frozen=True)
class EnvVarSpec:
    description: str
    parse: Parser


def as_string(description: str, min_length: int = 1) -> EnvVarSpec:
    def parse(raw: str) -> str:
        value = raw.strip()
        if len(value) < min_length:
            raise ValueError(f"expected at least {min_length} character(s), got {len(value)}")
        return value

    return EnvVarSpec(description, parse)


def as_integer(description: str, *, min_value: int, max_value: int) -> EnvVarSpec:
    def parse(raw: str) -> int:
        text = raw.strip()
        try:
            value = int(text)
        except ValueError as cause:
            raise ValueError(f"expected an integer between {min_value} and {max_value}") from cause
        if text != str(value) and not (text.startswith("+") is False):
            pass
        if not isinstance(value, int) or value < min_value or value > max_value or abs(value) > 9007199254740991:
            raise ValueError(f"expected an integer between {min_value} and {max_value}")
        # Reject "01" and floats the same way Number() would still accept some of them:
        # JS Number("1.0") is 1 and is a safe integer. Match that.
        return value

    def parse_js(raw: str) -> int:
        text = raw.strip()
        try:
            number = float(text)
        except ValueError as cause:
            raise ValueError(f"expected an integer between {min_value} and {max_value}") from cause
        if not number.is_integer() or abs(number) > 9007199254740991 or number < min_value or number > max_value:
            raise ValueError(f"expected an integer between {min_value} and {max_value}")
        return int(number)

    return EnvVarSpec(f"{description} (integer {min_value}-{max_value})", parse_js)


def as_port(description: str) -> EnvVarSpec:
    def parse(raw: str) -> int:
        text = raw.strip()
        try:
            number = float(text)
        except ValueError as cause:
            raise ValueError("expected an integer TCP port 1-65535") from cause
        if not number.is_integer() or number < 1 or number > 65535:
            raise ValueError("expected an integer TCP port 1-65535")
        return int(number)

    return EnvVarSpec(description, parse)


def as_enum(description: str, allowed: tuple[str, ...]) -> EnvVarSpec:
    def parse(raw: str) -> str:
        value = raw.strip()
        if value not in allowed:
            raise ValueError(f"expected one of {', '.join(allowed)}")
        return value

    return EnvVarSpec(f"{description} (one of: {', '.join(allowed)})", parse)


def as_boolean(description: str) -> EnvVarSpec:
    def parse(raw: str) -> bool:
        value = raw.strip().lower()
        if value not in ("true", "false"):
            raise ValueError("expected true or false")
        return value == "true"

    return EnvVarSpec(f"{description} (true or false)", parse)


def as_url(description: str, protocols: tuple[str, ...]) -> EnvVarSpec:
    def parse(raw: str) -> Url:
        text = raw.strip()
        parsed = urlparse(text)
        if not parsed.scheme or not parsed.netloc or " " in text:
            raise ValueError("expected an absolute URL")
        protocol = f"{parsed.scheme}:"
        if protocol not in protocols:
            raise ValueError(f"expected protocol {' or '.join(protocols)}")
        return Url(raw=text, scheme=f"{parsed.scheme}:", host=parsed.netloc)

    return EnvVarSpec(f"{description} ({' or '.join(protocols)} URL)", parse)


def as_list(description: str, item: EnvVarSpec) -> EnvVarSpec:
    def parse(raw: str) -> tuple[Any, ...]:
        parts = [part.strip() for part in raw.split(",") if part.strip() != ""]
        if not parts:
            raise ValueError("expected at least one comma-separated value")
        return tuple(item.parse(part) for part in parts)

    return EnvVarSpec(f"{description} (comma-separated)", parse)


def load_env(spec: dict[str, EnvVarSpec], source: dict[str, str | None]) -> dict[str, Any]:
    problems: list[str] = []
    loaded: dict[str, Any] = {}
    for name, var_spec in spec.items():
        raw = source.get(name)
        if raw is None or raw.strip() == "":
            problems.append(f"{name} is not set — {var_spec.description}")
            continue
        try:
            loaded[name] = var_spec.parse(raw)
        except Exception as cause:
            reason = str(cause) if isinstance(cause, Exception) else str(cause)
            problems.append(f"{name} is invalid — {reason}")
    if problems:
        raise EnvironmentError(problems)
    return loaded


SHARED_SPEC: dict[str, EnvVarSpec] = {
    "SESSION_EVENT_MAX_BYTES": as_integer("maximum serialized live event bytes", min_value=1024, max_value=1048576),
    "NODE_ENV": as_enum("deployment mode", ("development", "production", "test")),
    "LOG_LEVEL": as_enum("pino log level", ("trace", "debug", "info", "warn", "error", "fatal")),
    "FIREBASE_PROJECT_ID": as_string("Firebase project this service authenticates against"),
    "FIREBASE_SERVICE_ACCOUNT_FILE": as_string(
        "absolute path to the Firebase service account JSON (keep it mode 600, never in the image)"
    ),
    "CONFIG_CACHE_TTL_SECONDS": as_integer(
        "how long plan and capability configuration is held before re-reading Firestore",
        min_value=1, max_value=3600,
    ),
    "REDIS_URL": as_url("Redis holding rate-limit counters, cached subscriptions and session events", ("redis:", "rediss:")),
    "SUBSCRIPTION_CACHE_TTL_SECONDS": as_integer(
        "how long a subscription lookup is cached before Firestore is read again",
        min_value=1, max_value=3600,
    ),
    "SESSION_LEASE_SECONDS": as_integer(
        "how long a runner holds a build session without a heartbeat before another may take it",
        min_value=5, max_value=3600,
    ),
    "SESSION_EVENT_RETENTION_SECONDS": as_integer(
        "how long after its last event a session log stays in Redis for reconnecting clients",
        min_value=60, max_value=604800,
    ),
    "SESSION_EVENT_MAX_PER_SESSION": as_integer(
        "ceiling on events held per session, bounding what one runaway build can occupy in Redis",
        min_value=100, max_value=100000,
    ),
    "FIREBASE_STORAGE_BUCKET": as_string("bucket holding the saved git repository for every project"),
    "SNAPSHOT_URL_TTL_SECONDS": as_integer(
        "how long a signed upload or download URL for a project snapshot stays valid",
        min_value=60, max_value=3600,
    ),
}

API_SPEC: dict[str, EnvVarSpec] = {
    "FAMILY_INVITATION_TTL_SECONDS": as_integer("lifetime of a one-use parent linking invitation", min_value=60, max_value=86400),
    "HOST": as_string("interface to bind (127.0.0.1 behind a reverse proxy, 0.0.0.0 otherwise)"),
    "PORT": as_port("TCP port to listen on"),
    "PUBLIC_API_URL": as_url("externally reachable base URL of this API", ("https:", "http:")),
    "SSE_HEARTBEAT_SECONDS": as_integer(
        "how often a comment is written down an idle event stream to keep proxies from closing it",
        min_value=5, max_value=300,
    ),
    "SSE_MAX_CONNECTIONS": as_integer("open event streams this process will hold at once", min_value=1, max_value=10000),
    "SSE_MAX_CONNECTIONS_PER_USER": as_integer("maximum simultaneous event streams per account per API process", min_value=1, max_value=100),
    "SSE_BUFFER_MAX_BYTES": as_integer("maximum buffered event bytes per connection", min_value=1024, max_value=1048576),
    "HTTP_MAX_REQUESTS_PER_MINUTE": as_integer("pre-authentication requests per client IP per minute", min_value=1, max_value=100000),
    "STRIPE_SECRET_KEY": as_string("Stripe secret key this service bills with"),
    "STRIPE_WEBHOOK_SECRET": as_string("signing secret for the Stripe webhook endpoint"),
    "STRIPE_EVENT_REPLAY_WINDOW_SECONDS": as_integer(
        "how long a handled Stripe event id is remembered so a redelivery is not applied twice",
        min_value=3600, max_value=604800,
    ),
    "STRIPE_CHECKOUT_SUCCESS_URL": as_url("where Stripe returns a customer who completed checkout", ("https:", "http:")),
    "STRIPE_CHECKOUT_CANCEL_URL": as_url("where Stripe returns a customer who abandoned checkout", ("https:", "http:")),
    "STRIPE_PORTAL_RETURN_URL": as_url("where the Stripe billing portal returns a customer", ("https:", "http:")),
    "DESKTOP_MAX_CONNECTIONS": as_integer("relayed desktop streams this process will hold at once", min_value=1, max_value=1000),
    "DESKTOP_MAX_CONNECTIONS_PER_USER": as_integer("relayed desktop streams one account may hold at once per API process", min_value=1, max_value=20),
    "DESKTOP_MAX_VIEWERS_PER_SESSION": as_integer("relayed desktop streams one session may have at once", min_value=1, max_value=10),
    "DESKTOP_STREAM_MAX_SECONDS": as_integer("hard lifetime of one relayed desktop socket before the client must fetch a new ticket", min_value=30, max_value=3600),
    "DESKTOP_PING_SECONDS": as_integer("how often a relayed desktop socket is pinged; a peer that never answers is dropped", min_value=5, max_value=120),
    "DESKTOP_BUFFER_MAX_BYTES": as_integer("maximum bytes queued for a slow desktop viewer before it is dropped", min_value=65536, max_value=16777216),
    "DESKTOP_CLIENT_MAX_BYTES_PER_SECOND": as_integer("most a view-only desktop viewer may send per second before it is dropped", min_value=1024, max_value=1048576),
    "E2B_DOMAIN": as_string("E2B domain a desktop host must belong to before the relay connects to it"),
    "CORS_ALLOWED_ORIGINS": as_list(
        "browser origins permitted to call this API",
        as_url("allowed origin", ("https:", "http:")),
    ),
}

RUNNER_SPEC: dict[str, EnvVarSpec] = {
    "RUNNER_DRAIN_TIMEOUT_SECONDS": as_integer(
        "maximum total runner shutdown drain; LotusBuild policy is 90s with a 120s systemd stop budget",
        min_value=1, max_value=90,
    ),
    "ANTHROPIC_API_KEY": as_string("key the agent calls the Anthropic API with"),
    "ANTHROPIC_BASE_URL": as_url("Anthropic API base URL", ("https:",)),
    "ANTHROPIC_MAX_OUTPUT_TOKENS": as_integer(
        "output token ceiling for one model call, which is also the most a single call can overspend",
        min_value=256, max_value=200000,
    ),
    "AGENT_MESSAGE_HISTORY_LIMIT": as_integer(
        "how many past messages of a session are replayed to the model, bounding one turn of context",
        min_value=2, max_value=500,
    ),
    "AGENT_MAX_STEPS": as_integer(
        "model calls one turn may take before the runner stops it, bounding a loop that never converges",
        min_value=1, max_value=200,
    ),
    "AGENT_COMMAND_TIMEOUT_SECONDS": as_integer(
        "how long one shell command in a sandbox may run before it is cut off",
        min_value=5, max_value=3600,
    ),
    "AGENT_TOOL_OUTPUT_MAX_CHARS": as_integer(
        "how much of a tool result is fed back to the model before it is truncated",
        min_value=500, max_value=200000,
    ),
    "AGENT_MAX_SPECIALIST_CONSULTATIONS": as_integer(
        "specialist reviews one turn may ask for, bounding what optional consultation can cost",
        min_value=0, max_value=20,
    ),
    "AGENT_SPECIALIST_MAX_STEPS": as_integer(
        "model calls one specialist review may take before it is abandoned as unavailable",
        min_value=1, max_value=50,
    ),
    "GIT_AUTHOR_NAME": as_string("name on the commits the agent makes inside a project"),
    "GIT_AUTHOR_EMAIL": as_string("email on those commits"),
    "E2B_API_KEY": as_string("key sandboxes are created with"),
    "E2B_DOMAIN": as_string("E2B domain to reach (e2b.app for their cloud, ours when self-hosted)"),
    "E2B_VALIDATE_API_KEY": as_boolean(
        "whether to require the e2b_<hex> key format before calling out; false for a self-hosted "
        "deployment that issues keys of its own shape"
    ),
    "PREVIEW_READY_TIMEOUT_SECONDS": as_integer(
        "how long to wait for a dev server to answer on its port before calling the preview failed",
        min_value=5, max_value=600,
    ),
    "RUNNER_IDLE_POLL_SECONDS": as_integer(
        "how long the runner waits before looking for work again when there was none",
        min_value=1, max_value=300,
    ),
    "RUNNER_HEARTBEAT_SECONDS": as_integer(
        "how often the runner renews its lease while working; must be well under SESSION_LEASE_SECONDS",
        min_value=1, max_value=600,
    ),
}

CONFIGURATION_KEYS: tuple[str, ...] = tuple(dict.fromkeys([*SHARED_SPEC, *API_SPEC, *RUNNER_SPEC]))


class Config(dict[str, Any]):
    """Loaded environment. Attribute access matches the TypeScript config object."""

    def __getattr__(self, name: str) -> Any:
        try:
            return self[name]
        except KeyError as cause:
            raise AttributeError(name) from cause


def load_config(source: dict[str, str | None] | None = None) -> Config:
    import os

    raw = dict(os.environ) if source is None else source
    return Config(load_env({**SHARED_SPEC, **API_SPEC}, raw))


def load_shared_config(source: dict[str, str | None] | None = None) -> Config:
    import os

    raw = dict(os.environ) if source is None else source
    return Config(load_env(SHARED_SPEC, raw))
