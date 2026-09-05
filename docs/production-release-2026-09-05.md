# Production release — 5 September 2026

The owner explicitly requested production deployment and approved these initial settings: 300 HTTP requests per IP per minute, 4 SSE connections per account, 65536-byte SSE buffers, 65536-byte events and a 3600-second family invitation lifetime.

## Deployed artifact

- Production: `https://api.lotusbuild.co.uk`; live directory `/home/preet/apps/lotusbuild-server`.
- Artifact SHA-256: `14666a1eec6797d518519d80b492b3743516559d04949dca8720718f63ff4286`.
- Packaged 111 tracked/non-ignored working-tree files, excluding credentials and build/dependency directories. No Git commit or push was performed. The deployed files include the uncommitted remediation; ordinary `deploy.sh` still ships committed HEAD, so do not use it to redeploy an older HEAD inadvertently.
- Built with `npm ci` and `npm run build` in a separate production-host candidate. Preflight passed before atomic exchange. Both service restarts succeeded. A `.release-artifact.json` file in the live directory identifies the uploaded artifact.
- Previous installation retained at `/home/preet/apps/.lotusbuild-candidate-14666a1eec6797d518519d80b492b3743516559d04949dca8720718f63ff4286-release`. It includes the previous environment and must remain access-restricted.

## Infrastructure changes

Firebase project `lotusbuild-1d63d`: Firestore rules and all declared indexes deployed; all five indexes observed READY. Storage rules deployed specifically to `lotusbuild-1d63d-snapshots`.

The snapshot bucket now has uniform bucket-level access enabled and public access prevention explicitly enforced. Existing bucket policy had no anonymous/public member. Existing bindings were preserved. The project custom role `lotusbuildSnapshotPolicyReader` contains only `storage.buckets.getIamPolicy` and is bound to the runtime service account on this bucket, allowing startup to verify the policy without granting bucket administration.

Existing versioning was disabled and soft-delete retention was 604800 seconds (7 days); these retention settings were observed, not changed. This does not verify retention in other providers or establish completion of any erasure request.

## Verification

- Prior full local suite: 357 passed, 2 Linux-only skips; typecheck/build passed and production dependency audit reported zero known advisories.
- Targeted Linux filesystem and storage boundary tests on the production candidate: 4 passed, no skips.
- Uploaded archive checksum matched the locally prepared artifact.
- Zero RUNNING/QUEUED sessions observed before cutover.
- Compatibility preflight passed against production Firebase registry, Redis and private snapshot storage.
- After cutover both units were active/running, with zero restarts and exit status 0.
- External `/health`: HTTP 200. Unauthenticated `/projects`, `/family/children`, `/me/privacy-requests`: HTTP 401.

No paid AI build, Stripe purchase, destructive customer erasure, hostile E2B integration exercise or rollback failure drill was performed. Deployment does not close the frontend, child age/parent assurance, privacy disclosure, vendor-contract or other legal assessment gaps in the remediation report.

## Rollback

The cutover installed an automatic rollback trap for immediate restart/health failure; it was not triggered. For a later rollback, inspect the current artifact and previous directory first, acquire `/home/preet/apps/.lotusbuild-deploy.lock`, and use the deployed `deploy/exchange-directories.py` to exchange these exact directories, then run `sudo -n /usr/bin/systemctl restart lotusbuild-api lotusbuild-runner` and verify health. Database rules, indexes and bucket IAM/settings are independent of application rollback and remain deployed. Do not delete either installation while rollback is still needed.
