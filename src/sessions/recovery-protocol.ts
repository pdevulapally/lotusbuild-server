import { readFileSync } from 'node:fs';
import { AppError } from '../http/errors.ts';

const releaseRoot = new URL('../../', import.meta.url);
let supported: number | undefined;

function protocol(value: unknown): number {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid protocol metadata.');
  const version: unknown = (value as Record<string, unknown>)['runnerRecoveryProtocol'];
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1 || version > 2147483647) throw new Error('Invalid protocol metadata.');
  return version;
}

/** package.json is the one release capability declaration, shared with packaging. */
export function runnerRecoveryProtocol(): number {
  if (supported !== undefined) return supported;
  try { supported = protocol(JSON.parse(readFileSync(new URL('package.json', releaseRoot), 'utf8'))); }
  catch { throw new AppError({ code: 'release/recovery-protocol-incompatible', statusCode: 503, message: 'Release recovery protocol metadata is invalid.' }); }
  return supported;
}

/** Production preflight checks the packaged declaration before any provider access. */
export function assertReleaseRecoveryProtocol(root: URL = releaseRoot): void {
  try {
    const bytes = readFileSync(new URL('release.json', root));
    if (bytes.length > 4096 || protocol(JSON.parse(bytes.toString('utf8'))) !== runnerRecoveryProtocol()) throw new Error('Protocol mismatch.');
  } catch {
    throw new AppError({ code: 'release/recovery-protocol-incompatible', statusCode: 503, message: 'Release recovery protocol metadata is missing, invalid or unsupported.' });
  }
}
