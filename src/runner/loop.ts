import type Anthropic from '@anthropic-ai/sdk';

import type { EntitlementService, UserEntitlements } from '../entitlements/service.ts';
import type { ConfigurationStore } from '../entitlements/store.ts';
import { AppError } from '../http/errors.ts';
import type { MeteringService } from '../metering/service.ts';
import type { ProjectPersistence } from '../projects/persistence.ts';
import type { Project, ProjectRepository } from '../projects/repository.ts';
import type { AcquiredSandbox, SandboxService } from '../sandboxes/service.ts';
import type { SessionEvents } from '../sessions/events.ts';
import type { BuildSession, SessionRepository } from '../sessions/repository.ts';
import { type AgentLimits, runAgentTurn } from './agent.ts';

export interface RunnerLogger {
  info(details: object, message: string): void;
  warn(details: object, message: string): void;
  error(details: object, message: string): void;
}

export interface RunnerDependencies {
  readonly runnerId: string;
  readonly anthropic: Anthropic;
  readonly sessions: SessionRepository;
  readonly projects: ProjectRepository;
  readonly entitlements: EntitlementService;
  readonly configuration: ConfigurationStore;
  readonly metering: MeteringService;
  readonly sandboxes: SandboxService;
  readonly persistence: ProjectPersistence;
  readonly events: SessionEvents;
  readonly limits: AgentLimits;
  readonly heartbeatSeconds: number;
  readonly messageHistoryLimit: number;
  readonly log: RunnerLogger;
}

/**
 * The runner's whole contract with the rest of the system: take a session, do
 * the work, put it down. Everything that can go wrong ends with the session put
 * down — a session left RUNNING with nobody working on it is only recoverable
 * when its lease expires, which is a minute the user spends watching nothing.
 */
export class SessionRunner {
  readonly #deps: RunnerDependencies;

  constructor(deps: RunnerDependencies) {
    this.#deps = deps;
  }

  /** Takes one session if there is one. Returns whether there was. */
  async runOnce(): Promise<boolean> {
    const session = await this.#deps.sessions.claim(this.#deps.runnerId);
    if (session === undefined) {
      return false;
    }

    this.#deps.log.info({ sessionId: session.id, uid: session.ownerUid }, 'claimed a session');
    await this.#work(session);
    return true;
  }

  async #work(session: BuildSession): Promise<void> {
    const { sessions, sandboxes, events, log, runnerId } = this.#deps;

    // The lease is renewed on a timer, and losing it is how a runner learns it
    // was declared dead. The flag is read between agent steps rather than
    // thrown from the timer, so the loop unwinds where it can clean up.
    let leaseLost: Error | undefined;
    const heartbeat = setInterval(() => {
      void sessions.heartbeat(session.id, runnerId).catch((error: unknown) => {
        leaseLost = error instanceof Error ? error : new Error(String(error));
        log.warn({ sessionId: session.id, err: leaseLost }, 'lost the lease on this session');
      });
    }, this.#deps.heartbeatSeconds * 1000);

    const publish = async (type: string, data: Record<string, unknown>): Promise<void> => {
      try {
        await events.append(session.id, type, data);
      } catch (error) {
        // The stream is a view of the work, not the work. Losing an event must
        // not fail a build the user is paying for, but it must be visible.
        log.error({ sessionId: session.id, type, err: error }, 'session event was not published');
      }
    };

    let acquired: AcquiredSandbox | undefined;
    // Held outside the try so the failure path can still save the work: an agent
    // that got halfway before dying has built something the user would rather
    // keep than lose.
    let project: Project | undefined;
    let entitlements: UserEntitlements | undefined;
    let persists = false;

    try {
      project = await this.#deps.projects.readOwned(session.ownerUid, session.projectId);
      entitlements = await this.#deps.entitlements.forUser(session.ownerUid);
      persists = entitlements.capabilities.boolean('git.persistence');
      const { registry } = await this.#deps.configuration.get();

      // Whatever the previous holder of this session left behind. Done before
      // anything is reserved, so its concurrency slot is free again in time for
      // this attempt to take one.
      if (session.sandboxId !== undefined || session.reservationIds.length > 0) {
        await sandboxes.recover({
          uid: session.ownerUid,
          platform: project.platform,
          externalSandboxId: session.sandboxId,
          reservationIds: session.reservationIds,
          now: new Date(),
          onProblem: (error, what) => {
            log.warn({ sessionId: session.id, err: error }, `recovery problem: ${what}`);
          },
        });
        await sessions.detachSandbox(session.id, runnerId);
      }

      await publish('session.running', { runnerId, model: session.model, effort: session.effort });

      acquired = await sandboxes.acquire({
        uid: session.ownerUid,
        entitlements,
        platform: project.platform,
        sessionId: session.id,
        now: new Date(),
      });
      // Recorded before the agent touches it: the window that matters is the one
      // where this runner dies with a machine running and holds outstanding.
      await sessions.attachSandbox(session.id, runnerId, {
        sandboxId: acquired.running.externalId,
        reservationIds: acquired.reservations.map((reservation) => reservation.id),
      });
      await publish('sandbox.started', {
        provider: acquired.provider.provider,
        template: acquired.provider.template,
        platform: acquired.provider.platform,
      });

      // Only a plan that pays for it gets its work back. For everyone else the
      // sandbox is genuinely disposable, which is the difference being sold.
      if (persists) {
        const outcome = await this.#deps.persistence.restore(
          acquired.running,
          acquired.provider,
          project,
        );
        await publish('project.restored', { outcome });
      }

      const messages = await sessions.listMessages(
        session.ownerUid,
        session.id,
        this.#deps.messageHistoryLimit,
      );

      const run = await runAgentTurn({
        anthropic: this.#deps.anthropic,
        session,
        project,
        provider: acquired.provider,
        sandbox: acquired.running,
        messages,
        entitlements,
        registry,
        metering: this.#deps.metering,
        limits: this.#deps.limits,
        assertStillOurs: () => {
          if (leaseLost !== undefined) {
            throw leaseLost;
          }
        },
        events: {
          // Text arrives as it is generated. Not awaited: the model does not
          // wait for Redis, and back-pressure here would stall generation.
          text: (delta) => {
            void publish('agent.text', { delta });
          },
          step: (step) => publish('agent.step', step),
          toolCall: (name, toolInput) => publish('agent.tool_call', { name, input: toolInput }),
          toolResult: (name, result) =>
            publish('agent.tool_result', {
              name,
              isError: result.isError,
              // Bounded for the same reason the model's copy is: an event log
              // is read by a browser holding all of it in memory.
              text: result.text.slice(0, this.#deps.limits.toolOutputMaxChars),
            }),
          preview: (preview) => publish('preview.ready', preview),
        },
      });

      if (run.reply !== '') {
        await sessions.appendAssistantMessage(session.id, runnerId, run.reply);
      }
      await publish('agent.finished', { steps: run.steps, stopReason: run.stopReason });

      await this.#save(session, project, entitlements, acquired, persists, publish);
      await this.#letGo(session, acquired);
      acquired = undefined;

      await sessions.finish(session.id, runnerId, { status: 'IDLE' });
      await publish('session.idle', { steps: run.steps, stopReason: run.stopReason });
      log.info({ sessionId: session.id, steps: run.steps }, 'finished a session');
    } catch (error) {
      const reason = this.#reason(error);
      log.error({ sessionId: session.id, err: error }, 'session failed');

      if (acquired !== undefined) {
        // Saved before the machine is discarded, even now: a build that failed
        // at step nine still wrote eight steps of a project the user is paying
        // to keep.
        await this.#save(session, project, entitlements, acquired, persists, publish);
        await this.#letGo(session, acquired);
      }
      await publish('session.failed', { error: reason });

      try {
        await sessions.finish(session.id, runnerId, { status: 'FAILED', error: reason });
      } catch (cause) {
        // Only reachable when the lease is already gone, in which case another
        // runner owns the session and gets to decide its status.
        log.warn({ sessionId: session.id, err: cause }, 'could not mark the session failed');
      }
    } finally {
      clearInterval(heartbeat);
    }
  }

  /**
   * Commits and stores the project, if the plan includes it.
   *
   * A failure here is reported and swallowed rather than thrown. It is reached
   * from the error path as well as the good one, and letting it throw there
   * would replace the real reason a build failed with a second one, while
   * skipping the sandbox release that has to happen either way.
   */
  async #save(
    session: BuildSession,
    project: Project | undefined,
    entitlements: UserEntitlements | undefined,
    acquired: AcquiredSandbox,
    persists: boolean,
    publish: (type: string, data: Record<string, unknown>) => Promise<void>,
  ): Promise<void> {
    if (!persists || project === undefined || entitlements === undefined) {
      return;
    }
    try {
      const saved = await this.#deps.persistence.save({
        sandbox: acquired.running,
        provider: acquired.provider,
        project,
        entitlements,
        // Traceable back to the turn that produced it without putting the
        // user's prompt — which is theirs, and arbitrary text — in a commit.
        commitMessage: `LotusBuild session ${session.id}`,
      });
      await publish('project.saved', { bytes: saved.bytes, committed: saved.committed });
      this.#deps.log.info({ sessionId: session.id, ...saved }, 'saved the project');
    } catch (error) {
      this.#deps.log.error({ sessionId: session.id, err: error }, 'could not save the project');
      await publish('project.save_failed', {
        error: error instanceof AppError ? error.message : 'The project could not be saved.',
      });
    }
  }

  async #letGo(session: BuildSession, acquired: AcquiredSandbox): Promise<void> {
    const { sessions, sandboxes, log, runnerId } = this.#deps;
    await sandboxes.release({
      uid: session.ownerUid,
      acquired,
      now: new Date(),
      onStopFailure: (error) => {
        log.warn({ sessionId: session.id, err: error }, 'could not stop the sandbox');
      },
    });
    try {
      await sessions.detachSandbox(session.id, runnerId);
    } catch (error) {
      log.warn({ sessionId: session.id, err: error }, 'could not clear the sandbox record');
    }
  }

  /**
   * What to tell the user. An `AppError` was written to be read by them — "the
   * Free plan allows 10 builds" — so it is passed through. Anything else is our
   * bug or a provider's, and its text is for the log only.
   */
  #reason(error: unknown): string {
    if (error instanceof AppError) {
      return error.message;
    }
    return 'The build stopped because of an unexpected problem on our side.';
  }
}

/**
 * Claims sessions until told to stop, waiting only when there was nothing to do.
 *
 * No back-off beyond that: the wait is between empty polls, so a busy queue is
 * drained as fast as sessions can be finished.
 */
export async function runUntilStopped(
  runner: SessionRunner,
  options: {
    readonly idlePollSeconds: number;
    readonly shouldContinue: () => boolean;
    readonly log: RunnerLogger;
  },
): Promise<void> {
  while (options.shouldContinue()) {
    let didWork = false;
    try {
      didWork = await runner.runOnce();
    } catch (error) {
      // runOnce contains its own failures, so reaching here means claiming
      // itself failed — Firestore is unreachable. Waiting is the only sensible
      // response; crashing would just have the supervisor do the same, slower.
      options.log.error({ err: error }, 'could not claim a session');
    }
    if (!didWork && options.shouldContinue()) {
      await new Promise((resolve) => setTimeout(resolve, options.idlePollSeconds * 1000));
    }
  }
}
