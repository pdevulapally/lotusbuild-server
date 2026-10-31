import { type MeterDefinition, resetPeriods } from '../entitlements/schema.ts';

type ResetPeriod = (typeof resetPeriods)[number];

/**
 * The instant a meter's current window began, keyed by its reset period.
 *
 * A table rather than a chain of comparisons: adding WEEKLY is a row here and
 * a value in the registry, not another branch every caller has to be aware of.
 * `Record` over the declared periods means a period added to the registry
 * without a rule here fails to compile rather than silently never resetting.
 *
 * Windows are UTC. Any other choice needs a timezone the account does not have,
 * and a quota that resets at a different instant for two users on the same plan
 * is impossible to reason about in support.
 */
const windowStarts: Readonly<Record<ResetPeriod, (now: Date) => number>> = {
  NEVER: () => 0,
  DAILY: (now) => Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  MONTHLY: (now) => Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
};

/**
 * Note for when overage billing lands: a MONTHLY window here is the calendar
 * month, not the subscription's paid period. Someone who subscribes on the 20th
 * therefore gets a fresh allowance on the 1st, ten days early. Aligning the two
 * needs the subscription period threaded in, and has to keep working for users
 * on the default plan who have no subscription at all — so it is a deliberate
 * decision to make then, not a detail to leave to whoever notices first.
 */
export function periodStartFor(meter: MeterDefinition, now: Date): Date {
  return new Date(windowStarts[meter.resetPeriod](now));
}


/** The same UTC calendar boundaries as charging; NEVER has no promised reset. */
export function periodEndFor(meter: MeterDefinition, now: Date): Date | undefined {
  const ends = {
    NEVER: () => undefined,
    DAILY: () => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)),
    MONTHLY: () => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
  };
  return ends[meter.resetPeriod]();
}
