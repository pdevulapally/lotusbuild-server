import { readFileSync } from 'node:fs';

/** The directory holding `release.json`: the repository root in development, the release root once packaged. */
const releaseRoot = new URL('../', import.meta.url);

/** Same shape the packaging step accepts: a full lowercase hex git object name. */
const revisionPattern = /^[0-9a-f]{40,64}$/;

/**
 * The git revision this build was packaged from, read from the `release.json`
 * that CI ships beside `dist`.
 *
 * Absent means "nothing packaged this tree" — a development checkout — and is a
 * legitimate answer. A file that is there but unusable is a broken release, and
 * reporting a made-up revision for it would defeat the point of asking, so that
 * throws.
 */
export function releaseRevision(root: URL = releaseRoot): string | undefined {
  let bytes: Buffer;
  try {
    bytes = readFileSync(new URL('release.json', root));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (bytes.length > 4096) throw new Error('release.json is larger than any release metadata should be.');

  const metadata: unknown = JSON.parse(bytes.toString('utf8'));
  const revision =
    typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>)['revision']
      : undefined;
  if (typeof revision !== 'string' || !revisionPattern.test(revision)) {
    throw new Error('release.json does not carry a valid revision.');
  }
  return revision;
}
