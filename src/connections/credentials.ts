import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Envelope encryption for provider credentials.
 *
 * Each credential gets its own 256-bit data key (DEK). The DEK encrypts the
 * credential with AES-256-GCM; the DEK itself is encrypted (wrapped) with a
 * key-encryption key (KEK) that lives only in the runtime environment, one per
 * version (`CONNECTION_KEK_V1`, `CONNECTION_KEK_V2`, …). Rotation = introduce
 * the next KEK version, re-wrap every stored DEK under it (no credential is
 * re-encrypted), then retire the old version. Firestore stores ciphertexts only.
 */
export interface SealedCredential {
  readonly keyVersion: number;
  readonly wrappedKey: string;   // base64: iv(12) ‖ tag(16) ‖ ciphertext(32)
  readonly ciphertext: string;   // base64: iv(12) ‖ tag(16) ‖ ciphertext
}

export class CredentialKeyring {
  readonly #keks: ReadonlyMap<number, Buffer>;
  readonly #current: number;

  constructor(keks: ReadonlyMap<number, Buffer>) {
    if (keks.size === 0) throw new Error('At least one connection key-encryption key is required.');
    for (const [version, key] of keks) {
      if (!Number.isInteger(version) || version < 1) throw new Error(`Invalid key version ${version}.`);
      if (key.length !== 32) throw new Error(`Key version ${version} must be 32 bytes.`);
    }
    this.#keks = new Map([...keks].map(([version, key]) => [version, Buffer.from(key)]));
    this.#current = Math.max(...keks.keys());
  }

  get currentVersion(): number { return this.#current; }

  seal(plaintext: Buffer, aad: string): SealedCredential {
    const dek = randomBytes(32);
    try {
      return { keyVersion: this.#current, wrappedKey: encrypt(this.#kek(this.#current), dek, aad), ciphertext: encrypt(dek, plaintext, aad) };
    } finally { dek.fill(0); }
  }

  open(sealed: SealedCredential, aad: string): Buffer {
    const dek = decrypt(this.#kek(sealed.keyVersion), Buffer.from(sealed.wrappedKey, 'base64'), aad);
    try { return decrypt(dek, Buffer.from(sealed.ciphertext, 'base64'), aad); }
    finally { dek.fill(0); }
  }

  /** Re-wraps the data key under the current KEK; the credential ciphertext is untouched. */
  rewrap(sealed: SealedCredential, aad: string): SealedCredential {
    if (sealed.keyVersion === this.#current) return sealed;
    const dek = decrypt(this.#kek(sealed.keyVersion), Buffer.from(sealed.wrappedKey, 'base64'), aad);
    try { return { ...sealed, keyVersion: this.#current, wrappedKey: encrypt(this.#kek(this.#current), dek, aad) }; }
    finally { dek.fill(0); }
  }

  #kek(version: number): Buffer {
    const key = this.#keks.get(version);
    if (key === undefined) throw new Error(`Connection key version ${version} is not available on this service.`);
    return key;
  }
}

/** Reads `CONNECTION_KEK_V<n>` variables (base64, 32 bytes each). */
export function keyringFromEnv(source: Readonly<Record<string, string | undefined>>): CredentialKeyring | undefined {
  const keks = new Map<number, Buffer>();
  for (const [name, value] of Object.entries(source)) {
    const match = /^CONNECTION_KEK_V(\d+)$/.exec(name);
    if (match === null || value === undefined || value.trim() === '') continue;
    const key = Buffer.from(value.trim(), 'base64');
    if (key.length !== 32) throw new Error(`${name} must decode to 32 bytes.`);
    keks.set(Number(match[1]), key);
  }
  return keks.size === 0 ? undefined : new CredentialKeyring(keks);
}

function encrypt(key: Buffer, plaintext: Buffer, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

function decrypt(key: Buffer, packed: Buffer, aad: string): Buffer {
  if (packed.length < 28) throw new Error('Sealed credential is truncated.');
  const decipher = createDecipheriv('aes-256-gcm', key, packed.subarray(0, 12));
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(packed.subarray(12, 28));
  return Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]);
}
