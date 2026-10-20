import { createCallAdmission } from './call-admission.ts';
import type { AttachmentReader } from '../attachments/store.ts';
import type { ModelResolver } from '../models/catalog.ts';
import { readOnlyTools, workspaceTools } from './tools.ts';
import { assertBuildAllowed, resolveAiEffort } from '../entitlements/build-admission.ts';
import type Anthropic from '@anthropic-ai/sdk';

import type { EntitlementService, UserEntitlements } from '../entitlements/service.ts';
import type { ConfigurationStore } from '../entitlements/store.ts';
import type { DesktopHandoff, DesktopHandoffPort } from '../desktop/handoff.ts';
import { AppError, safeErrorDiagnostic } from '../http/errors.ts';
import type { MeteringService } from '../metering/service.ts';
import type { ProjectPersistence, RestoreOutcome } from '../projects/persistence.ts';
import type { Project, ProjectRepository } from '../projects/repository.ts';
import type { AcquiredSandbox, SandboxService } from '../sandboxes/service.ts';
import type { SessionEvents } from '../sessions/events.ts';
import type {
  ClaimedSession,
  SessionLease,
  SessionRepository, SessionMessage, BuildSession } from '../sessions/repository.ts';
import {
  type AgentLimits,
  type AgentRun,
  type ProblemReporter,
  blockerExplanation,
  runAgentTurn, imageBlock, type ConversationMessage, type SteerInput } from './agent.ts';

/** Safe primary/secondary categories; never retain raw provider payloads or stderr. */
export class RunnerWorkError extends AggregateError {
  readonly primaryCategory: string;
  readonly secondaryStage: string;
  constructor(primary: unknown, secondary: string) {
    const kind = primary instanceof AppError && ['session/cancelled', 'session/lease-lost'].includes(primary.code)
      ? primary.code : primary instanceof Error && primary.message === 'Runner shutdown requested.' ? 'runner/shutdown' : 'runner/execution-failed';
    super([new Error(kind), new Error(secondary)], 'Runner work or recovery remains incomplete.');
    this.name = 'RunnerWorkError';
    this.primaryCategory = kind;
    this.secondaryStage = secondary;
  }
}
function persistenceRevoked(error: unknown): boolean {
  return error instanceof AppError && ['account/erasure-pending', 'project/deleting', 'project/not-found'].includes(error.code);
}

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
  readonly models: ModelResolver;
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
  /** Loads the images a prompt referenced, so the model sees what the user attached. */
  readonly attachments: AttachmentReader;
  readonly log: RunnerLogger;
  /**
   * Where a running desktop is announced to the API's relay. Needed only for a
   * provider whose registry row configures a desktop; a build on one without it
   * fails to show its desktop, loudly, rather than silently skipping it.
   */
  readonly desktop?: DesktopHandoffPort;
  readonly desktopStartTimeoutMs?: number;
  /** Longest the first turn is held back waiting for the desktop; see DEFAULT_DESKTOP_START_GRACE_MS. */
  readonly desktopStartGraceMs?: number;
}

/** Why a desktop stopped being available. Mirrors what the frontend is told. */
type DesktopEndReason = 'session-ended' | 'sandbox-stopped' | 'error';
const DEFAULT_DESKTOP_START_TIMEOUT_MS = 45_000;
/**
 * How long the first agent turn waits for the desktop before starting without it.
 * The desktop keeps starting in the background and is shown to the user when it
 * is up; later turns in the same sandbox see it. The agent is only told about a
 * screen that is already there.
 */
const DEFAULT_DESKTOP_START_GRACE_MS = 8_000;

function settleWithin<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve(fallback); });
  });
}

/**
 * The runner's whole contract with the rest of the system: take a session, do
 * the work, put it down. Everything that can go wrong ends with the session put
 * down — a session left RUNNING with nobody working on it is only recoverable
 * when its lease expires, which is a minute the user spends watching nothing.
 */
export class SessionRunner {
  readonly #deps: RunnerDependencies;
  /** Sessions whose desktop this process announced and has not yet ended. */
  readonly #desktops = new Set<string>();

  constructor(deps: RunnerDependencies) {
    this.#deps = deps;
  }

  /** A message's images, loaded for the model; a missing upload fails the turn rather than silently dropping a picture. */
  async #withImages(ownerUid: string, messages: readonly SessionMessage[]): Promise<readonly ConversationMessage[]> {
    return Promise.all(messages.map(async (message) => {
      if (message.attachments.length === 0) return message;
      const images = await Promise.all(message.attachments.map(async (ref) => {
        const content = await this.#deps.attachments.read(ownerUid, ref.id);
        return imageBlock(content.mediaType, content.data);
      }));
      return { ...message, images };
    }));
  }

  async #drainSteer(session: BuildSession, authority: SessionLease): Promise<SteerInput | undefined> {
    const steer = await this.#deps.sessions.drainSteerMessage(session.id, authority);
    if (steer === undefined) return undefined;
    const images = await Promise.all(steer.attachments.map(async (ref) => {
      const content = await this.#deps.attachments.read(session.ownerUid, ref.id);
      return imageBlock(content.mediaType, content.data);
    }));
    return { text: steer.prompt, images };
  }

  /**
   * Shows the user this build's desktop, when its provider has one.
   *
   * Best effort by design: a build that cannot show its desktop still builds,
   * and the user is told the desktop is unavailable. Cancellation and shutdown
   * are the exception and are always rethrown, so a stopping session stops.
   *
   * Returns whether the desktop is up and shown, which is what tells the agent
   * whether it has a screen: an agent must not be told about one that is not there.
   */
  async #startDesktop(
    session: ClaimedSession,
    acquired: AcquiredSandbox,
    publish: (type: string, data: Record<string, unknown>) => Promise<void>,
    signal: AbortSignal,
    desktopAbort: AbortSignal,
  ): Promise<boolean> {
    const settings = acquired.provider.desktop;
    if (settings === undefined) return false;
    try {
      const handoff = this.#deps.desktop;
      if (handoff === undefined) throw new Error('The runner has no desktop handoff configured.');
      if (acquired.running.startDesktop === undefined) throw new Error('This sandbox provider cannot show a desktop.');
      const startupSignal = AbortSignal.any([
        signal,
        desktopAbort,
        AbortSignal.timeout(this.#deps.desktopStartTimeoutMs ?? DEFAULT_DESKTOP_START_TIMEOUT_MS),
      ]);
      const startAndPublish = async (): Promise<DesktopHandoff> => {
        const endpoint = await acquired.running.startDesktop!(settings, startupSignal);
        startupSignal.throwIfAborted();
        await handoff.publish(session.id, endpoint, acquired.provider.timeoutSeconds + 60);
        if (startupSignal.aborted) {
          try { await handoff.clear(session.id); }
          catch { /* The handoff expires with the sandbox. */ }
          startupSignal.throwIfAborted();
        }
        return endpoint;
      };
      let onAbort: (() => void) | undefined;
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(startupSignal.reason ?? new Error('Desktop startup was aborted.'));
        if (startupSignal.aborted) onAbort();
        else startupSignal.addEventListener('abort', onAbort, { once: true });
      });
      try {
        await Promise.race([startAndPublish(), aborted]);
        this.#desktops.add(session.id);
        await publish('desktop.ready', { width: settings.width, height: settings.height });
        return true;
      } finally {
        if (onAbort !== undefined) startupSignal.removeEventListener('abort', onAbort);
      }
    } catch (error) {
      signal.throwIfAborted();
      desktopAbort.throwIfAborted();
      this.#deps.log.error(
        { sessionId: session.id, diagnostic: safeErrorDiagnostic(error) },
        'could not start the desktop; continuing without it',
      );
      await publish('desktop.ended', { reason: 'error' satisfies DesktopEndReason });
      return false;
    }
  }

  /**
   * The desktop is going away: withdraw it from the relay and tell the user.
   * Never throws. Failing to withdraw is bounded by the handoff's own expiry,
   * and must not turn releasing a sandbox into a failure.
   */
  async #endDesktop(sessionId: string, reason: DesktopEndReason, alsoUnannounced = false): Promise<void> {
    const handoff = this.#deps.desktop;
    // A build with no desktop never touches Redis. Only a successor to a dead
    // runner has to look for an entry it did not write itself.
    if (handoff === undefined || (!alsoUnannounced && !this.#desktops.has(sessionId))) return;
    try {
      const existed = await handoff.clear(sessionId);
      const announced = this.#desktops.delete(sessionId);
      if (existed || announced) await this.#deps.events.append(sessionId, 'desktop.ended', { reason });
    } catch (error) {
      this.#deps.log.warn({ sessionId, diagnostic: safeErrorDiagnostic(error) }, 'could not withdraw the desktop');
    }
  }

  /** Takes one session if there is one. Returns whether there was. */
  async runOnce(shutdown?: AbortSignal): Promise<boolean> {
    if (shutdown?.aborted) return false;
    const session = await this.#deps.sessions.claim(this.#deps.runnerId, new Date(), shutdown);
    if (session === undefined) {
      return false;
    }

    this.#deps.log.info({ sessionId: session.id, uid: session.ownerUid }, 'claimed a session');
    try { await this.#work(session, shutdown); }
    catch (error) { throw error instanceof RunnerWorkError ? error : new RunnerWorkError(error, 'runner/work-failed'); }
    return true;
  }

  async #work(session: ClaimedSession, shutdown?: AbortSignal): Promise<void> {
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
    const signal = shutdown === undefined ? cancellation.signal : AbortSignal.any([cancellation.signal, shutdown]);
    const stopWork = (reason: Error): void => {
      leaseLost = reason;
      cancellation.abort(reason);
    };
    const heartbeat = setInterval(() => {
      void sessions.heartbeat(session.id, authority, new Date(), cancellation.signal.aborted).catch((error: unknown) => {
        stopWork(error instanceof Error ? error : new Error(String(error)));
        log.warn({ sessionId: session.id, diagnostic: safeErrorDiagnostic(leaseLost) }, 'lost the lease on this session');
      });
    }, this.#deps.heartbeatSeconds * 1000);

    let unsubscribeCancel: (() => void) | undefined;
    // Cancellation has an immediate Redis notification as well as durable state.
    // Steering is consumed from Firestore before each model step.

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
        }
      });
    } catch (err) {
      log.warn({ sessionId: session.id, diagnostic: safeErrorDiagnostic(err) }, 'could not subscribe to session events');
    }

    const publish = async (type: string, data: Record<string, unknown>): Promise<void> => {
      try {
        await events.append(session.id, type, data);
      } catch (error) {
        // The stream is a view of the work, not the work. Losing an event must
        // not fail a build the user is paying for, but it must be visible.
        log.error({ sessionId: session.id, type, diagnostic: safeErrorDiagnostic(error) }, 'session event was not published');
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
    let turnCompleted = false;
    let saveCompleted = false;
    let workspaceMayBeDirty = false;
    // Proof that this sandbox holds the project's history rather than an empty
    // directory. Saving without it would publish a fresh repository over a
    // snapshot the user still owns — which is exactly what a failed restore
    // leaves behind, and what a failure before restore never had.
    let restored: RestoreOutcome | undefined;
    let desktopAbort: AbortController | undefined;
    let desktopStart: Promise<boolean> | undefined;
    // A desktop still starting when the session is over is withdrawn, never
    // announced: the user must not be shown a screen for work that has ended.
    const settleDesktop = async (): Promise<void> => {
      if (desktopStart === undefined) return;
      desktopAbort?.abort(new Error('The session finished before the desktop started.'));
      await desktopStart.catch(() => {});
    };

    try {
      signal.throwIfAborted();
      project = await this.#deps.projects.readOwned(session.ownerUid, session.projectId);
      let recovery = session.workspaceRecovery;
      if (recovery?.status === 'REQUIRED') {
        try { await sessions.assertPersistenceLease(authority, true); }
        catch (error) {
          if (!persistenceRevoked(error)) throw new RunnerWorkError(error, 'workspace/salvage-authorization-failed');
          await sessions.markWorkspaceUnrecoverable(authority, 'persistence-revoked');
          recovery = await sessions.workspaceRecoveryState(authority);
        }
      }
      if (recovery?.status !== 'UNRECOVERABLE') {
        entitlements = await this.#deps.entitlements.forUser(session.ownerUid, new Date(), true);
        persists = entitlements.capabilities.boolean('git.persistence');
      }
      if (recovery?.status === 'REQUIRED') {
        try {
          if (!persists) await sessions.markWorkspaceUnrecoverable(authority, 'persistence-revoked');
          else if (!session.sandboxId || recovery.sandboxId !== session.sandboxId || !/^[a-zA-Z0-9_-]+$/.test(recovery.sandboxId)) {
            await sessions.markWorkspaceUnrecoverable(authority, 'invalid-attachment');
          } else {
            const preserved = await sandboxes.reconnectForSalvage(project.platform, recovery.sandboxId);
            if (preserved === undefined) await sessions.markWorkspaceUnrecoverable(authority, 'sandbox-absent');
            else {
              if (preserved.stopCommands === undefined) throw new Error('Workspace quiescence is unsupported.');
              await preserved.stopCommands();
              await this.#deps.persistence.save({ sandbox: preserved, provider: await sandboxes.providerFor(project.platform),
                project, entitlements: entitlements!, authority, cleanup: true, commitMessage: `LotusBuild recovery ${session.id}` });
            }
          }
          recovery = await sessions.workspaceRecoveryState(authority);
          if (recovery?.status === 'REQUIRED') throw new Error('Salvage publication was not confirmed.');
        } catch (error) { throw new RunnerWorkError(error, 'workspace/salvage-failed'); }
      }
      const abandoned = [...new Set([...session.reservationIds, ...session.specialistReservationIds])];
      if (session.sandboxId !== undefined || abandoned.length > 0) {
        // A runner that died with a desktop up cannot have withdrawn it.
        await this.#endDesktop(session.id, 'sandbox-stopped', true);
        try {
          await sandboxes.recover({ uid: session.ownerUid, platform: project.platform,
            externalSandboxId: session.sandboxId, reservationIds: abandoned, now: new Date(),
            salvageRequired: recovery !== undefined && !['COMPLETED', 'UNRECOVERABLE'].includes(recovery.status),
            onProblem: () => log.warn({ sessionId: session.id }, 'resource or usage recovery remains pending'),
          });
          for (const id of session.specialistReservationIds) await sessions.forgetSpecialistReservation(session.id, authority, id);
          await sessions.detachSandbox(session.id, authority);
        } catch (error) {
          if (recovery?.status !== 'UNRECOVERABLE') throw new RunnerWorkError(error, 'sandbox/recovery-failed');
          try { await sessions.finishUnrecoverable(authority); }
          catch { throw new RunnerWorkError(error, 'workspace/terminalization-failed'); }
          log.warn({ sessionId: session.id }, 'unrecoverable execution ended; accounting references retained for reconciliation');
          await publish('session.failed', { error: 'The latest unsaved workspace changes could not be recovered.' });
          return;
        }
      }
      if (recovery?.status === 'UNRECOVERABLE') {
        throw new AppError({ code: 'workspace/unrecoverable', statusCode: 409, message: 'Workspace recovery is unrecoverable: ' + recovery.reason });
      }
      // Salvage and cleanup are allowed on a cancelled session, new execution is not.
      if (session.cancelRequested === true) throw new AppError({ code: 'session/cancelled', statusCode: 409, message: 'Cancelled by user' });
      if (entitlements === undefined) throw new Error('Build entitlements are unavailable.');
      if (session.workspaceRecovery !== undefined) project = await this.#deps.projects.readOwned(session.ownerUid, session.projectId);
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
        models: this.#deps.models,
        anthropic: this.#deps.anthropic, uid: session.ownerUid, sessionId: session.id,
        inputMeterKey: registry.inputTokenMeterKey, outputMeterKey: registry.outputTokenMeterKey,
        metering: this.#deps.metering, reservations: tokenReservations,
        authorize: async () => {
          await sessions.assertPersistenceLease(authority);
          const latest = await this.#deps.entitlements.forUser(session.ownerUid, new Date(), true);
          assertBuildAllowed(latest, project!.platform, session.model);
          if ((await this.#deps.models.get(session.model)).efforts.length > 0) resolveAiEffort(latest, session.effort);
        },
        onProblem: (error) => log.error({ sessionId: session.id, diagnostic: safeErrorDiagnostic(error) }, 'model admission reconciliation failed'),
      });

      signal.throwIfAborted();
      if (session.queuedTurnPending === true && !await sessions.startPendingTurn(session.id, authority, signal)) {
        const status = await sessions.finish(session.id, authority, { status: 'IDLE' });
        await publish(status === 'QUEUED' ? 'session.queued' : 'session.idle', {});
        return;
      }

      await publish('session.running', {
        runnerId,
        model: session.model,
        effort: session.effort,
        mode: session.mode,
      });

      signal.throwIfAborted();
      acquired = await sandboxes.acquire({
        publicPreviewEnabled: project.publicPreviewEnabled === true,
        uid: session.ownerUid,
        entitlements,
        platform: project.platform,
        sessionId: session.id,
        now: new Date(),
        reservations: tokenReservations,
        signal,
      });
      // Recorded before the agent touches it: the window that matters is the one
      // where this runner dies with a machine running and holds outstanding.
      await sessions.attachSandbox(session.id, authority, {
        sandboxId: acquired.running.externalId,
        reservationIds: acquired.reservations.map((reservation) => reservation.id),
      });
      signal.throwIfAborted();
      await publish('sandbox.started', {
        provider: acquired.provider.provider,
        template: acquired.provider.template,
        platform: acquired.provider.platform,
      });
      desktopAbort = new AbortController();
      desktopStart = this.#startDesktop(session, acquired, publish, signal, desktopAbort.signal);
      void desktopStart.catch(() => {});

      let messages: readonly ConversationMessage[];
      try {
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

        messages = await this.#withImages(session.ownerUid, await sessions.listMessages(
          session.ownerUid,
          session.id,
          this.#deps.messageHistoryLimit,
        ));
      } catch (error) {
        desktopAbort.abort(error);
        await desktopStart.catch(() => {});
        throw error;
      }
      let desktopUp = false;
      void desktopStart.then((ready) => { desktopUp = ready; }, () => {});
      const desktopReady = await settleWithin(
        desktopStart,
        this.#deps.desktopStartGraceMs ?? DEFAULT_DESKTOP_START_GRACE_MS,
        false,
      );
      const toolCall = async (name: string, input: Record<string, unknown>, callId?: string) => {
        if (persists && workspaceTools.has(name) && !readOnlyTools.has(name)) {
          await sessions.requireWorkspaceSalvage(authority, acquired!.running.externalId);
          workspaceMayBeDirty = true;
        }
        await publish('agent.tool_call', { name, input, ...(callId === undefined ? {} : {callId}) });
      };

      const withValidationSandbox: NonNullable<import('./tools.ts').ToolContext['withValidationSandbox']> = async (run) => {
        await sessions.assertPersistenceLease(authority);
        signal.throwIfAborted();
        if (acquired === undefined) throw new Error('The primary sandbox is unavailable.');
        const copy = await sandboxes.acquire({ uid: session.ownerUid, sessionId: session.id,
          platform: project!.platform, entitlements: await this.#deps.entitlements.forUser(session.ownerUid, new Date(), true),
          now: new Date(), reservations: tokenReservations, source: acquired.running, signal });
        let outcome;
        let failure: unknown;
        try { outcome = await run(copy.running); } catch (cause) { failure = cause; }
        try {
          await sandboxes.release({ uid: session.ownerUid, acquired: copy, now: new Date(),
            onStopFailure: (error) => log.error({ diagnostic: safeErrorDiagnostic(error), sessionId: session.id }, 'validation disposal failed') });
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
        drainSteer: () => this.#drainSteer(session, authority),
        desktopReady,
        events: {
          // Text arrives as it is generated. Not awaited: the model does not
          // wait for Redis, and back-pressure here would stall generation.
          text: (delta) => {
            void publish('agent.text', { delta });
          },
          step: (step) => publish('agent.step', step),
          toolCall,
          toolResult: (name, result, callId) =>
            publish('agent.tool_result', {
              ...(callId === undefined ? {} : {callId}),
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
        signal,
        reservations: tokenReservations,
        onProblem: (error) => {
          log.error({ sessionId: session.id, diagnostic: safeErrorDiagnostic(error) }, 'agent operation cleanup failed');
        },
      });

      signal.throwIfAborted();
      await this.#deliver(session, run, publish);
      turnCompleted = true;

      // Hot turn chaining: check the queue before releasing the sandbox.
      // If the user enqueued a follow-up while this turn was running, dequeue
      // it and run the next turn in the same live sandbox without cold-booting.
      signal.throwIfAborted();
      let nextQueued = await sessions.dequeueNextMessage(session.id, authority, signal);
      while (nextQueued !== undefined) {
        turnCompleted = false;
        signal.throwIfAborted();
        await publish('session.queued', { queuedMessageId: nextQueued.id });
        log.info(
          { sessionId: session.id, queuedMessageId: nextQueued.id },
          'hot-chaining queued message in existing sandbox',
        );

        const chainMessages = await this.#withImages(session.ownerUid, await sessions.listMessages(
          session.ownerUid,
          session.id,
          this.#deps.messageHistoryLimit,
        ));

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
          drainSteer: () => this.#drainSteer(session, authority),
          desktopReady: desktopUp,
          events: {
            text: (delta) => {
              void publish('agent.text', { delta });
            },
            step: (step) => publish('agent.step', step),
            toolCall,
            toolResult: (name, result, callId) =>
              publish('agent.tool_result', {
                ...(callId === undefined ? {} : {callId}),
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
          signal,
          reservations: tokenReservations,
        onProblem: (error) => {
            log.error({ sessionId: session.id, diagnostic: safeErrorDiagnostic(error) }, 'agent operation cleanup failed');
          },
        });

        signal.throwIfAborted();
        await this.#deliver(session, chainRun, publish);
        turnCompleted = true;

        signal.throwIfAborted();
        nextQueued = await sessions.dequeueNextMessage(session.id, authority, signal);
      }

      await settleDesktop();
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
      saveCompleted = true;
      await this.#letGo(session, acquired);
      acquired = undefined;

      const status = await sessions.finish(session.id, authority, { status: 'IDLE' });
      await publish(status === 'QUEUED' ? 'session.queued' : 'session.idle', { steps: run.steps, stopReason: run.stopReason });
      log.info({ sessionId: session.id, steps: run.steps }, 'finished a session');
    } catch (error) {
      if (error instanceof RunnerWorkError) throw error;
      const reason = this.#reason(error);
      const shuttingDown = shutdown?.aborted === true && !cancellation.signal.aborted;
      if (shuttingDown) log.info({ sessionId: session.id }, 'runner shutdown: draining active session');
      else log.error({ sessionId: session.id, diagnostic: safeErrorDiagnostic(error) }, 'session failed');

      if (acquired !== undefined) {
        // Withdrawn first: some of the paths below keep the machine for salvage and
        // throw before it is released, and a failed session should not keep
        // offering a live view of it.
        await settleDesktop();
        await this.#endDesktop(session.id, 'session-ended');
        if (workspaceMayBeDirty && saveAttempted && !saveCompleted) throw new RunnerWorkError(error, 'workspace/save-failed');
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
              true,
            );
            saveCompleted = true;
          } catch (saveError) {
            log.error(
              { sessionId: session.id },
              'could not preserve partial project work',
            );
            if (workspaceMayBeDirty) throw new RunnerWorkError(error, 'workspace/save-failed');
            // No primary mutation was admitted: cleanup may dispose of this VM.
            try { await this.#letGo(session, acquired); }
            catch { throw new RunnerWorkError(error, 'workspace/save-and-cleanup-failed'); }
            acquired = undefined;
            throw new RunnerWorkError(error, 'workspace/save-failed-without-mutations');
          }
        }
        try { await this.#letGo(session, acquired); }
        catch { throw new RunnerWorkError(error, 'sandbox/cleanup-failed'); }
      }
      if (shuttingDown) {
        if (turnCompleted) await sessions.finish(session.id, authority, { status: 'IDLE' });
        else await sessions.yieldForRecovery(session.id, authority);
        log.info({ sessionId: session.id }, 'session left recoverable after runner shutdown');
        return;
      }
      await publish('session.failed', { error: reason });

      try {
        await sessions.finish(session.id, authority, { status: 'FAILED', error: reason });
      } catch (cause) {
        // Only reachable when the lease is already gone, in which case another
        // runner owns the session and gets to decide its status.
        log.warn({ sessionId: session.id }, 'could not mark the session failed');
        throw new RunnerWorkError(error, 'session/finalization-failed');
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
   * already handling another failure. A dirty workspace stays attached until
   * a successor salvages it or records an explicit unrecoverable outcome.
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
    cleanup = false,
  ): Promise<void> {
    await acquired.running.stopCommands?.();
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
        cleanup,
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
        // about. Correlate through the project ID, never the object path or payload.
        const { cause } = saved.cleanupFailure;
        this.#deps.log.error(
          {
            sessionId: session.id,
            projectId: project.id,
            diagnostic: safeErrorDiagnostic(cause),
          },
          'project saved, but its superseded snapshot could not be deleted',
        );
      }
    } catch (error) {
      this.#deps.log.error({ sessionId: session.id }, 'could not save the project');
      await publish('project.save_failed', {
        error: error instanceof AppError ? error.message : 'The project could not be saved.',
      });
      throw error;
    }
  }

  async #letGo(session: ClaimedSession, acquired: AcquiredSandbox): Promise<void> {
    const { sessions, sandboxes, log, runnerId } = this.#deps;
    const authority = { sessionId: session.id, runnerId, token: session.leaseToken };
    // The machine is about to stop, so the desktop on it is over.
    await this.#endDesktop(session.id, 'session-ended');
    await sandboxes.release({
      uid: session.ownerUid,
      acquired,
      now: new Date(),
      onStopFailure: (error) => {
        log.warn({ sessionId: session.id }, 'could not stop the sandbox');
      },
    });
    try {
      await sessions.detachSandbox(session.id, authority);
    } catch (error) {
      log.warn({ sessionId: session.id, diagnostic: safeErrorDiagnostic(error) }, 'could not clear the sandbox record');
    }
  }

  /**
   * What to tell the user. An `AppError` was written to be read by them — "the
   * Free plan allows 10 builds" — so it is passed through. Anything else is our
   * bug or a provider's; only safe diagnostics reach operational logs.
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
    readonly signal?: AbortSignal;
  },
): Promise<void> {
  while (options.shouldContinue() && !options.signal?.aborted) {
    let didWork = false;
    if (options.maintenance !== undefined) {
      try { await options.maintenance(); }
      catch (error) { options.log.error({ diagnostic: safeErrorDiagnostic(error) }, 'snapshot cleanup remains pending'); }
    }
    if (!options.shouldContinue() || options.signal?.aborted) break;
    try {
      didWork = await runner.runOnce(options.signal);
    } catch (error) {
      if (error instanceof AppError && error.code === 'session/recovery-protocol-incompatible') {
        options.log.error({ diagnostic: safeErrorDiagnostic(error) }, 'runner recovery protocol is incompatible; claims stopped');
        throw error;
      }
      if (error instanceof RunnerWorkError) {
        options.log.error({ diagnostic: safeErrorDiagnostic(error) }, 'runner work or recovery failed');
        if (options.signal?.aborted || !options.shouldContinue()) throw error;
      } else options.log.error({}, 'could not claim a session');
    }
    if (!didWork && options.shouldContinue()) {
      await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, options.idlePollSeconds * 1000);
        options.signal?.addEventListener('abort', done, { once: true });
        if (options.signal?.aborted) done();
      });
    }
  }
}

/** The deadline includes active work, resource cleanup and connection closure. */
export async function withDrainDeadline(signal: AbortSignal, timeoutMs: number, work: () => Promise<void>, log: RunnerLogger): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let start = () => {};
  const deadline = new Promise<never>((_resolve, reject) => {
    start = () => {
      timer = setTimeout(() => {
        log.error({}, 'runner drain deadline exceeded; durable resource and usage recovery required');
        reject(new Error('Runner drain deadline exceeded.'));
      }, timeoutMs);
    };
    signal.addEventListener('abort', start, { once: true });
    if (signal.aborted) start();
  });
  try { await Promise.race([work(), deadline]); }
  finally { clearTimeout(timer); signal.removeEventListener('abort', start); }
}
