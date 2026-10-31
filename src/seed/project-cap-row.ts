import { unlimited } from '../entitlements/values.ts';

type Fields = Record<string, unknown>;

export interface CapChange {
  readonly capabilityKey: string;
  readonly from: unknown;
  readonly to: unknown;
}

/**
 * Lifts a plan's project cap: the `projects.max` entitlement row becomes the
 * explicit `unlimited` value. Every other entitlement row, and every other plan
 * field, is returned untouched, so the edit stays as narrow as the decision.
 *
 * Re-seeding would also reset limits an operator has since edited, which is why
 * this is its own reviewable change and not a reseed.
 */
export function withUnlimitedProjects(plan: Fields): { fields: Fields; changes: readonly CapChange[] } {
  const rows = plan['entitlements'];
  if (!Array.isArray(rows)) throw new Error('The plan document has no entitlements array.');
  const changes: CapChange[] = [];
  let found = false;
  const entitlements = rows.map((row: unknown) => {
    if (row === null || typeof row !== 'object' || (row as Fields)['capabilityKey'] !== 'projects.max') return row;
    found = true;
    const current = (row as Fields)['value'];
    const next = { kind: 'number', value: unlimited };
    if (JSON.stringify(current) === JSON.stringify(next)) return row;
    changes.push({ capabilityKey: 'projects.max', from: current, to: next });
    return { ...(row as Fields), value: next };
  });
  if (!found) throw new Error('The plan has no projects.max entitlement row; nothing to lift.');
  return { fields: { ...plan, entitlements }, changes };
}
