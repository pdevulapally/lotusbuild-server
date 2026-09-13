import type { SandboxProvider } from '../entitlements/schema.ts';
import { randomUUID } from 'node:crypto';
import type { UserEntitlements } from '../entitlements/service.ts';
import { AppError } from '../http/errors.ts';
import type { RunningSandbox } from '../sandboxes/provider.ts';
import type { SessionLease } from '../sessions/repository.ts';
import {
  snapshotContentType,
  type SnapshotStorage,
  type StoredSnapshot,
  type UploadedSnapshot,
} from '../storage/snapshots.ts';
import type { Project } from './repository.ts';

/** Where the archive and the signed URL are staged, outside the project tree. */
const archivePath = '/tmp/lotusbuild-repo.tar.gz';
const urlPath = '/tmp/lotusbuild-url';

export type RestoreOutcome = 'restored' | 'initialised';

export interface SaveOutcome {
  readonly bytes: number;
  readonly committed: boolean;
  /**
   * The snapshot this save superseded could not be deleted.
   *
   * Returned rather than thrown because it happens after the project already
   * points at the new snapshot: the save is durable, and what is left is an
   * object nobody references. Reporting that as a failed save would tell the
   * user their work was lost when it was not. It is still a real problem — it
   * occupies bytes that are no longer metered — so the caller must record it.
   */
  readonly cleanupFailure:
    | { readonly superseded: StoredSnapshot; readonly cause: unknown }
    | undefined;
}

export interface GitIdentity {
  readonly name: string;
  readonly email: string;
}

export interface SnapshotPublisher {
  assertPersistenceLease(authority: SessionLease, cleanup?: boolean): Promise<void>;
  reserveSnapshotUpload(authority: SessionLease, entitlements: UserEntitlements,
    input: { id: string; objectName: string; bytes: number; expiresAt: Date }, cleanup?: boolean): Promise<void>;
  publishSnapshot(
    authority: SessionLease,
    entitlements: UserEntitlements,
    snapshot: UploadedSnapshot,
    uploadId: string,
    cleanup?: boolean,
  ): Promise<{ readonly projectId: string; readonly previous: StoredSnapshot }>;
}

/**
 * Makes a project outlive the sandbox that built it.
 *
 * The durable artefact is the project's own git repository, archived whole. The
 * working tree is not saved at all — it is reconstructed from the repository on
 * the way back in, which means the project's `.gitignore` decides what persists
 * and `node_modules` never travels. It also means the user gets real history:
 * every session is a commit, in a repository they could one day be handed.
 *
 * Nothing moves through this process. The sandbox fetches and uploads directly
 * with a signed URL, so a 40MB repository costs the runner one HTTP call to
 * mint a URL rather than 40MB of resident memory on a box that is also running
 * the API.
 */
export class ProjectPersistence {
  readonly #publisher: SnapshotPublisher;
  readonly #snapshots: SnapshotStorage;
  readonly #identity: GitIdentity;
  readonly #commandTimeoutMs: number;

  constructor(
    publisher: SnapshotPublisher,
    snapshots: SnapshotStorage,
    identity: GitIdentity,
    commandTimeoutMs: number,
  ) {
    this.#publisher = publisher;
    this.#snapshots = snapshots;
    this.#identity = identity;
    this.#commandTimeoutMs = commandTimeoutMs;
  }

  /**
   * Every command runs with the project directory as its working directory, so
   * no path is ever spliced into a command string.
   */
  async #run(
    sandbox: RunningSandbox,
    provider: SandboxProvider,
    script: string,
    envs?: Readonly<Record<string, string>>,
  ): Promise<string> {
    const outcome = await sandbox.runCommand(script, {
      cwd: provider.workdir,
      timeoutMs: this.#commandTimeoutMs,
      ...(envs === undefined ? {} : { envs }),
    });
    if (outcome.exitCode !== 0) {
      throw new AppError({
        code: 'project/persistence-failed',
        statusCode: 500,
        message: 'The project could not be saved or restored.',
        details: { exitCode: outcome.exitCode, stderr: outcome.stderr.slice(0, 500) },
      });
    }
    return outcome.stdout;
  }

  #gitEnv(): Record<string, string> {
    // Git takes an identity from the environment, which spares us writing a
    // config file and spares the shell ever seeing these values.
    return {
      GIT_AUTHOR_NAME: this.#identity.name,
      GIT_AUTHOR_EMAIL: this.#identity.email,
      GIT_COMMITTER_NAME: this.#identity.name,
      GIT_COMMITTER_EMAIL: this.#identity.email,
    };
  }

  /**
   * Puts the project back into a fresh sandbox, or starts a repository for one
   * that has never been saved.
   *
   * Which of the two happens is decided by the project document alone. `none`
   * is the only state that may end in `git init`; every other state has already
   * asserted that a snapshot exists, so a Storage object that cannot be produced
   * fails the restore rather than quietly becoming an empty project.
   */
  async restore(
    sandbox: RunningSandbox,
    provider: SandboxProvider,
    project: Project,
  ): Promise<RestoreOutcome> {
    if (project.snapshot.kind === 'none') {
      await this.#run(
        sandbox,
        provider,
        'set -eu\ngit init -q\n',
        this.#gitEnv(),
      );
      return 'initialised';
    }

    const url = await this.#snapshots.readUrl(project.id, project.snapshot);

    // The URL is handed over in a file rather than on the command line: it is a
    // bearer credential, and an argument is visible to every process in the
    // sandbox through /proc.
    await sandbox.writeFile(urlPath, url);
    await this.#run(
      sandbox,
      provider,
      [
        'set -eu',
        `url=$(cat ${urlPath})`,
        `rm -f ${urlPath}`,
        `curl -sfL -o ${archivePath} "$url"`,
        // Only .git is in the archive; the working tree comes back from it.
        `tar -xzf ${archivePath} -C .`,
        `rm -f ${archivePath}`,
        // A repository saved before its first commit has no HEAD to restore to,
        // which is not a failure — there is simply nothing checked in yet.
        'if git rev-parse --verify HEAD >/dev/null 2>&1; then git reset --hard HEAD >/dev/null; fi',
        '',
      ].join('\n'),
      this.#gitEnv(),
    );
    return 'restored';
  }

  /**
   * Commits whatever the agent did and stores the repository.
   *
   * The order is deliberate: verify authority, upload to an immutable candidate,
   * inspect trusted Storage metadata, then transactionally publish and charge.
   * A candidate that loses the publish race is never referenced by the project.
   *
   * `publishSnapshot` is the commit boundary. Anything that fails before it
   * throws, and the project keeps the snapshot it had. Once it returns, the save
   * is durable and this method resolves — collecting the superseded object is
   * the last step, and the only one whose failure is reported instead of raised.
   */
  async save(input: {
    readonly sandbox: RunningSandbox;
    readonly provider: SandboxProvider;
    readonly project: Project;
    readonly entitlements: UserEntitlements;
    readonly authority: SessionLease;
    readonly commitMessage: string;
    readonly cleanup?: boolean;
  }): Promise<SaveOutcome> {
    // This pre-check stops a runner that is already stale before it commits or
    // archives anything. The guarded publish below is still required because
    // ownership can change while the archive is being uploaded.
    await this.#publisher.assertPersistenceLease(input.authority, input.cleanup);

    const stdout = await this.#run(
      input.sandbox,
      input.provider,
      [
        'set -eu',
        'git add -A',
        // `status --porcelain` is empty exactly when there is nothing to record,
        // and unlike `diff --cached` it answers that before the first commit too.
        'if [ -n "$(git status --porcelain)" ]; then',
        '  git commit -q -m "$LOTUSBUILD_COMMIT_MESSAGE"',
        '  echo committed=yes',
        'else',
        '  echo committed=no',
        'fi',
        `tar -czf ${archivePath} .git`,
        '',
      ].join('\n'),
      { ...this.#gitEnv(), LOTUSBUILD_COMMIT_MESSAGE: input.commitMessage },
    );

    const committed = stdout.includes('committed=yes');
    const size = (await this.#run(input.sandbox, input.provider, `set -eu\nstat -c %s ${archivePath}\n`)).trim();
    if (!/^[1-9]\d*$/.test(size) || !Number.isSafeInteger(Number(size))) throw new Error('Snapshot archive size is invalid.');
    const bytes = Number(size);
    const uploadId = `${input.authority.token}-${randomUUID()}`;
    const upload = await this.#snapshots.createUpload(input.project.id, uploadId, bytes, async (objectName, expiresAt) => {
      await this.#publisher.reserveSnapshotUpload(input.authority, input.entitlements, { id: uploadId, objectName, bytes, expiresAt }, input.cleanup);
    });
    await input.sandbox.writeFile(urlPath, upload.url);
    await this.#run(
      input.sandbox,
      input.provider,
      [
        'set -eu',
        `url=$(cat ${urlPath})`,
        `rm -f ${urlPath}`,
        `curl -sf -X PUT -H "Content-Type: ${snapshotContentType}" -H "x-goog-if-generation-match: 0" -H "Content-Length: $LOTUSBUILD_UPLOAD_BYTES" --upload-file ${archivePath} "$url"`,
        `rm -f ${archivePath}`,
        '',
      ].join('\n'),
      { LOTUSBUILD_UPLOAD_BYTES: String(bytes) },
    );

    // Size and generation come from trusted Storage metadata, not sandbox
    // stdout. The transaction is the publish point: until it commits, this
    // immutable object is only an unreferenced candidate.
    const uploaded = await this.#snapshots.inspectUpload(upload.objectName);
    const published = await this.#publisher.publishSnapshot(
      input.authority,
      input.entitlements,
      uploaded,
      uploadId,
      input.cleanup,
    );
    // Everything above this line decides whether the save happens; everything
    // below it has already happened. Deleting what the publish superseded is
    // garbage collection against durable state, so its failure is carried back
    // as a fact about the storage rather than thrown as a fact about the save.
    // The durable upload ledger collects superseded objects after their write
    // credentials expire. Their bytes remain charged until deletion succeeds.
    return { bytes: uploaded.bytes, committed, cleanupFailure: undefined };
  }
}
