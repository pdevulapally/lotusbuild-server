import type { Firestore } from 'firebase-admin/firestore';
import { FieldValue } from 'firebase-admin/firestore';

import type { SandboxProvider } from '../entitlements/schema.ts';
import type { UserEntitlements } from '../entitlements/service.ts';
import type { ConfigurationStore } from '../entitlements/store.ts';
import { AppError } from '../http/errors.ts';
import type { MeteringService } from '../metering/service.ts';
import type { RunningSandbox } from '../sandboxes/provider.ts';
import { snapshotContentType } from '../storage/snapshots.ts';
import type { SnapshotStore } from '../storage/snapshots.ts';
import { countField } from '../support/documents.ts';
import type { Project, ProjectRepository } from './repository.ts';

/** Where the archive and the signed URL are staged, outside the project tree. */
const archivePath = '/tmp/lotusbuild-repo.tar.gz';
const urlPath = '/tmp/lotusbuild-url';

export type RestoreOutcome = 'restored' | 'initialised';

export interface SaveOutcome {
  readonly bytes: number;
  readonly committed: boolean;
}

export interface GitIdentity {
  readonly name: string;
  readonly email: string;
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
  readonly #firestore: Firestore;
  readonly #projects: ProjectRepository;
  readonly #configuration: ConfigurationStore;
  readonly #metering: MeteringService;
  readonly #snapshots: SnapshotStore;
  readonly #identity: GitIdentity;
  readonly #commandTimeoutMs: number;

  constructor(
    firestore: Firestore,
    projects: ProjectRepository,
    configuration: ConfigurationStore,
    metering: MeteringService,
    snapshots: SnapshotStore,
    identity: GitIdentity,
    commandTimeoutMs: number,
  ) {
    this.#firestore = firestore;
    this.#projects = projects;
    this.#configuration = configuration;
    this.#metering = metering;
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
   */
  async restore(
    sandbox: RunningSandbox,
    provider: SandboxProvider,
    project: Project,
  ): Promise<RestoreOutcome> {
    const url = await this.#snapshots.readUrl(project.id);

    if (url === undefined) {
      await this.#run(
        sandbox,
        provider,
        'set -eu\ngit init -q\n',
        this.#gitEnv(),
      );
      return 'initialised';
    }

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
   * The order is deliberate: archive, measure, charge, then upload. Charging
   * before the upload means a project that would exceed its plan's storage is
   * refused while its previous snapshot is still intact — uploading first would
   * have already overwritten the thing we then decided we could not keep.
   */
  async save(input: {
    readonly sandbox: RunningSandbox;
    readonly provider: SandboxProvider;
    readonly project: Project;
    readonly entitlements: UserEntitlements;
    readonly commitMessage: string;
  }): Promise<SaveOutcome> {
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
        `echo bytes=$(stat -c %s ${archivePath})`,
        '',
      ].join('\n'),
      { ...this.#gitEnv(), LOTUSBUILD_COMMIT_MESSAGE: input.commitMessage },
    );

    const committed = stdout.includes('committed=yes');
    const bytes = Number(/bytes=(\d+)/.exec(stdout)?.[1]);
    if (!Number.isSafeInteger(bytes) || bytes <= 0) {
      throw new AppError({
        code: 'project/persistence-failed',
        statusCode: 500,
        message: 'The project archive could not be measured, so it was not saved.',
        details: { stdout: stdout.slice(0, 300) },
      });
    }

    const previousBytes = await this.#charge(input.project, input.entitlements, bytes);

    try {
      const url = await this.#snapshots.writeUrl(input.project.id);
      await input.sandbox.writeFile(urlPath, url);
      await this.#run(
        input.sandbox,
        input.provider,
        [
          'set -eu',
          `url=$(cat ${urlPath})`,
          `rm -f ${urlPath}`,
          `curl -sf -X PUT -H "Content-Type: ${snapshotContentType}" --upload-file ${archivePath} "$url"`,
          `rm -f ${archivePath}`,
          '',
        ].join('\n'),
      );
    } catch (error) {
      // The charge was taken for bytes that never arrived. Putting the meter
      // back is the only honest thing to do: the stored snapshot is still the
      // previous one, and its size is what the user is occupying.
      await this.#charge(input.project, input.entitlements, previousBytes).catch(() => undefined);
      throw error;
    }

    return { bytes, committed };
  }

  /**
   * Moves the storage gauge to what this project now occupies, and records the
   * figure on the project in the same transaction. Reading the old size and
   * writing the new one together is what stops the meter and the projects
   * drifting apart.
   */
  async #charge(
    project: Project,
    entitlements: UserEntitlements,
    bytes: number,
  ): Promise<number> {
    const { registry } = await this.#configuration.get();
    const ref = this.#projects.refFor(project.id);

    return this.#firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) {
        throw new AppError({
          code: 'project/not-found',
          statusCode: 404,
          message: 'This project no longer exists, so its work cannot be saved.',
        });
      }
      const previousBytes = countField(snapshot.data() ?? {}, 'snapshotBytes', ref.path);

      await this.#metering.setGaugeIn(transaction, {
        uid: project.ownerUid,
        entitlements,
        meterKey: registry.storageMeterKey,
        previousQuantity: previousBytes,
        quantity: bytes,
        now: new Date(),
      });

      transaction.update(ref, {
        snapshotBytes: bytes,
        snapshotUpdatedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });

      return previousBytes;
    });
  }
}
