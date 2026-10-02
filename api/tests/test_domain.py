"""Pure rules carried over from the TypeScript server."""

import pytest

from lotusbuild.config import load_env, as_integer, as_boolean, as_url, as_list
from lotusbuild.entitlements.merge import CapabilityDefinition, EntitlementContribution, resolve_capability
from lotusbuild.entitlements.values import EntitlementConfigError, EntitlementValue, parse_entitlement_value
from lotusbuild.errors import EnvironmentError
from lotusbuild.app import CreateProjectBody
from lotusbuild.sessions.events import compare_stream_ids, parse_stream_id
from pydantic import ValidationError
from lotusbuild.support.documents import DocumentShapeError, integer_field, string_field


def test_environment_reports_every_problem():
    spec = {
        "PORT": as_integer("port", min_value=1, max_value=65535),
        "FLAG": as_boolean("flag"),
    }
    with pytest.raises(EnvironmentError) as caught:
        load_env(spec, {"PORT": "nope", "FLAG": ""})
    assert len(caught.value.problems) == 2


def test_url_list_keeps_origins():
    spec = {"CORS_ALLOWED_ORIGINS": as_list("origins", as_url("origin", ("https:", "http:")))}
    loaded = load_env(spec, {"CORS_ALLOWED_ORIGINS": "https://app.example.test, http://localhost:5173"})
    assert [item.origin for item in loaded["CORS_ALLOWED_ORIGINS"]] == [
        "https://app.example.test",
        "http://localhost:5173",
    ]


def test_boolean_rejects_yes():
    with pytest.raises(Exception):
        as_boolean("flag").parse("yes")


def test_max_on_boolean_grants_but_does_not_revoke():
    capability = CapabilityDefinition("ai.run", "boolean", "MAX", "Run")
    granted = resolve_capability(capability, [
        EntitlementContribution("plan", 1, EntitlementValue("boolean", False)),
        EntitlementContribution("promo", 2, EntitlementValue("boolean", True)),
    ])
    denied = resolve_capability(capability, [
        EntitlementContribution("plan", 1, EntitlementValue("boolean", True)),
        EntitlementContribution("promo", 2, EntitlementValue("boolean", False)),
    ])
    assert granted.value is True
    assert denied.value is True


def test_intersection_treats_empty_as_unrestricted():
    capability = CapabilityDefinition("ai.model.allowlist", "stringList", "INTERSECTION", "Models")
    value = resolve_capability(capability, [
        EntitlementContribution("plan", 1, EntitlementValue("stringList", ())),
        EntitlementContribution("grant", 2, EntitlementValue("stringList", ("claude",))),
    ])
    assert value.value == ("claude",)


def test_hard_deny_is_refused():
    capability = CapabilityDefinition("x", "boolean", "HARD_DENY", "X")
    with pytest.raises(EntitlementConfigError):
        resolve_capability(capability, [EntitlementContribution("plan", 1, EntitlementValue("boolean", True))])


def test_entitlement_value_rejects_a_kind_mismatch():
    with pytest.raises(EntitlementConfigError):
        parse_entitlement_value({"kind": "string", "value": "no"}, "number", "plans/pro")


def test_integer_field_rejects_floats():
    with pytest.raises(DocumentShapeError):
        integer_field({"limit": 1.5}, "limit", "doc")
    assert integer_field({"limit": 3}, "limit", "doc") == 3
    assert string_field({"name": "web"}, "name", "doc") == "web"


def test_project_name_rejects_control_characters():
    with pytest.raises(ValidationError):
        CreateProjectBody(name="line\none")


def test_stream_ids_are_not_compared_as_strings():
    assert compare_stream_ids("9-0", "10-0") == -1
    assert parse_stream_id("not-an-id") is None
    assert parse_stream_id("12-1") == "12-1"


def test_snapshot_names_stay_single_path_segments():
    from google.auth.credentials import AnonymousCredentials

    from lotusbuild.storage.snapshots import SnapshotStore

    store = SnapshotStore(AnonymousCredentials(), "project", "bucket", 60)
    assert store.candidate_name("project", "lease") == "projects/project/snapshots/lease.tar.gz"
    with pytest.raises(ValueError):
        store.candidate_name("proj/ect", "lease")


async def test_stripe_subscription_events_read_the_current_subscription():
    from types import SimpleNamespace

    from lotusbuild.app import _handle_stripe_event

    price = SimpleNamespace(id="price_1", metadata={"planKey": "pro"})
    item = SimpleNamespace(price=price, current_period_start=1_700_000_000, current_period_end=1_702_592_000)
    current = SimpleNamespace(id="sub_1", customer="cus_1", status="active", items=SimpleNamespace(data=[item]))

    class Subscriptions:
        def list(self, _params):
            return SimpleNamespace(has_more=False, data=[current])

    class Billing:
        async def uid_for_customer(self, customer_id):
            return "uid-1" if customer_id == "cus_1" else None

        async def synchronize_subscription(self, uid, read):
            self.uid = uid
            self.state = await read()

    billing = Billing()
    app = SimpleNamespace(state=SimpleNamespace(
        billing=billing,
        stripe=SimpleNamespace(subscriptions=Subscriptions()),
        configuration=SimpleNamespace(get=_plans),
    ))
    handled = await _handle_stripe_event(app, {
        "type": "customer.subscription.updated",
        "data": {"object": SimpleNamespace(customer="cus_1")},
    })
    assert handled == "synchronized"
    assert billing.uid == "uid-1"
    assert billing.state.plan_key == "pro"
    assert billing.state.status == "ACTIVE"
    ignored = await _handle_stripe_event(app, {"type": "invoice.paid", "data": {}})
    assert ignored == "ignored"


async def _plans():
    from types import SimpleNamespace

    return SimpleNamespace(plans={"pro": SimpleNamespace(key="pro")})


async def test_unrecoverable_finish_requires_stopped_sandboxes():
    from types import SimpleNamespace

    from lotusbuild.metering.service import MeteringService

    reservations = {
        "users/uid/reservations/time": {
            "status": "SETTLED",
            "meterKey": "sandbox.seconds",
            "sandboxStopped": True,
            "sandboxPlatform": "e2b",
            "sandboxExternalId": "sb-1",
        },
        "users/uid/reservations/tokens": {
            "status": "RELEASED",
            "meterKey": "tokens",
        },
    }

    class Reference:
        def __init__(self, path: str) -> None:
            self.path = path

        async def get(self, transaction: object = None) -> SimpleNamespace:
            fields = reservations.get(self.path)
            return SimpleNamespace(exists=fields is not None, to_dict=lambda: fields)

    class Store:
        def document(self, path: str) -> Reference:
            return Reference(path)

    registry = SimpleNamespace(
        sandbox_time_meter_key="sandbox.seconds",
        sandbox_providers={"e2b": SimpleNamespace(concurrency_meter_key="sandbox.concurrent")},
        meters={"sandbox.seconds": object(), "tokens": object()},
    )

    class Configuration:
        async def get(self) -> SimpleNamespace:
            return SimpleNamespace(registry=registry)

    metering = MeteringService(Store(), Configuration())
    await metering.assert_sandboxes_stopped_in(object(), "uid", ["time", "tokens"], ["sb-1"])
    reservations["users/uid/reservations/time"]["sandboxStopped"] = False
    with pytest.raises(RuntimeError, match="not confirmed stopped"):
        await metering.assert_sandboxes_stopped_in(object(), "uid", ["time"], ["sb-1"])
