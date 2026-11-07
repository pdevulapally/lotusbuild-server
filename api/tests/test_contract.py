"""HTTP contract carried over from the Fastify server: health, CORS, and the per-address limit."""

from types import SimpleNamespace

from fastapi.testclient import TestClient

from lotusbuild.app import EXPOSED_RESPONSE_HEADERS, create_app
from lotusbuild.config import Url


def _config(**overrides):
    origin = Url("https://app.example.test", "https:", "app.example.test")
    values = {
        "LOG_LEVEL": "error",
        "HTTP_MAX_REQUESTS_PER_MINUTE": 100,
        "CORS_ALLOWED_ORIGINS": (origin,),
        "CONFIG_CACHE_TTL_SECONDS": 60,
        "SSE_HEARTBEAT_SECONDS": 15,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


class CountingRedis:
    def __init__(self, count: int) -> None:
        self.count = count
        self.keys: list[str] = []

    async def rate_limit(self, key: str, window_ms: int):
        self.keys.append(key)
        return self.count, window_ms


def _client(count: int, **config_overrides):
    redis = CountingRedis(count)
    extra = config_overrides.pop("dependencies", {})
    app = create_app(_config(**config_overrides), SimpleNamespace(
        redis=redis,
        firebase_auth=SimpleNamespace(),
        configuration=SimpleNamespace(get=_ok),
        **extra,
    ))
    return TestClient(app), redis


async def _ok():
    return {}


def test_preflight_allows_only_configured_origins():
    client, _redis = _client(1)
    for origin in ("https://app.example.test", "https://untrusted.example.test"):
        response = client.options("/sessions/owned/events", headers={
            "origin": origin,
            "access-control-request-method": "GET",
            "access-control-request-headers": "authorization,last-event-id",
        })
        if origin == "https://app.example.test":
            assert response.status_code == 204
            assert response.headers["access-control-allow-origin"] == origin
            headers = [part.strip() for part in response.headers["access-control-allow-headers"].lower().split(",")]
            assert "authorization" in headers
            assert "last-event-id" in headers
        else:
            assert response.headers.get("access-control-allow-origin") is None


def test_per_address_limit_applies_and_stays_readable_cross_origin():
    client, redis = _client(2, HTTP_MAX_REQUESTS_PER_MINUTE=1)
    origin = "https://app.example.test"
    for url in ("/health", "/me", "/projects"):
        response = client.get(url, headers={"origin": origin})
        assert response.status_code == 429, url
        assert response.headers["access-control-allow-origin"] == origin
        assert response.headers["x-ratelimit-limit"] == "1"
        assert response.headers.get("retry-after") is not None
    assert len(redis.keys) >= 3
    assert all("ip:" in key for key in redis.keys)


def test_plans_keeps_a_higher_per_address_limit():
    client, _redis = _client(121, HTTP_MAX_REQUESTS_PER_MINUTE=1)
    response = client.get("/plans", headers={"origin": "https://app.example.test"})
    assert response.status_code == 429
    assert response.headers["x-ratelimit-limit"] == "120"
    assert response.headers["access-control-allow-origin"] == "https://app.example.test"


def test_request_under_the_limit_is_served():
    client, _redis = _client(1, HTTP_MAX_REQUESTS_PER_MINUTE=1)
    response = client.get("/health", headers={"origin": "https://app.example.test"})
    assert response.status_code == 200
    assert response.headers["x-ratelimit-limit"] == "1"
    assert response.json() == {"status": "ok"}


def test_browser_may_read_retry_headers():
    client, _redis = _client(1, HTTP_MAX_REQUESTS_PER_MINUTE=1)
    response = client.get("/health", headers={"origin": "https://app.example.test"})
    exposed = [part.strip().lower() for part in response.headers["access-control-expose-headers"].split(",")]
    for name in EXPOSED_RESPONSE_HEADERS:
        assert name.lower() in exposed


def test_health_reports_packaged_revision():
    revision = "a" * 40
    packaged, _redis = _client(1, dependencies={"revision": revision})
    development, _other = _client(1)
    assert packaged.get("/health").json() == {"status": "ok", "revision": revision}
    assert development.get("/health").json() == {"status": "ok"}


def test_unsigned_stripe_webhook_is_rejected():
    client, _redis = _client(1)
    response = client.post("/webhooks/stripe", json={"id": "evt"})
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "billing/unsigned-webhook"


def test_unknown_route_uses_the_error_shape():
    client, _redis = _client(1)
    response = client.get("/missing")
    assert response.status_code == 404
    body = response.json()
    assert body["error"]["code"] == "request/not-found"
    assert "requestId" in body
