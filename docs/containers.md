# Building and running the backend container

The Dockerfile builds the existing API and runner from source with `npm ci` and the committed lockfile. Build and runtime use the same digest-pinned official Node 22 / Debian Bookworm base. The runtime contains production dependencies and compiled output, runs as the image's non-root `node` user, and invokes Node directly so it receives shutdown signals. Tests, source, local `dist`, local dependencies, deployment files and credential-shaped files are excluded from the runtime or build context as appropriate.

Dependency lifecycle scripts are disabled during installation. The current lockfile's only install hooks belong to Firebase web-app configuration generation and protobuf version warnings; this backend configures Firebase explicitly at runtime. Reassess this choice when changing dependencies that require native compilation or generated installation artifacts. TypeScript compilation remains an explicit build command.

## Build once and promote that image

From the repository root:

```sh
docker build --target runtime --tag lotusbuild-server:local .
```

Select the actual deployment architecture with Docker's `--platform` option in CI and use that same platform locally. The pinned digest is a multi-platform image index. Do not assume a developer's default architecture matches production. Verify base-image updates and vulnerabilities regularly; digest pinning prevents silent changes but does not apply security updates automatically.

Promote the exact tested image digest when deploying containers. The SSH/systemd workflow now promotes a CI-built tar artifact without rebuilding on the host; it does not deploy this Docker image. No registry, container orchestrator or production port mapping has been configured.

## Runtime configuration

Use separate API and runner configuration/secrets. Supply the existing required environment variables at runtime, never as Docker build arguments or files copied into the image. Mount the Firebase service-account file read-only and set `FIREBASE_SERVICE_ACCOUNT_FILE` to its container path. Give only the container's runtime identity the necessary file-read access; do not make the credential world-readable to work around ownership errors. Do not mount the Docker socket or the host project directory into production containers.

The default command starts the API. Set `HOST=0.0.0.0` inside the container, choose `PORT` through the existing configuration, and publish that port only on the intended interface behind the existing TLS proxy. Setting `HOST=127.0.0.1` inside the container prevents ordinary Docker port forwarding from reaching it. API health remains `/health` on the configured port; there is no shared image health check that would incorrectly treat the runner as an HTTP server.

Run the runner from the **same image** with the command override:

```sh
docker run --rm --env-file /absolute/path/to/runner.env \
  --mount type=bind,src=/absolute/path/to/service-account.json,dst=/run/secrets/firebase.json,readonly \
  --env FIREBASE_SERVICE_ACCOUNT_FILE=/run/secrets/firebase.json \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --cap-drop ALL --security-opt no-new-privileges \
  lotusbuild-server:local node dist/runner/index.js
```

The paths above are examples to replace with actual approved runtime files. Redis and Firebase addresses must be reachable from the container network; a host's `localhost` address is not the container's host. Size stop-grace periods for the runner's existing behaviour: it finishes its current session after SIGTERM. Do not rely on Docker's default short stop timeout for long builds. The image runs the backend; user-generated commands continue running in E2B, not in this backend container.

Existing read-only preflight is available as `node dist/preflight.js` using the required API and runner preflight configuration. Run it only against the deliberately selected environment. The previous network-policy change still requires `sandboxNetwork` on live plan documents before startup; restricted Business plans need their actual approved package and snapshot hosts.

## Verification limits

The base digest was read from the official Docker Hub `library/node` tag metadata on 10 September 2026. Docker/Podman is not installed in the current workspace environment, so image build, Linux runtime smoke tests, non-root secret mounts and shutdown behaviour have not been executed here. Run those checks on a Linux Docker host before deployment. A Dockerfile reduces dependency/runtime differences; it cannot make differing external service configuration or operating assumptions identical.
