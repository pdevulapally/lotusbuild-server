import { aiEfforts } from '../../src/entitlements/build-admission.ts';
import type { ModelResolver } from '../../src/models/catalog.ts';

export const fixtureModels: ModelResolver = {
  get: async id => ({ id, name: id, efforts: [...aiEfforts], maxOutputTokens: 64_000 }),
};
