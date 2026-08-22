# Recovered reference from the deleted Postgres backend

These two files are the *only* surviving artefact of the backend that ran until
14 Aug 2026. The source tree was lost with the machine; the nightly `pg_dump`
custom-format backups in `~/backups` on the VM survived, and this is what was
extracted from `lotusbuild-20260814T031501Z.dump`.

- **`postgres-schema.sql`** — 21 tables, every enum, constraint and index.
- **`postgres-seed-config.sql`** — the configuration rows: plans, capabilities,
  meters, per-plan limits, rate limits, sandbox providers. No user data.

## Why they are kept

We are moving to Firestore + Redis, so this schema will not be recreated as-is.
It is kept because it is a **specification, not an implementation**: the domain
rules in it were arrived at over weeks and cost at least two production
incidents to get right. Rebuilding them from memory would be guessing.

Two rules encoded here that are easy to lose and expensive to rediscover:

1. **Reserve-at-max.** `usage_reservations` reserves a sandbox's *full*
   `timeout_seconds` up front, which makes overspend structurally impossible —
   and creates the invariant that no plan's `sandbox.seconds` hard limit may be
   below the largest provider `timeout_seconds`. Violating it 402s every build
   on that tier before any work happens, so it reads as a usage problem rather
   than a configuration one.

2. **Merge strategies are per capability, not global.** `ai.run` merges `MAX` so
   an extra grant can enable but never revoke; `ai.model.allowlist` merges
   `INTERSECTION` so a narrower source tightens rather than widens. Getting
   either direction backwards is a privilege-escalation bug, not a config typo.

The `sandbox_providers.agent_instructions` column is also worth reading before
writing the new agent prompt — it carries hard-won specifics (React Native has
no `div`; a dev server bound to localhost is unreachable from outside the
sandbox; a blank Expo app is pre-installed so the agent must not scaffold one).

Full dumps are **not** in this repo. They live outside it at
`Desktop\lotusbuild-recovered-backups\` and contain real user rows.
