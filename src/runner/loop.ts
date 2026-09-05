import { createCallAdmission } from './call-admission.ts';
import { assertBuildAllowed } from '../entitlements/build-admission.ts';
import type Anthropic from '@anthropic-ai/sdk';

import type { EntitlementService, UserEntitlements } from '../entitlements/service.ts';
import type { ConfigurationStore } from '../entitlements/store.ts';
import { AppError } from '../http/errors.ts';
import type { MeteringService } from '../metering/service.ts';
import type { ProjectPersistence, RestoreOutcome } from '../projects/persistence.ts';
import type { Project, ProjectRepository } from '../projects/repository.ts';
import type { AcquiredSandbox, SandboxService } from '../sandboxes/service.ts';
import type { SessionEvents } from '../sessions/events.ts';
import type {
  ClaimedSession,
  SessionLease,
  SessionRepository,
} from '../sessions/repository.ts';
import {
  type AgentLimits,
  type AgentRun,
  type ProblemReporter,
  blockerExplanation,
  runAgentTurn,
} from './agent.ts';

/**
 * Gives back specialist token holds a dead runner left open.
 *
 * `release` returns false for a hold that already reached a terminal outcome,
 * which is exactly the case a successor cannot distinguish on its own — so
 * running this against an already-settled hold is a no-op rather than a second
 * accounting event. A hold is only forgotten once it is reconciled: one that
 * cannot be released stays recorded, because a ledger that disagrees with
 * itself is something to look at, not something to quietly drop.
 */
export async function reconcileSpecialistReservations(input: {
  readonly uid: string;
  readonly reservationIds: readonly string[];
  readonly release: (uid: string, reservationId: string, now: Date) => Promise<boolean>;
  readonly forget: (reservationId: string) => Promise<void>;
  readonly onProblem: ProblemReporter;
  readonly now: Date;
}): Promise<void> {
  for (const reservationId of input.reservationIds) {
    try {
      await input.release(input.uid, reservationId, input.now);
    } catch (cause) {
      input.onProblem(
        cause instanceof Error ? cause : new Error(String(cause)),
        `releasing abandoned specialist reservation ${reservationId}`,
      );
      continue;
    }
    try {
      await input.forget(reservationId);
    } catch (cause) {
      // Reconciled but still listed. Harmless: the next attempt releases a
      // closed hold, which does nothing.
      input.onProblem(
        cause instanceof Error ? cause : new Error(String(cause)),
        `clearing reconciled specialist reservation ${reservationId}`,
      );
    }
  }
}

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

  async #work(session: ClaimedSession): Promise<void> {
    const { sessions, sandboxes, events, log, runnerId } = this.#deps;
    const authority: SessionLease = {
      sessionId: session.id,
      runnerId,
      token: session.leaseToken,
    };

    // The lease is renewed on a timer, and losing it is how a runner learns it
    // was declared dead. The flag is read between agent steps rather than
    // thrown from the timer, so the loop unwinds where it can clean up.
    let leaseLost: Error | undefined;
    // Stops in-flight model streams rather than waiting for the next step
    // boundary to notice. It never replaces the lease checks: ownership is
    // decided by Firestore, and this only stops us paying for work we have
    // already lost the right to do.
    const cancellation = new AbortController();
    const stopWork = (reason: Error): void => {
      leaseLost = reason;
      cancellation.abort(reason);
    };
    const heartbeat = setInterval(() => {
      void sessions.heartbeat(session.id, authority).catch((error: unknown) => {
        stopWork(error instanceof Error ? error : new Error(String(error)));
        log.warn({ sessionId: session.id, err: leaseLost }, 'lost the lease on this session');
      });
    }, this.#deps.heartbeatSeconds * 1000);

    let unsubscribeCancel: (() => void) | undefined;
    // The latest steer prompt queued by the user. Replaced atomically so
    // the agent always sees the most recent instruction mid-turn.
    let pendingSteer: string | undefined;

    try {
      unsubscribeCancel = await events.subscribe(session.id, (event) => {
        if (event.type === 'session.cancel_requested') {
          stopWork(
            new AppError({
              code: 'session/cancelled',
              statusCode: 409,
              message: 'Cancelled by user',
              details: { sessionId: session.id },
            }),
          );
          log.info({ sessionId: session.id }, 'received cancellation request for session');
        } else if (event.type === 'session.steer') {
          const prompt = (event.data as Record<string, unknown>)['prompt'];
          if (typeof prompt === 'string' && prompt.length > 0) {
            pendingSteer = prompt;
            log.info({ sessionId: session.id }, 'received steer prompt for session');
          }
        }
      });
    } catch (err) {
      log.warn({ sessionId: session.id, err }, 'could not subscribe to session events');
    }

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
    let saveAttempted = false;
    // Proof that this sandbox holds the project's history rather than an empty
    // directory. Saving without it would publish a fresh repository over a
    // snapshot the user still owns — which is exactly what a failed restore
    // leaves behind, and what a failure before restore never had.
    let restored: RestoreOutcome | undefined;

    try {
      project = await this.#deps.projects.readOwned(session.ownerUid, session.projectId);
      entitlements = await this.#deps.entitlements.forUser(session.ownerUid, new Date(), true);
      assertBuildAllowed(entitlements, project.platform, session.model);
      // Narrowed once here: the reservation closures below run later, so a
      // possibly-undefined outer binding would not be narrowed inside them.
      const tokenReservations = {
        take: async (hold: { meterKey: string; quantity: number; operationId: string }) =>
          sessions.reserveSpecialistTokens(session.id, runnerId, {
            ...hold, leaseToken: authority.token,
            entitlements: await this.#deps.entitlements.forUser(session.ownerUid, new Date(), true),
            now: new Date(),
          }),
        forget: (id: string) => sessions.forgetSpecialistReservation(session.id, authority, id),
      };
      persists = entitlements.capabilities.boolean('git.persistence');
      const { registry } = await this.#deps.configuration.get();
      const admission = createCallAdmission({
        anthropic: this.#deps.anthropic, uid: session.ownerUid, sessionId: session.id,
        inputMeterKey: registry.inputTokenMeterKey, outputMeterKey: registry.outputTokenMeterKey,
        metering: this.#deps.metering, reservations: tokenReservations,
        authorize: async () => {
          await sessions.assertPersistenceLease(authority);
          const latest = await this.#deps.entitlements.forUser(session.ownerUid, new Date(), true);
          assertBuildAllowed(latest, project!.platform, session.model);
        },
        onProblem: (error, what) => log.error({ sessionId: session.id, err: error }, what),
      });

      const abandoned = [...new Set([...session.reservationIds, ...session.specialistReservationIds])];
      if (session.sandboxId !== undefined || abandoned.length > 0) {
        await sandboxes.recover({ uid: session.ownerUid, platform: project.platform,
          externalSandboxId: session.sandboxId, reservationIds: abandoned, now: new Date(),
          onProblem: (error, what) => log.warn({ sessionId: session.id, err: error }, what),
        });
        for (const id of session.specialistReservationIds) await sessions.forgetSpecialistReservation(session.id, authority, id);
        await sessions.detachSandbox(session.id, authority);
      }

      await publish('session.running', { runnerId, model: session.model, effort: session.effort });

      acquired = await sandboxes.acquire({
        publicPreviewEnabled: project.publicPreviewEnabled === true,
        uid: session.ownerUid,
        entitlements,
        platform: project.platform,
        sessionId: session.id,
        now: new Date(),
        reservations: tokenReservations,
      });
      // Recorded before the agent touches it: the window that matters is the one
      // where this runner dies with a machine running and holds outstanding.
      await sessions.attachSandbox(session.id, authority, {
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
        restored = await this.#deps.persistence.restore(
          acquired.running,
          acquired.provider,
          project,
        );
        await publish('project.restored', { outcome: restored });
      }

      const messages = await sessions.listMessages(
        session.ownerUid,
        session.id,
        this.#deps.messageHistoryLimit,
      );

      const withValidationSandbox: NonNullable<import('./tools.ts').ToolContext['withValidationSandbox']> = async (run) => {
        await sessions.assertPersistenceLease(authority);
        cancellation.signal.throwIfAborted();
        if (acquired === undefined) throw new Error('The primary sandbox is unavailable.');
        const copy = await sandboxes.acquire({ uid: session.ownerUid, sessionId: session.id,
          platform: project!.platform, entitlements: await this.#deps.entitlements.forUser(session.ownerUid, new Date(), true),
          now: new Date(), reservations: tokenReservations, source: acquired.running });
        let outcome;
        let failure: unknown;
        try { outcome = await run(copy.running); } catch (cause) { failure = cause; }
        try {
          await sandboxes.release({ uid: session.ownerUid, acquired: copy, now: new Date(),
            onStopFailure: (error) => log.error({ err: error, sessionId: session.id }, 'validation disposal failed') });
          for (const hold of copy.reservations) await tokenReservations.forget(hold.id);
        } catch (cleanup) {
          if (failure !== undefined) throw new AggregateError([failure, cleanup], 'Validation and sandbox disposal failed.');
          throw cleanup;
        }
        if (failure !== undefined) throw failure;
        if (outcome === undefined) throw new Error('Validation returned no result.');
        return outcome;
      };
      const run = await runAgentTurn({
          withValidationSandbox,
          admission,
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
        drainSteer: () => {
          const prompt = pendingSteer;
          pendingSteer = undefined;
          return prompt;
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
          specialistStarted: (detail) =>
            publish('agent.specialist_started', { role: detail.role, label: detail.label }),
          // Verdict, count and the one-line conclusion. Never the instructions,
          // the transcript, or how the specialist reached the answer.
          specialistCompleted: (detail) =>
            publish('agent.specialist_completed', {
              role: detail.role,
              label: detail.label,
              verdict: detail.verdict,
              findings: detail.findings,
              summary: detail.summary,
            }),
        },
        signal: cancellation.signal,
        reservations: tokenReservations,
        onProblem: (error, what) => {
          log.error({ sessionId: session.id, err: error }, what);
        },
      });

      await this.#deliver(session, run, publish);

      // Hot turn chaining: check the queue before releasing the sandbox.
      // If the user enqueued a follow-up while this turn was running, dequeue
      // it and run the next turn in the same live sandbox without cold-booting.
      let nextQueued = await sessions.dequeueNextMessage(session.id, authority);
      while (nextQueued !== undefined) {
        await publish('session.queued', { queuedMessageId: nextQueued.id });
        log.info(
          { sessionId: session.id, queuedMessageId: nextQueued.id },
          'hot-chaining queued message in existing sandbox',
        );

        const chainMessages = await sessions.listMessages(
          session.ownerUid,
          session.id,
          this.#deps.messageHistoryLimit,
        );

        const chainRun = await runAgentTurn({
          withValidationSandbox,
          admission,
          anthropic: this.#deps.anthropic,
          session,
          project,
          provider: acquired.provider,
          sandbox: acquired.running,
          messages: chainMessages,
          entitlements,
          registry,
          metering: this.#deps.metering,
          limits: this.#deps.limits,
          assertStillOurs: () => {
            if (leaseLost !== undefined) {
              throw leaseLost;
            }
          },
          drainSteer: () => {
            const prompt = pendingSteer;
            pendingSteer = undefined;
            return prompt;
          },
          events: {
            text: (delta) => {
              void publish('agent.text', { delta });
            },
            step: (step) => publish('agent.step', step),
            toolCall: (name, toolInput) => publish('agent.tool_call', { name, input: toolInput }),
            toolResult: (name, result) =>
              publish('agent.tool_result', {
                name,
                isError: result.isError,
                text: result.text.slice(0, this.#deps.limits.toolOutputMaxChars),
              }),
            preview: (preview) => publish('preview.ready', preview),
            specialistStarted: (detail) =>
              publish('agent.specialist_started', { role: detail.role, label: detail.label }),
            // Verdict, count and the one-line conclusion. Never the instructions,
            // the transcript, or how the specialist reached the answer.
            specialistCompleted: (detail) =>
              publish('agent.specialist_completed', {
                role: detail.role,
                label: detail.label,
                verdict: detail.verdict,
                findings: detail.findings,
                summary: detail.summary,
              }),
          },
          signal: cancellation.signal,
          reservations: tokenReservations,
        onProblem: (error, what) => {
            log.error({ sessionId: session.id, err: error }, what);
          },
        });

        await this.#deliver(session, chainRun, publish);

        nextQueued = await sessions.dequeueNextMessage(session.id, authority);
      }

      saveAttempted = true;
      await this.#save(
        session,
        authority,
        project,
        entitlements,
        acquired,
        persists,
        restored,
        publish,
      );
      await this.#letGo(session, acquired);
      acquired = undefined;

      await sessions.finish(session.id, authority, { status: 'IDLE' });
      await publish('session.idle', { steps: run.steps, stopReason: run.stopReason });
      log.info({ sessionId: session.id, steps: run.steps }, 'finished a session');
    } catch (error) {
      const reason = this.#reason(error);
      log.error({ sessionId: session.id, err: error }, 'session failed');

      if (acquired !== undefined) {
        // Saved before the machine is discarded, even now: a build that failed
        // at step nine still wrote eight steps of a project the user is paying
        // to keep.
        if (!saveAttempted) {
          saveAttempted = true;
          try {
            await this.#save(
              session,
              authority,
              project,
              entitlements,
              acquired,
              persists,
              restored,
              publish,
            );
          } catch (saveError) {
            log.error(
              { sessionId: session.id, err: saveError },
              'could not preserve partial project work',
            );
          }
        }
        await this.#letGo(session, acquired);
      }
      await publish('session.failed', { error: reason });

      try {
        await sessions.finish(session.id, authority, { status: 'FAILED', error: reason });
      } catch (cause) {
        // Only reachable when the lease is already gone, in which case another
        // runner owns the session and gets to decide its status.
        log.warn({ sessionId: session.id, err: cause }, 'could not mark the session failed');
      }
    } finally {
      clearInterval(heartbeat);
      unsubscribeCancel?.();
      // Nothing should still be streaming by now; this is the backstop for a
      // path that left one running.
      cancellation.abort();
    }
  }

  /**
   * Puts the turn's answer in the transcript and says how it ended.
   *
   * A turn that ended with a blocking review still standing has its explanation
   * appended here rather than left to the model's own account of what it did.
   * The session still finishes IDLE and stays resumable: refusing to do
   * something unsafe is a decision, not a system failure.
   */
  async #deliver(
    session: ClaimedSession,
    run: AgentRun,
    publish: (type: string, data: Record<string, unknown>) => Promise<void>,
  ): Promise<void> {
    const blocked = run.unresolvedBlockers.length > 0;
    const reply = blocked
      ? [run.reply, blockerExplanation(run.unresolvedBlockers)]
          .filter((part) => part !== '')
          .join('\n\n')
      : run.reply;

    if (reply !== '') {
      await this.#deps.sessions.appendAssistantMessage(session.id, { sessionId: session.id, runnerId: this.#deps.runnerId, token: session.leaseToken }, reply);
    }
    if (blocked) {
      await publish('agent.blocked', {
        blockers: run.unresolvedBlockers.map((blocker) => ({
          id: blocker.id,
          role: blocker.role,
          label: blocker.label,
          summary: blocker.summary,
        })),
      });
    }
    await publish('agent.finished', { steps: run.steps, stopReason: run.stopReason });
  }

  /**
   * Commits and stores the project, if the plan includes it.
   *
   * A success-path failure propagates so a build is not reported idle without
   * durable persistence. The caller catches a partial-save failure only while
   * already handling another failure, preserving the original reason while
   * still releasing the sandbox and finalising the session.
   *
   * `restored` is required rather than assumed: the failure path runs after any
   * failure, including one that stopped the restore, and a sandbox whose history
   * never arrived must not be published over the snapshot that still holds it.
   */
  async #save(
    session: ClaimedSession,
    authority: SessionLease,
    project: Project | undefined,
    entitlements: UserEntitlements | undefined,
    acquired: AcquiredSandbox,
    persists: boolean,
    restored: RestoreOutcome | undefined,
    publish: (type: string, data: Record<string, unknown>) => Promise<void>,
  ): Promise<void> {
    if (!persists || project === undefined || entitlements === undefined) {
      return;
    }
    if (restored === undefined) {
      this.#deps.log.warn(
        { sessionId: session.id, projectId: project.id },
        'not saving a workspace whose project history was never restored',
      );
      return;
    }
    try {
      const saved = await this.#deps.persistence.save({
        sandbox: acquired.running,
        provider: acquired.provider,
        project,
        entitlements,
        authority,
        // Traceable back to the turn that produced it without putting the
        // user's prompt — which is theirs, and arbitrary text — in a commit.
        commitMessage: `LotusBuild session ${session.id}`,
      });
      await publish('project.saved', { bytes: saved.bytes, committed: saved.committed });
      this.#deps.log.info(
        { sessionId: session.id, bytes: saved.bytes, committed: saved.committed },
        'saved the project',
      );
      if (saved.cleanupFailure !== undefined) {
        // Logged, not published: the save the user asked for succeeded, and an
        // orphaned object in our bucket is ours to collect, not theirs to read
        // about. The object name is the address an operator needs to find it,
        // and this log never leaves the server.
        const { superseded, cause } = saved.cleanupFailure;
        this.#deps.log.error(
          {
            sessionId: session.id,
            projectId: project.id,
            snapshot: superseded,
            err: cause,
          },
          'project saved, but its superseded snapshot could not be deleted',
        );
      }
    } catch (error) {
      this.#deps.log.error({ sessionId: session.id, err: error }, 'could not save the project');
      await publish('project.save_failed', {
        error: error instanceof AppError ? error.message : 'The project could not be saved.',
      });
      throw error;
    }
  }

  async #letGo(session: ClaimedSession, acquired: AcquiredSandbox): Promise<void> {
    const { sessions, sandboxes, log, runnerId } = this.#deps;
    const authority = { sessionId: session.id, runnerId, token: session.leaseToken };
    await sandboxes.release({
      uid: session.ownerUid,
      acquired,
      now: new Date(),
      onStopFailure: (error) => {
        log.warn({ sessionId: session.id, err: error }, 'could not stop the sandbox');
      },
    });
    try {
      await sessions.detachSandbox(session.id, authority);
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
    readonly maintenance?: () => Promise<void>;
  },
): Promise<void> {
  while (options.shouldContinue()) {
    let didWork = false;
    if (options.maintenance !== undefined) {
      try { await options.maintenance(); }
      catch (error) { options.log.error({ err: error }, 'snapshot cleanup remains pending'); }
    }
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
