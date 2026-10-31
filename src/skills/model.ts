import { AppError } from '../http/errors.ts';

/** A reusable instruction set the agent can load on demand or on an `@name` mention. */
export interface Skill {
  readonly id: string;
  readonly ownerUid: string;
  /** Stable handle used in mentions and by the `use_skill` tool; unique per owner. */
  readonly name: string;
  readonly title: string;
  /** One line telling the model when this skill applies; the only part always in the prompt. */
  readonly description: string;
  readonly instructions: string;
  readonly enabled: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface SkillInput {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly instructions: string;
  readonly enabled?: boolean;
}

export const skillNamePattern = '^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$';
export const skillLimits = { title: 80, description: 200, instructions: 20_000 } as const;
/** Plans without a `skills.max` capability (seeded before skills existed) get this many. */
export const defaultSkillsMax = 20;
const skillName = new RegExp(skillNamePattern);
const printable = /^[^\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]*$/;
const printableMultiline = /^[^\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]*$/;

const invalid = (message: string) => new AppError({ code: 'skill/invalid', statusCode: 400, message });

/** Shape and size only; uniqueness and ownership are the repository's job. */
export function validateSkillInput(input: SkillInput): Required<SkillInput> {
  const name = input.name.trim().toLowerCase();
  const title = input.title.trim();
  const description = input.description.trim().replace(/\s+/g, ' ');
  const instructions = input.instructions.replace(/\r\n/g, '\n').trim();
  if (!skillName.test(name)) throw invalid('A skill name is 1–48 lowercase letters, digits or hyphens, e.g. "shopify-theme".');
  if (title === '' || title.length > skillLimits.title || !printable.test(title)) throw invalid(`A skill title is 1–${skillLimits.title} characters on one line.`);
  if (description === '' || description.length > skillLimits.description || !printable.test(description)) {
    throw invalid(`A skill description is 1–${skillLimits.description} characters telling the agent when to use it.`);
  }
  if (instructions === '' || instructions.length > skillLimits.instructions || !printableMultiline.test(instructions)) {
    throw invalid(`Skill instructions are 1–${skillLimits.instructions.toLocaleString()} characters of plain text or Markdown.`);
  }
  return { name, title, description, instructions, enabled: input.enabled ?? true };
}
