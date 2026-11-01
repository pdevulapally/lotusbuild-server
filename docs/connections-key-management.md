# Connection credential key management

Connection credentials (OAuth tokens, Slack bot tokens, MCP bearer tokens)
are sealed by `src/connections/credentials.ts` with envelope encryption:

- a fresh random 256-bit **data-encryption key (DEK)** per credential;
- the credential encrypted with that DEK using **AES-256-GCM**, with the
  ciphertext bound to `connection_credentials/{connectionId}#{ownerUid}`
  as additional authenticated data, so a sealed blob cannot be re-pointed
  at another connection or user;
- the DEK wrapped with a versioned **key-encryption key (KEK)**; the
  document stores only `keyVersion`, `wrappedKey` and `ciphertext`.

Plaintext credentials, DEKs and KEKs are never written to Firestore, logs,
checkpoints, model context or API responses. `connection_credentials` is
read by the API process only; Firestore rules deny all client access.

## Runtime keys

KEKs are read at start-up from `CONNECTION_KEK_V<n>` (base64, exactly
32 bytes each; `n` is a positive integer). The highest version present is
used for new seals and re-wraps; every version present can open. When no
variable is set the whole connections API answers
`connections/configuration-required` and nothing is stored.

Generate a key with `openssl rand -base64 32`. Add it to the VPS `.env`
like the OpenRouter variables; it is never committed or echoed.

## Rotation

Rotation re-wraps DEKs under the new KEK. Credential ciphertext is not
touched, so rotation costs one small write per connection and never needs
the provider.

1. **Stage** — add `CONNECTION_KEK_V<n+1>` next to the current key; deploy.
   New seals use `n+1`; existing records still open with `n`.
2. **Re-wrap** — run the (to be added with the first provider adapter)
   `dist/seed/rewrap-connection-credentials.js` dry run, then `--apply`.
   It calls `CredentialKeyring.rewrap` for every record whose
   `keyVersion < n+1`, in a transaction that aborts if the record changed.
   Progress is idempotent: rerunning skips already re-wrapped records.
3. **Verify** — the job reports counts per version; confirm none remain on
   `n` (a read-only query on `keyVersion`).
4. **Retire** — remove `CONNECTION_KEK_V<n>` from `.env`; deploy. A record
   still on `n` would now fail to open and surface as
   `configuration_required` for that connection — which is why step 3 is
   mandatory, not advisory.
5. **Keep** the retired key value in the secret manager, read-only, for
   the backup retention window: a restored backup may contain records
   wrapped with it.

Rollback at any step before 4 is removing the new variable and
redeploying; records already re-wrapped to `n+1` must be re-wrapped back
first (the same job with `--to <n>`), so retire only after verifying.

## Compromise response

If a KEK may have leaked, rotate as above **and** revoke the underlying
provider credentials: a leaked KEK plus a Firestore export reveals every
credential it wrapped. Rotation alone protects only future exports.

## Production key storage (not yet implemented)

Environment variables are the slice 0 mechanism because that is how every
other production secret on the VPS is managed today. Before activating a
provider for real users, keys should move to a managed secret store:

- store each `CONNECTION_KEK_V<n>` in a secret manager (the VPS host has no
  cloud KMS today; options are GCP Secret Manager alongside Firebase, or
  SOPS/age-encrypted env files with the age key held off-host);
- load them at process start only, never into a shell history;
- audit reads and restrict the secret to the API service account;
- a KMS-wrapped KEK (`CredentialKeyring` accepting an unwrap callback)
  is the natural next step and does not change the stored record format.

This choice needs your approval before any live credential is stored.
