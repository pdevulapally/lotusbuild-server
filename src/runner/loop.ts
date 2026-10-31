import { timingContext, timed, observeMethods, timingTraceId } from '../diagnostics/timing.ts';
import { ContinuationPause, serializeCheckpoint, type ContinuationCheckpoint } from './continuation.ts';
import { requireFallbackPolicy, tokenLimit, verifyFallbackModel, quotaMetadata as quotaDescription, type FallbackState, type FallbackOffer } from '../sessions/fallback.ts';
import type { Registry } from '../entitlements/schema.ts';
import { createCallAdmission } from './call-admission.ts';
import { readOnlyTools, workspaceTools } from './tools.ts';
import { assertBuildAllowed } from '../entitlements/build-admission.ts';
import type Anthropic from '@anthropic-ai/sdk';

import type { EntitlementService, UserEntitlements } from '../entitlements/service.ts';
import type { ConfigurationStore } from '../entitlements/store.ts';
import type { DesktopHandoffPort } from '../desktop/handoff.ts';
import { AppError, safeErrorDiagnostic } from '../http/errors.ts';
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
function capacityFailure(error: unknown): boolean {
  if (error instanceof AppError && error.code === 'usage/limit-reached') return typeof error.details === 'object' && error.details !== null && 'kind' in error.details && error.details.kind === 'GAUGE';
  return typeof error === 'object' && error !== null && 'status' in error && [429, 503, 502, 504].includes(Number(error.status));
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
  debug?(details: object, message: string): void;
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
  /**
   * Where a running desktop is announced to the API's relay. Needed only for a
   * provider whose registry row configures a desktop; a build on one without it
   * fails to show its desktop, loudly, rather than silently skipping it.
   */
  readonly desktop?: DesktopHandoffPort;
}

/** Why a desktop stopped being available. Mirrors what the frontend is told. */
type DesktopEndReason = 'session-ended' | 'sandbox-stopped' | 'error';

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
    this.#deps = { ...deps,
      sessions: observeMethods(deps.sessions, { claim: 'session.claim', readOwned: 'session.read', finish: 'session.finish' }),
      entitlements: observeMethods(deps.entitlements, { forUser: 'entitlements.resolve' }),
      sandboxes: observeMethods(deps.sandboxes, { acquire: 'sandbox.acquire', release: 'sandbox.release' }),
      persistence: observeMethods(deps.persistence, { restore: 'workspace.restore', save: 'workspace.save' }),
      events: observeMethods(deps.events, { append: 'events.append' }),
    };
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
  ): Promise<boolean> {
    const settings = acquired.provider.desktop;
    if (settings === undefined) return false;
    try {
      const handoff = this.#deps.desktop;
      if (handoff === undefined) throw new Error('The runner has no desktop handoff configured.');
      if (acquired.running.startDesktop === undefined) throw new Error('This sandbox provider cannot show a desktop.');
      const endpoint = await acquired.running.startDesktop(settings, signal);
      // Written only once the stream is reachable, and expiring with the sandbox,
      // so a deletion that never happens cannot leave a stale entry behind.
      await handoff.publish(session.id, endpoint, acquired.provider.timeoutSeconds + 60);
      this.#desktops.add(session.id);
      await publish('desktop.ready', { width: settings.width, height: settings.height });
      return true;
    } catch (error) {
      signal.throwIfAborted();
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
    const debug = this.#deps.log.debug;
    if (debug === undefined) return this.#runOnce(shutdown);
    return timingContext((timing) => debug.call(this.#deps.log, { timing }, 'phase timing'), () => timed('runner.total', () => this.#runOnce(shutdown)));
  }

  async #runOnce(shutdown?: AbortSignal): Promise<boolean> {
    if (shutdown?.aborted) return false;
    const session = await this.#deps.sessions.claim(this.#deps.runnerId, new Date(), shutdown);
    if (session === undefined) {
      return false;
    }

    this.#deps.log.info({ sessionId: session.id, uid: session.ownerUid, timingTraceId: timingTraceId() }, 'claimed a session');
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
          // Notifications can be delayed or duplicated, including after a new turn starts.
          // Only the current durable cancellation/lease state may abort this worker.
          void sessions.assertPersistenceLease(authority).catch((error: unknown) => {
            stopWork(error instanceof Error ? error : new Error('Cancellation could not be reconciled.'));
          });
        }
      });
    } catch (err) {
      log.warn({ sessionId: session.id, diagnostic: safeErrorDiagnostic(err) }, 'could not subscribe to session events');
    }

    let pendingText = '';
    let textTimer: ReturnType<typeof setTimeout> | undefined;
    const appendEvent = async (type: string, data: Record<string, unknown>): Promise<void> => {
      try { await events.append(session.id, type, data, authority); }
      catch (error) { log.error({ sessionId: session.id, type, diagnostic: safeErrorDiagnostic(error) }, 'session event was not published'); }
    };
    let textFlush = Promise.resolve();
    const flushText = (): Promise<void> => {
      clearTimeout(textTimer); textTimer = undefined;
      const text = pendingText; pendingText = '';
      // Coalesce model deltas so a token is not a separate durable write.
      textFlush = textFlush.then(async () => {
        for (let offset = 0; offset < text.length; offset += 200) {
          await appendEvent('agent.text', { delta: text.slice(offset, offset + 200) });
        }
      });
      return textFlush;
    };
    const queueText = (delta: string): void => {
      pendingText += delta;
      if (textTimer === undefined) textTimer = setTimeout(() => { void flushText(); }, 250);
    };
    const publish = async (type: string, data: Record<string, unknown>): Promise<void> => {
      await flushText();
      await appendEvent(type, data);
    };

    const isContinuation = session.fallback?.checkpointId !== undefined && ['RUNNING', 'QUEUED', 'CAPACITY_WAIT'].includes(session.fallback.status);
    const inFallback = isContinuation && session.fallback?.lane === 'fallback';
    let sourceRegistry: Registry | undefined;
    let resumed: ContinuationCheckpoint | undefined;
    let selectedOffer: FallbackOffer | undefined;
    let activeSession: ClaimedSession = session;
    let activeLimits = this.#deps.limits;
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
      if (session.pendingInput !== undefined && session.cancelRequested !== true) {
        await sessions.finish(session.id, authority, { status: 'IDLE' });
        await publish('session.awaiting_input', { request: session.pendingInput });
        return;
      }
      if ((session.executionStarted === true || (session.recovered === true && !isContinuation)) && session.cancelRequested !== true) {
        throw new AppError({ code: 'session/interrupted-action', statusCode: 409,
          message: 'The worker was interrupted. Saved work was recovered, but external actions may have completed. Review their outcome before explicitly continuing; this turn was not repeated.' });
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
      sourceRegistry = registry;
      let executionRegistry = registry;
      if (isContinuation) {
        const policy = inFallback ? requireFallbackPolicy(registry, entitlements, session.fallback?.offer?.policyFingerprint) : undefined;
        resumed = await sessions.readContinuation(authority);
        if (resumed.completedSteps >= Math.min(resumed.maxSteps, this.#deps.limits.maxSteps) || resumed.consultations > Math.min(resumed.maxConsultations, this.#deps.limits.maxSpecialistConsultations)) throw new AppError({ code: 'fallback/budget-exhausted', statusCode: 409, message: 'Switching models cannot extend the execution budget for the original task.' });
        activeLimits = { ...this.#deps.limits, maxSteps: Math.min(resumed.maxSteps, this.#deps.limits.maxSteps),
          maxSpecialistConsultations: Math.min(resumed.maxConsultations, this.#deps.limits.maxSpecialistConsultations),
          maxOutputTokens: Math.min(resumed.maxOutputTokens, this.#deps.limits.maxOutputTokens) };
        if (inFallback && policy !== undefined) {
          if (session.fallback?.consent !== true) throw new Error('Fallback has not been approved.');
          selectedOffer = await verifyFallbackModel(this.#deps.anthropic, policy, resumed, await sandboxes.providerFor(project.platform), session.effort, activeLimits.maxOutputTokens, signal);
          activeSession = { ...session, model: selectedOffer.model, effort: selectedOffer.effort };
          activeLimits = { ...activeLimits, maxOutputTokens: selectedOffer.maxOutputTokens };
          executionRegistry = { ...registry, inputTokenMeterKey: policy.inputTokenMeterKey, outputTokenMeterKey: policy.outputTokenMeterKey };
        }
      }
      const onAdmissionFailure = async (error: unknown, checkpoint: ContinuationCheckpoint): Promise<void> => {
        if (registry.fallback === undefined || !persists) return;
        if (!tokenLimit(error, registry, inFallback ? 'fallback' : 'premium') && !(isContinuation && capacityFailure(error))) return;
        try { serializeCheckpoint(checkpoint, registry.fallback.maxCheckpointBytes); }
        catch { throw new AppError({ code: 'fallback/checkpoint-unavailable', statusCode: 409, message: 'Saved files were preserved, but this task contains context that cannot safely switch models. No action will be replayed.' }); }
        const reason = error instanceof AppError ? error : new AppError({ code: 'fallback/provider-capacity', statusCode: 503, message: 'The model provider is temporarily unavailable.' });
        throw new ContinuationPause(checkpoint, reason);
      };
      const admission = createCallAdmission({
        anthropic: this.#deps.anthropic, uid: session.ownerUid, sessionId: session.id,
        inputMeterKey: executionRegistry.inputTokenMeterKey, outputMeterKey: executionRegistry.outputTokenMeterKey,
        ...(selectedOffer === undefined ? {} : { maxInputTokens: selectedOffer.maxInputTokens }),
        metering: this.#deps.metering, reservations: tokenReservations,
        authorize: async () => {
          await sessions.assertPersistenceLease(authority);
          const latest = await this.#deps.entitlements.forUser(session.ownerUid, new Date(), true);
          assertBuildAllowed(latest, project!.platform, session.model);
          if (inFallback) requireFallbackPolicy((await this.#deps.configuration.get()).registry, latest, session.fallback?.offer?.policyFingerprint);
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
      const desktopReady = await this.#startDesktop(session, acquired, publish, signal);

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
      const toolCall = async (name: string, input: Record<string, unknown>) => {
        await sessions.assertPersistenceLease(authority);
        signal.throwIfAborted();
        if (persists && workspaceTools.has(name) && !readOnlyTools.has(name)) {
          await sessions.requireWorkspaceSalvage(authority, acquired!.running.externalId);
          workspaceMayBeDirty = true;
        }
        await publish('agent.tool_call', { name, input });
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
      await sessions.markExecutionStarted(authority);
      const requestInput = (kind: import('../sessions/repository.ts').PendingInput['kind'], prompt: string) => sessions.requestInput(authority, kind, prompt);
      const run = await runAgentTurn({
        requestInput, onAdmissionFailure,
        saveTaskContext: (context) => sessions.saveTaskContext(authority, context),
        ...(resumed === undefined ? {} : { resume: resumed }),
          withValidationSandbox,
          admission,
        anthropic: this.#deps.anthropic,
        session: activeSession,
        project,
        provider: acquired.provider,
        sandbox: acquired.running,
        messages,
        entitlements,
        registry: executionRegistry,
        metering: this.#deps.metering,
        limits: activeLimits,
        assertStillOurs: () => {
          if (leaseLost !== undefined) {
            throw leaseLost;
          }
        },
        drainSteer: () => sessions.drainSteerMessage(session.id, authority),
        desktopReady,
        events: {
          // Text arrives as it is generated. Not awaited: the model does not
          // wait for Redis, and back-pressure here would stall generation.
          text: (delta) => {
            queueText(delta);
          },
          step: (step) => publish('agent.step', step),
          toolCall,
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
      let nextQueued = registry.fallback === undefined && !isContinuation ? await sessions.dequeueNextMessage(session.id, authority, signal) : undefined;
      while (nextQueued !== undefined) {
        turnCompleted = false;
        signal.throwIfAborted();
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
          requestInput,
          saveTaskContext: (context) => sessions.saveTaskContext(authority, context),
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
          drainSteer: () => sessions.drainSteerMessage(session.id, authority),
          desktopReady,
          events: {
            text: (delta) => {
              queueText(delta);
            },
            step: (step) => publish('agent.step', step),
            toolCall,
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
      if (error instanceof ContinuationPause) {
        if (acquired === undefined || project === undefined || entitlements === undefined || sourceRegistry?.fallback === undefined) throw new RunnerWorkError(error, 'fallback/checkpoint-context-missing');
        const policy = sourceRegistry.fallback;
        let state: FallbackState;
        let retryAt: Date | undefined;
        if (capacityFailure(error.reason) || error.reason.code === 'fallback/provider-capacity') {
          retryAt = new Date(Date.now() + policy.capacityRetrySeconds * 1000);
          state = { ...session.fallback, status: 'CAPACITY_WAIT', lane: inFallback ? 'fallback' : 'premium', reason: 'Provider capacity is temporarily unavailable. The approved continuation remains queued.', retryAt: retryAt.toISOString() };
        } else if (inFallback) {
          state = { ...session.fallback, status: 'EXHAUSTED', lane: 'fallback', reason: 'The separate fallback allowance is exhausted. Wait for reset or upgrade.', ...quotaDescription(error.reason) };
        } else {
          try {
            requireFallbackPolicy(sourceRegistry, entitlements);
            const offer = await verifyFallbackModel(this.#deps.anthropic, policy, error.checkpoint, acquired.provider, session.effort, this.#deps.limits.maxOutputTokens, signal);
            const inputLimit = entitlements.meterLimits.get(policy.inputTokenMeterKey);
            const outputLimit = entitlements.meterLimits.get(policy.outputTokenMeterKey);
            if (inputLimit === undefined || outputLimit === undefined || offer.inputTokens > inputLimit.hardLimit || offer.maxOutputTokens > outputLimit.hardLimit) throw new AppError({ code: 'fallback/allowance-too-small', statusCode: 409, message: 'The configured fallback allowance cannot accommodate this task.' });
            try {
              await this.#deps.metering.assertAvailable({ uid: session.ownerUid, entitlements, meterKey: policy.inputTokenMeterKey, quantity: offer.inputTokens, now: new Date() });
              await this.#deps.metering.assertAvailable({ uid: session.ownerUid, entitlements, meterKey: policy.outputTokenMeterKey, quantity: offer.maxOutputTokens, now: new Date() });
              state = { status: 'AWAITING_CONSENT', reason: 'Your premium allowance was reached. Review the proposed free-to-user model before continuing.', offer, ...quotaDescription(error.reason) };
            } catch (allowanceError) {
              if (!tokenLimit(allowanceError, sourceRegistry, 'fallback')) throw allowanceError;
              state = { status: 'EXHAUSTED', reason: 'The separate fallback allowance is exhausted. Wait for reset or upgrade.', offer, ...quotaDescription(allowanceError) };
            }
          } catch (verificationError) {
            state = { status: 'UNAVAILABLE', reason: capacityFailure(verificationError) ? 'Fallback verification is temporarily unavailable at the provider. Your checkpoint is preserved; no fallback was started.' : 'A compatible fallback model could not be verified. Your safe checkpoint is preserved; wait for premium allowance to reset or upgrade.', ...quotaDescription(error.reason) };
          }
        }
        await this.#save(session, authority, project, entitlements, acquired, persists, restored, publish, true);
        await this.#letGo(session, acquired); acquired = undefined;
        await sessions.pauseContinuation(authority, error.checkpoint, state, retryAt);
        await publish(retryAt === undefined ? 'session.idle' : 'session.queued', { fallback: state.status });
        return;
      }
      if (isContinuation && acquired === undefined && sourceRegistry?.fallback !== undefined && session.fallback !== undefined &&
          (capacityFailure(error) || (error instanceof AppError && error.code === 'usage/limit-reached'))) {
        const temporary = capacityFailure(error);
        const retryAt = temporary ? new Date(Date.now() + sourceRegistry.fallback.capacityRetrySeconds * 1000) : undefined;
        const state: FallbackState = { ...session.fallback, status: temporary ? 'CAPACITY_WAIT' : 'SHARED_LIMIT', reason: temporary ? 'Shared execution capacity is temporarily unavailable. The task remains queued.' : 'A shared resource allowance was reached. Wait for reset or upgrade.',
          ...(retryAt === undefined ? {} : { retryAt: retryAt.toISOString() }), ...(error instanceof AppError ? quotaDescription(error) : {}) };
        await sessions.deferContinuation(authority, state, retryAt);
        await publish(retryAt === undefined ? 'session.idle' : 'session.queued', { fallback: state.status });
        return;
      }
      const reason = this.#reason(error);
      const shuttingDown = shutdown?.aborted === true && !cancellation.signal.aborted;
      if (shuttingDown) log.info({ sessionId: session.id }, 'runner shutdown: draining active session');
      else log.error({ sessionId: session.id }, 'session failed');

      if (acquired !== undefined) {
        // Withdrawn first: some of the paths below keep the machine for salvage and
        // throw before it is released, and a failed session should not keep
        // offering a live view of it.
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
      if (error instanceof AppError && error.code === 'session/input-persistence-unconfirmed') {
        const durable = await sessions.readOwned(session.ownerUid, session.id);
        if (durable.pendingInput !== undefined && durable.cancelRequested !== true) {
          await sessions.finish(session.id, authority, { status: 'IDLE' });
          await publish('session.idle', { awaitingInput: true });
          return;
        }
      }
      if (shuttingDown) {
        if (turnCompleted) await sessions.finish(session.id, authority, { status: 'IDLE' });
        else await sessions.yieldForRecovery(session.id, authority);
        log.info({ sessionId: session.id }, 'session left recoverable after runner shutdown');
        return;
      }
      try {
        const unavailable: FallbackState | undefined = sourceRegistry !== undefined && (tokenLimit(error, sourceRegistry, 'premium') || (error instanceof AppError && error.code === 'fallback/checkpoint-unavailable'))
          ? { status: 'UNAVAILABLE', reason: persists ? 'A safely resumable checkpoint or compatible fallback configuration is unavailable. Saved project work is preserved; no model was switched.' : 'The transcript is saved, but a durable workspace checkpoint is unavailable for this task. No model was switched.', ...(error instanceof AppError ? quotaDescription(error) : {}) } : undefined;
        await sessions.finish(session.id, authority, { status: 'FAILED', error: reason, ...(unavailable === undefined ? {} : { fallback: unavailable }) });
        await publish('session.failed', { error: reason });
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
      clearTimeout(textTimer);
      pendingText = '';
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
    const incomplete = ['max_steps', 'no_progress', 'blocked'].includes(run.stopReason);
    const limitation = incomplete ? 'The goal is not verified as complete. Work stopped because ' + (run.stopReason === 'max_steps' ? 'the execution step limit was reached.' : run.stopReason === 'no_progress' ? 'repeated attempts made no safe progress or the evidence limit was reached.' : 'a blocker remains.') : '';
    const reply = blocked
      ? [run.reply, blockerExplanation(run.unresolvedBlockers)]
          .filter((part) => part !== '')
          .join('\n\n')
      : [run.reply, limitation].filter(Boolean).join('\n\n');

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
    const maintenance = options.maintenance;
    if (maintenance !== undefined) {
      try { await timingContext((timing) => options.log.debug?.({ timing }, 'phase timing'), () => timed('runner.maintenance', maintenance)); }
      catch (error) { options.log.error({ diagnostic: safeErrorDiagnostic(error) }, 'background maintenance remains pending'); }
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
