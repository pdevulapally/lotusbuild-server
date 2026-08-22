/**
 * Holds one value for a while.
 *
 * Configuration is read on nearly every request but changes by hand a few times
 * a month, and every Firestore read is billed. This keeps a single entry per
 * cache — not a keyed map — so memory is bounded by construction rather than by
 * an eviction policy nobody tunes.
 *
 * Concurrent misses share one load. Without that, a burst of requests arriving
 * on a cold cache each issues its own read, which is exactly the moment the
 * reads are least affordable.
 */
export interface Cached<T> {
  get(): Promise<T>;
  /** Drops the value so the next `get` reloads. For a config-changed webhook. */
  invalidate(): void;
}

export function cached<T>(ttlMs: number, load: () => Promise<T>): Cached<T> {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error(`A cache TTL must be a positive number of milliseconds, got ${ttlMs}.`);
  }

  let value: { readonly held: T; readonly expiresAt: number } | undefined;
  let inFlight: Promise<T> | undefined;

  return {
    async get(): Promise<T> {
      const now = Date.now();
      if (value !== undefined && now < value.expiresAt) {
        return value.held;
      }
      if (inFlight !== undefined) {
        return inFlight;
      }

      inFlight = load()
        .then((loaded) => {
          value = { held: loaded, expiresAt: Date.now() + ttlMs };
          return loaded;
        })
        .finally(() => {
          // Cleared on failure too, so a transient error does not wedge the
          // cache into permanently replaying the same rejected promise.
          inFlight = undefined;
        });

      return inFlight;
    },

    invalidate(): void {
      value = undefined;
    },
  };
}
