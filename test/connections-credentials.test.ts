import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';

import { CredentialKeyring, keyringFromEnv } from '../src/connections/credentials.ts';

const keyring = (...versions: number[]) =>
  new CredentialKeyring(new Map(versions.map((version) => [version, randomBytes(32)] as const)));

describe('CredentialKeyring', () => {
  it('seals and opens a credential bound to its context', () => {
    const ring = keyring(1);
    const sealed = ring.seal(Buffer.from('token-123'), 'connections/abc');
    assert.equal(sealed.keyVersion, 1);
    assert.equal(ring.open(sealed, 'connections/abc').toString(), 'token-123');
    assert.notEqual(sealed.ciphertext, Buffer.from('token-123').toString('base64'));
  });

  it('refuses a credential moved to another connection or tampered with', () => {
    const ring = keyring(1);
    const sealed = ring.seal(Buffer.from('token'), 'connections/abc');
    assert.throws(() => ring.open(sealed, 'connections/other'));
    const bytes = Buffer.from(sealed.ciphertext, 'base64');
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
    assert.throws(() => ring.open({ ...sealed, ciphertext: bytes.toString('base64') }, 'connections/abc'));
  });

  it('re-wraps under the newest key without touching the credential ciphertext', () => {
    const v1 = randomBytes(32);
    const old = new CredentialKeyring(new Map([[1, v1]]));
    const sealed = old.seal(Buffer.from('token'), 'connections/abc');
    const rotated = new CredentialKeyring(new Map([[1, v1], [2, randomBytes(32)]]));
    const rewrapped = rotated.rewrap(sealed, 'connections/abc');
    assert.equal(rewrapped.keyVersion, 2);
    assert.equal(rewrapped.ciphertext, sealed.ciphertext);
    assert.notEqual(rewrapped.wrappedKey, sealed.wrappedKey);
    assert.equal(rotated.open(rewrapped, 'connections/abc').toString(), 'token');
    const retired = new CredentialKeyring(new Map([[2, randomBytes(32)]]));
    assert.throws(() => retired.open(sealed, 'connections/abc'), /version 1 is not available/);
  });

  it('loads versioned keys from the environment and rejects bad ones', () => {
    assert.equal(keyringFromEnv({ OTHER: 'x' }), undefined);
    const ring = keyringFromEnv({ CONNECTION_KEK_V1: randomBytes(32).toString('base64'), CONNECTION_KEK_V3: randomBytes(32).toString('base64') });
    assert.equal(ring?.currentVersion, 3);
    assert.throws(() => keyringFromEnv({ CONNECTION_KEK_V1: 'short' }), /32 bytes/);
    assert.throws(() => new CredentialKeyring(new Map()), /At least one/);
  });
});
