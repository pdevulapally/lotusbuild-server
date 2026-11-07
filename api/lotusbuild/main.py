"""Process entrypoint for the FastAPI server."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import signal
from types import SimpleNamespace

import uvicorn

from lotusbuild.app import create_app
from lotusbuild.billing.repository import BillingRepository
from lotusbuild.billing.stripe_client import create_stripe
from lotusbuild.config import load_config
from lotusbuild.desktop.relay import DesktopRelay
from lotusbuild.desktop.tickets import DesktopTickets
from lotusbuild.entitlements.service import EntitlementService
from lotusbuild.entitlements.store import ConfigurationStore
from lotusbuild.entitlements.subscription_cache import SubscriptionCache
from lotusbuild.errors import EnvironmentError, safe_error_diagnostic
from lotusbuild.family.service import FamilyService
from lotusbuild.firebase_app import initialise_firebase
from lotusbuild.metering.service import MeteringService
from lotusbuild.privacy.requests import PrivacyRequests
from lotusbuild.projects.repository import ProjectRepository
from lotusbuild.redis_client import SESSION_EVENTS_PREFIX, connect_redis
from lotusbuild.release import release_revision
from lotusbuild.sessions.events import SessionEvents
from lotusbuild.sessions.repository import SessionRepository
from lotusbuild.storage.snapshots import SnapshotStore
from lotusbuild.users.repository import UserRepository


async def _serve() -> None:
    config = load_config()
    logging.basicConfig(level=getattr(logging, str(config.LOG_LEVEL).upper(), logging.INFO))
    revision = release_revision()
    firebase = initialise_firebase(config)

    def on_redis_error(error: BaseException) -> None:
        logging.error("%s", safe_error_diagnostic(error))

    redis = await connect_redis(config, on_redis_error, "lotusbuild-api")
    subscriber = redis.pubsub()
    try:
        await subscriber.ping()
    except Exception as cause:
        await redis.aclose()
        raise EnvironmentError(["REDIS_URL subscriber connection failed."]) from cause
    configuration = ConfigurationStore(firebase["firestore"], config.CONFIG_CACHE_TTL_SECONDS * 1000)
    await configuration.get()
    subscription_cache = SubscriptionCache(redis, config.SUBSCRIPTION_CACHE_TTL_SECONDS)
    entitlements = EntitlementService(firebase["firestore"], configuration, subscription_cache)
    users = UserRepository(firebase["firestore"])
    metering = MeteringService(firebase["firestore"], configuration)

    async def erase_events(session_id: str) -> None:
        await redis.delete(f"{SESSION_EVENTS_PREFIX}{session_id}")

    snapshots = SnapshotStore(
        firebase["credentials"], firebase["project_id"], config.FIREBASE_STORAGE_BUCKET, config.SNAPSHOT_URL_TTL_SECONDS,
    )
    projects = ProjectRepository(
        firebase["firestore"], users, entitlements, metering, configuration, snapshots, erase_events,
    )
    sessions = SessionRepository(
        firebase["firestore"], projects, entitlements, configuration, metering, config.SESSION_LEASE_SECONDS,
    )
    events = SessionEvents(
        redis, subscriber,
        max_event_bytes=config.SESSION_EVENT_MAX_BYTES,
        retention_seconds=config.SESSION_EVENT_RETENTION_SECONDS,
        max_per_session=config.SESSION_EVENT_MAX_PER_SESSION,
        on_listener_error=lambda error, session_id: logging.error("session event delivery failed %s %s", session_id, safe_error_diagnostic(error)),
    )
    dependencies = SimpleNamespace(
        privacy_requests=PrivacyRequests(firebase["firestore"]),
        family=FamilyService(firebase["firestore"], config.FAMILY_INVITATION_TTL_SECONDS),
        firebase_auth=firebase["auth"],
        redis=redis,
        entitlements=entitlements,
        metering=metering,
        users=users,
        projects=projects,
        configuration=configuration,
        stripe=create_stripe(config.STRIPE_SECRET_KEY),
        billing=BillingRepository(firebase["firestore"], subscription_cache, config.STRIPE_EVENT_REPLAY_WINDOW_SECONDS),
        sessions=sessions,
        session_events=events,
        revision=revision,
        desktop_tickets=DesktopTickets(redis),
        desktop_relay=DesktopRelay(
            SimpleNamespace(redis=redis, sessions=sessions, tickets=DesktopTickets(redis)),
            SimpleNamespace(
                max_connections=config.DESKTOP_MAX_CONNECTIONS,
                max_connections_per_user=config.DESKTOP_MAX_CONNECTIONS_PER_USER,
                max_viewers_per_session=config.DESKTOP_MAX_VIEWERS_PER_SESSION,
                stream_max_seconds=config.DESKTOP_STREAM_MAX_SECONDS,
                ping_seconds=config.DESKTOP_PING_SECONDS,
                buffer_max_bytes=config.DESKTOP_BUFFER_MAX_BYTES,
                client_max_bytes_per_second=config.DESKTOP_CLIENT_MAX_BYTES_PER_SECOND,
                allowed_origins={url.origin for url in config.CORS_ALLOWED_ORIGINS},
                upstream_domain=config.E2B_DOMAIN,
            ),
        ),
    )
    app = create_app(config, dependencies)
    server = uvicorn.Server(uvicorn.Config(app, host=config.HOST, port=config.PORT, log_level=str(config.LOG_LEVEL)))
    loop = asyncio.get_running_loop()
    listen_task = asyncio.create_task(events.listen())

    def stop() -> None:
        server.should_exit = True

    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop)
    try:
        await server.serve()
    finally:
        listen_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await listen_task
        await subscriber.aclose()
        await redis.aclose()


def main() -> None:
    try:
        asyncio.run(_serve())
    except Exception as error:
        logging.error("%s", safe_error_diagnostic(error))
        raise SystemExit(1) from error


if __name__ == "__main__":
    main()
