import { type DocumentReference, FieldPath, FieldValue, type Firestore } from 'firebase-admin/firestore';

import { projectsCollectionPath } from '../projects/repository.ts';
import {
  buildSessionStatuses,
  sessionsCollectionPath,
  type BuildSessionStatus,
} from '../sessions/repository.ts';
import { DocumentShapeError, enumField, stringField } from '../support/documents.ts';

/**
 * Projects read per page.
 *
 * A migration-only constant, deliberately not configuration: there is no runtime
 * value this could be missing a default for, and an operator tuning it would be
 * changing the migration rather than deploying it. 100 keeps a page's documents
 * small enough to hold comfortably while making the per-page round trip
 * negligible against the per-project transaction that follows it.
 */
const defaultProjectPageSize = 100;

/** Enough to tell zero from one from more-than-one, and no more. */
const activeSessionProbeLimit = 2;

export type MigrationStage =
  | 'project-vanished'
  | 'project-shape'
  | 'session-shape'
  | 'session-not-active'
  | 'session-project-mismatch'
  | 'session-owner-mismatch'
  | 'multiple-active-sessions'
  | 'contradictory-guard';

export interface ProjectMigrationFailure {
  readonly projectId: string;
  readonly stage: MigrationStage;
  /** Safe to print: ids and shapes only, never tokens, URLs or prompt text. */
  readonly reason: string;
}

export interface ProjectActiveSessionMigrationResult {
  readonly scanned: number;
  /** Written `activeSessionId = null`: no session owns the workspace. */
  readonly unlocked: number;
  /** Written `activeSessionId = <session>`: one validated active session. */
  readonly adopted: number;
  /** Already carried a guard that agrees with observed session state. */
  readonly alreadyMigrated: number;
  readonly failures: readonly ProjectMigrationFailure[];
}

export interface ProjectActiveSessionMigrationOptions {
  readonly pageSize?: number | undefined;
  /** Read and validate everything, write nothing. */
  readonly dryRun?: boolean | undefined;
}

type ProjectOutcome =
  | { readonly kind: 'unlocked' }
  | { readonly kind: 'adopted'; readonly sessionId: string }
  | { readonly kind: 'already-migrated' }
  | { readonly kind: 'failed'; readonly stage: MigrationStage; readonly reason: string };

function storedGuard(
  fields: Readonly<Record<string, unknown>>,
  path: string,
): string | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(fields, 'activeSessionId')) {
    return undefined;
  }
  const value = fields['activeSessionId'];
  if (value === null) {
    return null;
  }
  return stringField(fields, 'activeSessionId', path);
}

function active(status: BuildSessionStatus): boolean {
  return status === 'QUEUED' || status === 'RUNNING';
}

function failed(stage: MigrationStage, reason: string): ProjectOutcome {
  return { kind: 'failed', stage, reason };
}

/**
 * Decides and applies one project's guard, inside a transaction so the sessions
 * it inspected are the sessions its write is justified by.
 *
 * Validation problems are returned rather than thrown: they describe this
 * project's data, and the run collects them so an operator sees every broken
 * project in one pass instead of one per rerun. A `DocumentShapeError` is caught
 * by the caller for the same reason. Anything else — an unreachable Firestore, a
 * permission failure — is not this project's problem and is left to propagate.
 */
async function migrateOne(
  firestore: Firestore,
  projectRef: DocumentReference,
  activeStatuses: readonly BuildSessionStatus[],
  dryRun: boolean,
): Promise<ProjectOutcome> {
  return firestore.runTransaction(async (transaction) => {
    const project = await transaction.get(projectRef);
    if (!project.exists) {
      return failed(
        'project-vanished',
        `${projectRef.path} disappeared while the migration was running, so the population was ` +
          'not stable; confirm the API and runner processes are stopped and rerun.',
      );
    }
    const projectFields = project.data() ?? {};
    const projectOwnerUid = stringField(projectFields, 'ownerUid', project.ref.path);
    const guard = storedGuard(projectFields, project.ref.path);

    // Bounded two ways: only active statuses match, and only two are fetched.
    // A project with years of finished sessions costs the same as a new one.
    const candidates = await transaction.get(
      firestore
        .collection(sessionsCollectionPath)
        .where('projectId', '==', project.id)
        .where('status', 'in', activeStatuses)
        .limit(activeSessionProbeLimit),
    );

    if (candidates.docs.length > 1) {
      const ids = candidates.docs.map((session) => session.id).join(', ');
      return failed(
        'multiple-active-sessions',
        `${project.ref.path} has at least ${candidates.docs.length} active sessions (${ids}); ` +
          'resolve that contradiction by hand before rerunning the migration.',
      );
    }

    let expected: string | null = null;
    const candidate = candidates.docs[0];
    if (candidate !== undefined) {
      const sessionFields = candidate.data() ?? {};
      const path = candidate.ref.path;

      // Re-read from the document rather than trusting the query's filters, so
      // an index that answered with something stale cannot get a session
      // adopted on the strength of a status it no longer holds.
      let status: BuildSessionStatus;
      let sessionProjectId: string;
      let sessionOwnerUid: string;
      try {
        status = enumField(sessionFields, 'status', path, buildSessionStatuses);
        sessionProjectId = stringField(sessionFields, 'projectId', path);
        sessionOwnerUid = stringField(sessionFields, 'ownerUid', path);
      } catch (error) {
        if (!(error instanceof DocumentShapeError)) {
          throw error;
        }
        // Distinguished from a malformed project: a different document to fix.
        return failed('session-shape', error.message);
      }

      if (!active(status)) {
        return failed(
          'session-not-active',
          `${path} matched the active-session query but its status is ${status}.`,
        );
      }
      if (sessionProjectId !== project.id) {
        return failed(
          'session-project-mismatch',
          `${path} belongs to project ${sessionProjectId}, not ${project.id}.`,
        );
      }
      if (sessionOwnerUid !== projectOwnerUid) {
        return failed(
          'session-owner-mismatch',
          `${path} is owned by a different user than ${project.ref.path}; the session was not ` +
            'adopted and neither document was changed.',
        );
      }
      expected = candidate.id;
    }

    if (guard !== undefined) {
      if (guard !== expected) {
        return failed(
          'contradictory-guard',
          `${project.ref.path} records activeSessionId=${String(guard)} but its active session is ` +
            `${String(expected)}; resolve that contradiction before rerunning the migration.`,
        );
      }
      return { kind: 'already-migrated' };
    }

    if (!dryRun) {
      transaction.update(project.ref, {
        activeSessionId: expected,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    return expected === null ? { kind: 'unlocked' } : { kind: 'adopted', sessionId: expected };
  });
}

/**
 * One-time compatibility migration for projects created before activeSessionId.
 *
 * Run with the API and runner processes stopped. The scan is a sequence of
 * pages rather than one snapshot, and each project's active sessions are probed
 * two at a time, so a session created, claimed or finished while this runs could
 * be missed entirely or counted against a page that has already gone by. The
 * maintenance window is what makes the population stable enough for that to be
 * sound; nothing here detects its absence.
 *
 * Resumable by construction: no progress is remembered between runs, each
 * project is decided in its own transaction, and a project that already carries
 * a guard is validated against observed sessions rather than rewritten.
 */
export async function migrateProjectActiveSessions(
  firestore: Firestore,
  options: ProjectActiveSessionMigrationOptions = {},
): Promise<ProjectActiveSessionMigrationResult> {
  const pageSize = options.pageSize === undefined ? defaultProjectPageSize : options.pageSize;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) {
    throw new Error(`A migration page size must be a positive whole number, got ${pageSize}.`);
  }
  const dryRun = options.dryRun === true;

  const activeStatuses = buildSessionStatuses.filter(active);
  if (activeStatuses.length === 0) {
    throw new Error('No session status counts as active, so no project could be migrated.');
  }

  const failures: ProjectMigrationFailure[] = [];
  let scanned = 0;
  let unlocked = 0;
  let adopted = 0;
  let alreadyMigrated = 0;

  // Ordering by document id is the one order every collection already has, needs
  // no composite index, and is immutable — a cursor into it cannot be invalidated
  // by a field this migration or anything else writes.
  let cursor: string | undefined;
  for (;;) {
    const page = firestore
      .collection(projectsCollectionPath)
      .orderBy(FieldPath.documentId())
      .limit(pageSize);
    const documents = (await (cursor === undefined ? page : page.startAfter(cursor)).get()).docs;
    if (documents.length === 0) {
      break;
    }

    for (const document of documents) {
      scanned += 1;
      let outcome: ProjectOutcome;
      try {
        outcome = await migrateOne(firestore, document.ref, activeStatuses, dryRun);
      } catch (error) {
        if (!(error instanceof DocumentShapeError)) {
          throw error;
        }
        outcome = failed('project-shape', error.message);
      }
      switch (outcome.kind) {
        case 'unlocked':
          unlocked += 1;
          break;
        case 'adopted':
          adopted += 1;
          break;
        case 'already-migrated':
          alreadyMigrated += 1;
          break;
        case 'failed':
          failures.push({
            projectId: document.id,
            stage: outcome.stage,
            reason: outcome.reason,
          });
          break;
      }
    }

    const last = documents[documents.length - 1];
    if (last === undefined || documents.length < pageSize) {
      break;
    }
    cursor = last.id;
  }

  return { scanned, unlocked, adopted, alreadyMigrated, failures };
}
