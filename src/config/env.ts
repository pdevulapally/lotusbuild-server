/**
 * Fail-fast environment loading.
 *
 * The process must refuse to start when configuration is wrong, and it must
 * report *every* problem at once — an operator fixing one missing variable per
 * restart is how a five-minute deploy becomes an hour.
 *
 * Values are never defaulted. A missing variable is an error, not a hint to
 * guess: a silent default is indistinguishable from correct configuration until
 * it is wrong in production.
 */

export class EnvironmentError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      `Invalid environment (${problems.length} problem${problems.length === 1 ? '' : 's'}):\n` +
        problems.map((p) => `  - ${p}`).join('\n'),
    );
    this.name = 'EnvironmentError';
    this.problems = problems;
  }
}

/** A parser turns the raw string into a typed value, or throws explaining why it cannot. */
export type EnvParser<T> = (raw: string) => T;

export interface EnvVarSpec<T> {
  /** Shown in the failure message so an operator knows what to supply. */
  readonly description: string;
  readonly parse: EnvParser<T>;
}

export type EnvSpec = Readonly<Record<string, EnvVarSpec<unknown>>>;

export type LoadedEnv<S extends EnvSpec> = {
  readonly [K in keyof S]: S[K] extends EnvVarSpec<infer T> ? T : never;
};

/**
 * Reads every variable named by `spec` from `source`, collecting failures rather
 * than throwing on the first one.
 */
export function loadEnv<S extends EnvSpec>(
  spec: S,
  source: Readonly<Record<string, string | undefined>>,
): LoadedEnv<S> {
  const problems: string[] = [];
  const loaded: Record<string, unknown> = Object.create(null);

  for (const [name, varSpec] of Object.entries(spec)) {
    const raw = source[name];

    if (raw === undefined || raw.trim() === '') {
      problems.push(`${name} is not set — ${varSpec.description}`);
      continue;
    }

    try {
      loaded[name] = varSpec.parse(raw);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      problems.push(`${name} is invalid — ${reason}`);
    }
  }

  if (problems.length > 0) {
    throw new EnvironmentError(problems);
  }

  return Object.freeze(loaded) as LoadedEnv<S>;
}

/* ------------------------------------------------------------------ parsers */

export const asString =
  (description: string, { minLength = 1 }: { minLength?: number } = {}): EnvVarSpec<string> => ({
    description,
    parse: (raw) => {
      const value = raw.trim();
      if (value.length < minLength) {
        throw new Error(`expected at least ${minLength} character(s), got ${value.length}`);
      }
      return value;
    },
  });

export const asPort = (description: string): EnvVarSpec<number> => ({
  description,
  parse: (raw) => {
    const value = Number(raw.trim());
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
      throw new Error(`expected an integer TCP port 1-65535, got "${raw}"`);
    }
    return value;
  },
});

export const asEnum = <const T extends readonly [string, ...string[]]>(
  description: string,
  allowed: T,
): EnvVarSpec<T[number]> => ({
  description: `${description} (one of: ${allowed.join(', ')})`,
  parse: (raw) => {
    const value = raw.trim();
    if (!allowed.includes(value)) {
      throw new Error(`expected one of ${allowed.join(', ')}, got "${value}"`);
    }
    return value as T[number];
  },
});

export const asUrl = (
  description: string,
  { protocols }: { protocols: readonly string[] },
): EnvVarSpec<URL> => ({
  description: `${description} (${protocols.join(' or ')} URL)`,
  parse: (raw) => {
    let url: URL;
    try {
      url = new URL(raw.trim());
    } catch {
      throw new Error(`expected an absolute URL, got "${raw}"`);
    }
    if (!protocols.includes(url.protocol)) {
      throw new Error(`expected protocol ${protocols.join(' or ')}, got "${url.protocol}"`);
    }
    return url;
  },
});

/** Comma-separated list. Used for things like allowed CORS origins. */
export const asList = <T>(
  description: string,
  item: EnvVarSpec<T>,
): EnvVarSpec<readonly T[]> => ({
  description: `${description} (comma-separated)`,
  parse: (raw) => {
    const parts = raw
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== '');
    if (parts.length === 0) {
      throw new Error('expected at least one comma-separated value');
    }
    return Object.freeze(parts.map((part) => item.parse(part)));
  },
});
