import { FieldValue, type Firestore } from 'firebase-admin/firestore';

import type { EntitlementService } from '../entitlements/service.ts';
import { AppError } from '../http/errors.ts';
import { readMutation, writeMutation, type Mutation } from '../http/idempotency.ts';
import { defaultSkillsMax, validateSkillInput, type Skill, type SkillInput } from './model.ts';

export const skillsCollectionPath = 'skills';
export const skillsMaxCapability = 'skills.max';

type Fields = Record<string, unknown>;

function parseSkill(id: string, fields: Fields, where: string): Skill {
  const text = (name: string) => {
    const value = fields[name];
    if (typeof value !== 'string') throw new Error(`${where}: "${name}" must be a string.`);
    return value;
  };
  const date = (name: string) => {
    const value = fields[name] as { toDate?: () => Date } | undefined;
    return typeof value?.toDate === 'function' ? value.toDate() : new Date(0);
  };
  return {
    id, ownerUid: text('ownerUid'), name: text('name'), title: text('title'), description: text('description'),
    instructions: text('instructions'), enabled: fields['enabled'] !== false, createdAt: date('createdAt'), updatedAt: date('updatedAt'),
  };
}

export interface SkillSource {
  /** Enabled skills the agent may use for this owner, cheapest fields first. */
  enabledFor(ownerUid: string): Promise<readonly Skill[]>;
}

export class SkillRepository implements SkillSource {
  readonly #firestore: Firestore;
  readonly #entitlements: EntitlementService;

  constructor(firestore: Firestore, entitlements: EntitlementService) {
    this.#firestore = firestore;
    this.#entitlements = entitlements;
  }

  #collection() { return this.#firestore.collection(skillsCollectionPath); }

  async #limitFor(ownerUid: string): Promise<number> {
    const entitlements = await this.#entitlements.forUser(ownerUid);
    try {
      return entitlements.capabilities.number(skillsMaxCapability);
    } catch {
      return defaultSkillsMax;
    }
  }

  async list(ownerUid: string): Promise<readonly Skill[]> {
    const snapshot = await this.#collection().where('ownerUid', '==', ownerUid).orderBy('name').limit(500).get();
    return snapshot.docs.map((doc) => parseSkill(doc.id, doc.data(), doc.ref.path));
  }

  async enabledFor(ownerUid: string): Promise<readonly Skill[]> {
    return (await this.list(ownerUid)).filter((skill) => skill.enabled);
  }

  async readOwned(ownerUid: string, skillId: string): Promise<Skill> {
    const snapshot = await this.#collection().doc(skillId).get();
    const data = snapshot.data();
    if (!snapshot.exists || data?.['ownerUid'] !== ownerUid) {
      throw new AppError({ code: 'skill/not-found', statusCode: 404, message: 'No such skill.' });
    }
    return parseSkill(snapshot.id, data ?? {}, snapshot.ref.path);
  }

  async create(ownerUid: string, input: SkillInput, operation?: Mutation<Skill>): Promise<Skill> {
    const valid = validateSkillInput(input);
    const limit = await this.#limitFor(ownerUid);
    const ref = this.#collection().doc();
    await this.#firestore.runTransaction(async (transaction) => {
      await readMutation(transaction, this.#firestore, operation);
      const existing = await transaction.get(this.#collection().where('ownerUid', '==', ownerUid).limit(limit + 1));
      if (existing.size >= limit) {
        throw new AppError({ code: 'skill/limit-reached', statusCode: 403, message: `Your plan allows ${limit} skills.`, details: { limit } });
      }
      if (existing.docs.some((doc) => doc.data()['name'] === valid.name)) {
        throw new AppError({ code: 'skill/name-taken', statusCode: 409, message: `You already have a skill named "${valid.name}".` });
      }
      transaction.create(ref, { ownerUid, ...valid, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
      const result: Skill = { id: ref.id, ownerUid, ...valid, createdAt: new Date(), updatedAt: new Date() };
      writeMutation(transaction, this.#firestore, operation, result);
    });
    return this.readOwned(ownerUid, ref.id);
  }

  async update(ownerUid: string, skillId: string, input: Partial<SkillInput>): Promise<Skill> {
    const current = await this.readOwned(ownerUid, skillId);
    const valid = validateSkillInput({ ...current, ...input });
    if (valid.name !== current.name) {
      const clash = await this.#collection().where('ownerUid', '==', ownerUid).where('name', '==', valid.name).limit(1).get();
      if (!clash.empty) throw new AppError({ code: 'skill/name-taken', statusCode: 409, message: `You already have a skill named "${valid.name}".` });
    }
    await this.#collection().doc(skillId).update({ ...valid, updatedAt: FieldValue.serverTimestamp() });
    return this.readOwned(ownerUid, skillId);
  }

  async delete(ownerUid: string, skillId: string): Promise<void> {
    await this.readOwned(ownerUid, skillId);
    await this.#collection().doc(skillId).delete();
  }
}
