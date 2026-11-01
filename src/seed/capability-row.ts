type Fields = Record<string, unknown>;

export interface CapabilityChange {
  readonly capabilityKey: string;
  readonly from: unknown;
  readonly to: unknown;
}

/**
 * Sets one boolean entitlement row on a plan document. Every other row and
 * every other plan field is returned untouched, so the edit stays as narrow as
 * the decision; a plan without the row is refused rather than extended, because
 * the registry declares which capabilities exist.
 */
export function withBooleanCapability(plan: Fields, capabilityKey: string, value: boolean): { fields: Fields; changes: readonly CapabilityChange[] } {
  const rows = plan['entitlements'];
  if (!Array.isArray(rows)) throw new Error('The plan document has no entitlements array.');
  const changes: CapabilityChange[] = [];
  let found = false;
  const entitlements = rows.map((row: unknown) => {
    if (row === null || typeof row !== 'object' || (row as Fields)['capabilityKey'] !== capabilityKey) return row;
    found = true;
    const current = (row as Fields)['value'];
    const next = { kind: 'boolean', value };
    if (JSON.stringify(current) === JSON.stringify(next)) return row;
    changes.push({ capabilityKey, from: current, to: next });
    return { ...(row as Fields), value: next };
  });
  if (!found) throw new Error(`The plan has no ${capabilityKey} entitlement row.`);
  return { fields: { ...plan, entitlements }, changes };
}
