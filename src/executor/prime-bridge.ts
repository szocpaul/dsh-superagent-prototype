/**
 * The bridge coordinator: the host-owned state machine that reserves the single runner slot, launches one bounded
 * segment, stops it, reconciles it after a restart, verifies the result, and delivers it for review.
 * Every external action is fenced by the segment's generation and stop epoch, so a stale callback can never start a
 * later action and a stop can never be undone by a late report.
 */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { ApprovalRecord, ApprovedManifest, BridgeSegment, FailureCause, FailureRecord, RunnerReport,
  VerificationResult } from './prime-model.ts'
import { manifestDigest } from './prime-manifest.ts'
import { gateDecisionRequest, gateQuestion, nextSegment } from './prime-gate.ts'
import { noticeText } from './prime-report.ts'
import { decideRecovery, stopFence } from './prime-recovery.ts'
import type { TaskLine } from './prime-tasks.ts'
import { Later, type Effects } from '../app/effects.ts'
import type { Store } from '../app/store.ts'
import { socketPath } from '../infra/prime-isolation.ts'

/** What the coordinator needs from the approval protocol. */
export interface ApprovalPort {
  /** Re-reads the source evidence and the current policy; throws when the approval no longer holds. */
  revalidate(segment: BridgeSegment, manifest: ApprovedManifest): Promise<void>
  /** The recorded gate decision that continues past the segment's gate, or undefined when there is none. */
  gateDecision(segment: BridgeSegment, manifest: ApprovedManifest): Promise<ApprovalRecord | undefined>
  /** Looks for the run approval of a Ticket in its original conversation and records it. */
  findRunApproval(ticketId: string, manifestSha256: string): Promise<ApprovalRecord | undefined>
  /** Looks for the gate decision of a Ticket, verifies the human's gate commit, and records it. */
  findGateApproval(ticketId: string, gateId: string, manifestSha256: string, gate: { taskLine: string; parent: string }): Promise<ApprovalRecord | undefined>
}

/** What the preflight found: it either blocks the launch or names the evidence it collected. */
export interface PreflightOutcome {
  ok: boolean
  /** The failed prerequisites, each with its cause and the action an operator must take. */
  failures: { cause: FailureCause; summary: string; evidence: string; nextAction: string }[]
}

/** What the runner adapter observed. */
export interface RunnerState {
  /** Whether the runner is still running. */
  running: boolean
  /** Whether the stop was proven; only a confirmed stop releases the reservation. */
  stop: 'stopped' | 'unconfirmed' | 'unknown'
  /** The runner's report, when it wrote one. */
  report?: RunnerReport
}

/** What the controller's own verification found. */
export interface VerificationOutcome {
  runner: RunnerReport
  verification: VerificationResult
}

/** What the delivery did. */
export interface DeliveryOutcome {
  /** The pull request the result is in. */
  prNumber?: number
  url?: string
  /** Whether the pull request is a draft, which a gate review uses. */
  draft: boolean
  /** Whether the remote outcome is unknown and must be reconciled by an operator. */
  unknown: boolean
}

/** The runner adapter the coordinator drives. */
export interface RunnerPort {
  launch(segment: BridgeSegment, manifest: ApprovedManifest): Promise<{ sessionId?: string; sessionFile?: string }>
  stop(segment: BridgeSegment): Promise<'stopped' | 'unconfirmed' | 'unknown'>
  reconcile(segment: BridgeSegment): Promise<RunnerState>
  cleanup(segment: BridgeSegment, stopConfirmed: boolean): Promise<void>
}

/** The controller's verification and delivery. */
export interface VerifyPort {
  verify(segment: BridgeSegment, manifest: ApprovedManifest): Promise<VerificationOutcome>
}
export interface DeliveryPort {
  deliver(segment: BridgeSegment, manifest: ApprovedManifest, verification: VerificationResult): Promise<DeliveryOutcome>
}

/** What one monitoring round of the quota guard found. */
export interface QuotaObservation {
  /** Whether the stop path must run, because a fault or a threshold hides or exceeds the usage. */
  requiresStop: boolean
  /** The status the guard reported: `ok`, `warn`, or `stop`. */
  status: string
  /** Why the observation says what it says. */
  reason: string
  /** What the accounting covered, so a report never claims more than it measured. */
  coverage?: string
}

/** The quota guard the coordinator owns for one run. */
export interface QuotaPort {
  install(segment: BridgeSegment, manifest: ApprovedManifest): Promise<void>
  /** One monitoring round of the guard, read independently of the controller's own state. */
  observe(segment: BridgeSegment): Promise<QuotaObservation>
  release(segment: BridgeSegment, stopConfirmed: boolean): Promise<void>
}

/** The Ticket surface the coordinator reports through. */
export interface TicketPort {
  /** Records a report on the Ticket; the domain decides what the state means. */
  report(ticketId: string, report: { state: 'progress' | 'ready' | 'blocked' | 'failed'; summary: string; question?: string }): void
  /** Sends one durable message to the Ticket's original conversation. */
  notify(ticketId: string, text: string): void
}

/** Everything the coordinator depends on. */
export interface BridgeHost {
  store: Pick<Store, 'bridge' | 'atomic' | 'tickets'>
  effects: Pick<Effects, 'enqueue' | 'enqueueSegment' | 'handle'>
  approval: ApprovalPort
  preflight: { run(segment: BridgeSegment, manifest: ApprovedManifest): Promise<PreflightOutcome> }
  runner: RunnerPort
  verify: VerifyPort
  delivery: DeliveryPort
  quota: QuotaPort
  tickets: TicketPort
  /** The manifests a Ticket asked to run, by Ticket ID. */
  manifest(ticketId: string): ApprovedManifest | undefined
  /** The login of the agent account, which a decision comment has to mention. */
  agentLogin(): string
  now(): string
}

/** The directory the bridge gives a Ticket's workspace; it is under the deployment's state directory. */
function workspaceRoot(): string {
  return process.env.DSH_PRIME_WORKSPACE_ROOT ?? join(process.cwd(), '.prime-bridge')
}

/** The approved tasks of a manifest, as the task lines the gate protocol works on. */
function taskLines(manifest: ApprovedManifest): TaskLine[] {
  return manifest.tasks.map(task => ({ id: task.id, kind: task.kind, order: task.order, checked: false, line: task.order + 1, text: task.text, tags: [] }))
}

/**
 * The bridge coordinator. It owns the single runner slot, the durable stop epoch, and the order of the external
 * actions; every step revalidates the approval and the manifest before it acts.
 */
export class PrimeBridge {
  constructor(private readonly host: BridgeHost) {}

  /** Registers the effect handlers that drive the segments. */
  install(): void {
    const { effects } = this.host
    effects.handle('prime-launch', (_payload, key) => this.launch(key).then(() => {}), { limit: () => 1, retry: [2000, 60_000] })
    effects.handle('prime-stop', (payload, key) => this.stopSegment(key, payload.reason).then(() => {}), { limit: () => 1, retry: [2000, 60_000] })
    effects.handle('prime-reconcile', (_payload, key) => this.reconcile(key).then(() => {}), { limit: () => 1, retry: [5000, 300_000] })
    effects.handle('prime-deliver', (_payload, key) => this.deliver(key).then(() => {}), { limit: () => 1, retry: [5000, 300_000] })
    effects.handle('prime-quota', (_payload, key) => this.quota(key).then(() => {}), { limit: () => 1, retry: [5000, 300_000] })
    // The human decision is not recorded yet, so the effect waits for it instead of completing: a manifest the operator
    // was asked to approve must still start the run when the operator answers, however long that takes.
    effects.handle('prime-approval', async (payload, key) => {
      if (await this.approval(payload, key)) return
      throw new Later('The human decision is not recorded yet')
    }, { limit: () => 1, retry: [15_000, 300_000] })
  }

  /**
   * Waits for a human decision: the approval of a manifest, or the continuation past a gate.
   * @returns Whether the decision was found; the effect retries while it was not.
   */
  async approval(payload: { ticketId?: string; segmentId?: string }, key: string): Promise<boolean> {
    if (payload.segmentId) return this.awaitGate(payload.segmentId)
    return this.awaitApproval(payload.ticketId ?? key)
  }

  /**
   * Reserves the run of a Ticket whose manifest a human approved.
   * @returns Whether the approval was found; the effect retries while it was not.
   */
  async awaitApproval(ticketId: string): Promise<boolean> {
    const { store, approval, tickets } = this.host
    const manifest = this.host.manifest(ticketId)
    if (!manifest) {
      tickets.report(ticketId, { state: 'blocked', summary: 'The approved manifest of the run is missing' })
      return true
    }
    // A segment that reached a terminal phase released the runner slot, so it does not keep the ticket from a new run.
    if (store.bridge.segments.byTicket(ticketId).some(segment => !['stopped', 'ready', 'blocked', 'failed'].includes(segment.phase))) return true
    const record = await approval.findRunApproval(ticketId, manifestDigest(manifest))
    // The operator has not answered yet: the effect waits for the decision.
    if (!record) return false
    if (record.decision !== 'approved') {
      tickets.report(ticketId, { state: 'blocked', summary: `The human denied the run of ${manifest.featureDir}` })
      return true
    }
    const tasks = taskLines(manifest)
    const gate = tasks.find(task => task.kind === 'human')
    const segment = tasks.filter(task => task.kind === 'automated' && (!gate || task.order < gate.order))
    const reserved = this.reserve({
      ticketId,
      assignmentId: ticketId,
      manifest,
      taskIds: segment.map(task => task.id),
      nextGateId: gate?.id ?? null,
      branch: `agent/${ticketId}`,
      workspace: join(workspaceRoot(), ticketId),
    })
    // Another segment holds the runner slot, so the request waits for the slot instead of losing the run.
    return !!reserved
  }

  /**
   * Continues past a human gate when the gate decision is approved, verified, and bound to the manifest and the ticket.
   * @returns Whether the decision was found and the next segment was reserved.
   */
  async awaitGate(segmentId: string): Promise<boolean> {
    const { store, tickets } = this.host
    const segment = store.bridge.segments.get(segmentId)
    if (!segment || segment.phase !== 'gate_wait') return true
    const manifest = this.host.manifest(segment.ticketId)
    if (!manifest || !segment.nextGateId) {
      tickets.report(segment.ticketId, { state: 'blocked', summary: 'The gate of the run has no approved manifest' })
      return true
    }
    const gate = taskLines(manifest).find(task => task.id === segment.nextGateId)
    if (!gate) {
      tickets.report(segment.ticketId, { state: 'blocked', summary: `The gate ${segment.nextGateId} is not an approved task` })
      return true
    }
    // The gate commit sits on the branch of the run, so its parent is the revision the controller published for that
    // run; the segment's own baseline is the revision from before the run and is never the parent of a gate commit.
    const published = this.host.store.bridge.reports.get(segmentId)?.verification?.resultRevision
    const record = await this.host.approval.findGateApproval(segment.ticketId, segment.nextGateId, manifestDigest(manifest), {
      taskLine: `${gate.id} ${gate.text}`,
      parent: published ?? segment.baseRevision ?? '',
    })
    // The operator has not decided the gate yet: the effect waits for the decision.
    if (!record) return false
    if (record.decision !== 'approved') {
      tickets.report(segment.ticketId, { state: 'blocked', summary: `The human denied the gate ${segment.nextGateId}` })
      return true
    }
    const reserved = await this.resumeAfterGate(segmentId)
    return !!reserved
  }

  /** The segment that currently holds the runner slot. */
  current(): BridgeSegment | undefined { return this.host.store.bridge.segments.current() }

  /**
   * Reconciles every segment that is still unresolved, including those of ended Tickets, before any launch effect may
   * dispatch. A segment whose state cannot be established keeps its reservation.
   */
  reconcileOpenSegments(): void {
    for (const segment of this.host.store.bridge.segments.list()) {
      // A segment that already left the runner's phase is driven by its own effect, and an unknown delivery waits for
      // an operator; reconciling it again would repeat the verification and the delivery without a new reason.
      if (['stopped', 'ready', 'blocked', 'failed', 'verifying', 'gate_wait'].includes(segment.phase)) {
        // A segment whose delivery failed may publish again once: the branch head it saw may have been its own push.
        if (segment.phase === 'blocked' && this.deliveryFailures(segment) === 1) {
          this.host.effects.enqueueSegment('prime-deliver', segment.segmentId, segment.generation)
        }
        continue
      }
      this.host.effects.enqueueSegment('prime-reconcile', segment.segmentId, segment.generation)
    }
  }

  /**
   * Reserves the single runner slot for a bounded segment.
   * @returns The segment, or undefined when another segment still holds the slot or the request is stale.
   */
  reserve(request: { ticketId: string; assignmentId: string; manifest: ApprovedManifest; taskIds: string[]; nextGateId: string | null; branch: string; workspace: string; baseRevision?: string }): BridgeSegment | undefined {
    const { store, effects, now } = this.host
    const latest = store.bridge.segments.byTicket(request.ticketId).at(-1)
    const generation = (latest?.generation ?? 0) + 1
    const segmentId = randomUUID()
    const segment: BridgeSegment = {
      segmentId,
      ticketId: request.ticketId,
      assignmentId: request.assignmentId,
      generation,
      manifestId: manifestDigest(request.manifest),
      phase: 'reserved',
      stopEpoch: latest?.stopEpoch ?? 0,
      stopRequested: false,
      taskIds: request.taskIds,
      nextGateId: request.nextGateId,
      runner: {
        serviceUnit: `dsh-prime-${segmentId.slice(0, 8)}`,
        cgroup: `/sys/fs/cgroup/dsh-prime-${segmentId.slice(0, 8)}`,
        tmux: `dsh-prime-${segmentId.slice(0, 8)}`,
        socket: socketPath(segmentId),
        workspace: request.workspace,
        branch: request.branch,
      },
      quotaGuardId: `prime-quota-${segmentId.slice(0, 8)}`,
      ...request.baseRevision ? { baseRevision: request.baseRevision } : {},
      createdAt: now(),
      updatedAt: now(),
    }
    try {
      store.atomic(() => {
        store.bridge.reserve(segment)
        effects.enqueueSegment('prime-launch', segmentId, generation)
      })
    } catch (error) {
      // Another segment holds the slot; the request waits instead of starting a second runner.
      return undefined
    }
    return segment
  }

  /**
   * Runs the preflight, installs the quota guard, and starts the runner.
   * A failed preflight blocks the launch, and the segment keeps the slot until an operator resolves it.
   */
  async launch(segmentId: string): Promise<void> {
    const { store, approval, preflight, quota, runner, tickets, now } = this.host
    const segment = store.bridge.segments.get(segmentId)
    if (!segment || segment.stopRequested) return
    const manifest = this.host.manifest(segment.ticketId)
    if (!manifest) { this.block(segment, 'approval', 'The approved manifest is missing', 'the manifest digest', 'Approve the manifest again'); return }
    // The fence holds the stop epoch the segment had when the launch began: a stop that lands while the launch
    // waits stops the launch before it starts the runner.
    const fence = stopFence(id => this.host.store.bridge.segments.get(id), segment.segmentId, segment.stopEpoch)
    try {
      await approval.revalidate(segment, manifest)
    } catch (error) {
      this.block(segment, 'approval', `The approval no longer holds: ${String(error)}`, 'the approval record', 'Approve the manifest again')
      return
    }
    if (fence.fenced()) return
    this.phase(segment, 'preflight')
    const checked = await preflight.run(segment, manifest)
    if (!checked.ok) {
      const failure = checked.failures[0]
      for (const item of checked.failures) this.failure(segment, item.cause, item.summary, item.evidence, item.nextAction)
      this.block(segment, failure?.cause ?? 'preflight', failure?.summary ?? 'The preflight failed', failure?.evidence ?? 'the preflight evidence', failure?.nextAction ?? 'Fix the failed prerequisite')
      return
    }
    if (fence.fenced()) return
    try {
      await quota.install(segment, manifest)
    } catch (error) {
      this.block(segment, 'quota', `The quota guard could not be installed: ${String(error)}`, 'the quota guard', 'Install the quota guard')
      return
    }
    this.phase(segment, 'launching')
    try {
      const launched = await fence.run(() => runner.launch(segment, manifest))
      if (!launched.ran) return
      this.update(segment, { phase: 'running', runner: { ...segment.runner, ...launched.value } })
    } catch (error) {
      // An unknown launch outcome keeps the reservation and the guard; it never starts a second runner.
      this.phase(segment, 'unknown')
      this.failure(segment, 'provider', `The runner did not start: ${String(error)}`, 'the launch evidence', 'Reconcile the runner state')
      tickets.report(segment.ticketId, { state: 'blocked', summary: `The Prime runner did not start: ${String(error)}` })
    }
  }

  /**
   * Stops a segment: the stop epoch and the durable stop effect are committed together, so a restart still stops it.
   * @returns Whether the stop was confirmed; an unconfirmed stop keeps the reservation and the quota guard.
   */
  async stopSegment(segmentId: string, reason: string): Promise<'stopped' | 'unconfirmed' | 'unknown'> {
    const { store, runner, quota } = this.host
    const segment = store.bridge.segments.get(segmentId)
    if (!segment) return 'unknown'
    this.phase(segment, 'stopping')
    const verdict = await runner.stop(segment)
    if (verdict !== 'stopped') {
      this.phase(segment, 'unknown')
      this.failure(segment, 'stop', `The runner was not confirmed stopped: ${verdict}`, 'the cgroup state', 'Check the runner and stop it manually')
      return verdict
    }
    this.phase(segment, 'stopped')
    await quota.release(segment, true)
    await runner.cleanup(segment, true)
    this.host.store.bridge.release(segmentId)
    return verdict
  }

  /**
   * Records the stop intent of a Ticket: the stop epoch, the tombstone, and the durable stop effect are committed in
   * the caller's transaction, so ending the Ticket and stopping the runner are one fact.
   */
  requestStop(ticketId: string, reason: string): void {
    const { store, effects } = this.host
    const segment = store.bridge.segments.current()
    if (!segment || segment.ticketId !== ticketId) return
    store.atomic(() => {
      const stopped = { ...segment, stopRequested: true, stopEpoch: segment.stopEpoch + 1, phase: 'stopping' as const, updatedAt: this.host.now() }
      store.bridge.segments.save(stopped)
      effects.enqueueSegment('prime-stop', segment.segmentId, segment.generation, reason)
    })
  }

  /**
   * Reconciles a segment with the actual state of the runner, the workspace, and the report.
   * An unknown state keeps the reservation and the quota guard.
   */
  async reconcile(segmentId: string): Promise<void> {
    const { store, runner, tickets } = this.host
    const segment = store.bridge.segments.get(segmentId)
    if (!segment || segment.stopRequested) return
    const state = await runner.reconcile(segment)
    const ticket = store.tickets.get(segment.ticketId)
    // The recovery decision keeps a segment whose state cannot be established: the reservation and the guard stay
    // until an operator resolves it, and no replacement runner starts.
    const decision = decideRecovery({
      segment,
      identityKnown: segment.runner.sessionId !== undefined || segment.phase !== 'running',
      runnerRunning: state.running,
      stop: state.stop,
      workspace: 'intact',
      guard: 'installed',
      reportPresent: !!state.report,
      remote: 'known',
      ticketEnded: !!ticket?.ended,
    })
    // A run whose runner never started may start again once the cause is gone: the segment holds no session, wrote no
    // report, and its runner is confirmed stopped. One automatic retry belongs to the segment; a second failure waits
    // for an operator, so a cause that is not gone cannot spin the segment.
    if (segment.phase === 'unknown' && segment.runner.sessionId === undefined && !state.report && state.stop === 'stopped'
      && this.launchFailures(segment) === 1) {
      this.phase(segment, 'launching')
      this.host.effects.enqueueSegment('prime-launch', segment.segmentId, segment.generation)
      return
    }
    if (decision.action === 'continue') { this.phase(segment, 'running'); return }
    if (decision.action !== 'deliver') {
      // A run that stopped without a report is blocked; any other state that cannot be established stays unknown.
      this.phase(segment, state.stop !== 'stopped' || state.report ? 'unknown' : 'blocked')
      this.failure(segment, decision.action === 'stop' ? 'stop' : 'report', decision.reason, decision.evidence, decision.nextAction)
      tickets.report(segment.ticketId, { state: 'blocked', summary: decision.reason })
      return
    }
    this.phase(segment, 'verifying')
    this.host.effects.enqueueSegment('prime-deliver', segmentId, segment.generation)
  }

  /**
   * Verifies the run and delivers the result for review. The verification is the controller's own; the runner's report
   * is never the proof.
   */
  async deliver(segmentId: string): Promise<void> {
    const { store, verify, delivery, tickets } = this.host
    const segment = store.bridge.segments.get(segmentId)
    if (!segment || segment.stopRequested) return
    // A segment that already reached its result is not delivered again, so a repeated effect publishes once.
    if (segment.phase === 'ready') return
    const fence = stopFence(id => this.host.store.bridge.segments.get(id), segment.segmentId, segment.stopEpoch)
    const manifest = this.host.manifest(segment.ticketId)
    if (!manifest) { this.block(segment, 'approval', 'The approved manifest is missing', 'the manifest digest', 'Approve the manifest again'); return }
    let outcome: VerificationOutcome
    try {
      const verified = await fence.run(() => verify.verify(segment, manifest))
      if (!verified.ran) return
      outcome = verified.value!
    } catch (error) {
      this.block(segment, 'report', `The result could not be verified: ${String(error)}`, 'the verification evidence', 'Inspect the run')
      return
    }
    store.bridge.reports.save(segmentId, { schemaVersion: 1, runner: outcome.runner, verification: outcome.verification })
    if (outcome.verification.decision !== 'ready') {
      this.phase(segment, 'blocked')
      for (const reason of outcome.verification.reasons) this.failure(segment, 'check', reason, 'the verification evidence', 'Resolve the verification findings')
      tickets.report(segment.ticketId, { state: 'blocked', summary: outcome.verification.reasons.join('; ') })
      return
    }
    let delivered: DeliveryOutcome
    try {
      const published = await fence.run(() => delivery.deliver(segment, manifest, outcome.verification))
      if (!published.ran) return
      delivered = published.value!
    } catch (error) {
      this.phase(segment, 'blocked')
      this.failure(segment, 'delivery', `The result could not be delivered: ${String(error)}`, 'the delivery evidence', 'Retry the delivery')
      tickets.report(segment.ticketId, { state: 'blocked', summary: `The verified result could not be delivered: ${String(error)}` })
      return
    }
    if (delivered.unknown) {
      // The remote outcome is unknown; it is retained for an operator and never retried blindly.
      this.phase(segment, 'unknown')
      this.failure(segment, 'delivery', 'The remote outcome of the delivery is unknown', 'the delivery evidence', 'Reconcile the pull request state')
      tickets.report(segment.ticketId, { state: 'blocked', summary: 'The delivery outcome is unknown; it must be reconciled before anything else starts.' })
      return
    }
    if (outcome.runner.outcome === 'gate') {
      this.phase(segment, 'gate_wait')
      const gate = taskLines(manifest).find(task => task.id === outcome.runner.nextGateId)
      const question = gate ? gateQuestion(gate, manifest, this.host.agentLogin())
        : `The Prime run stopped at the human gate ${outcome.runner.nextGateId ?? ''}.`
      const request = gate ? gateDecisionRequest(gate, manifest) : undefined
      const evidence = `the draft pull request ${delivered.prNumber ? `#${delivered.prNumber}` : '(none yet)'} and the verified result ${outcome.verification.resultRevision}`
      this.failure(segment, 'approval', 'The run is waiting at a human gate', evidence, question)
      this.host.effects.enqueueSegment('prime-approval', segment.segmentId, segment.generation)
      tickets.report(segment.ticketId, { state: 'progress', summary: 'The Prime run stopped at a human gate and waits for the review.', question })
      tickets.notify(segment.ticketId, request ? `${request.text}\n\n${question}` : question)
      return
    }
    this.phase(segment, 'ready')
    store.bridge.release(segmentId)
    const summary = `The Prime run finished and the result was verified independently. Pull request ${delivered.prNumber ? `#${delivered.prNumber}` : ''} `
      + `is open for review; it is not merged.`
    tickets.report(segment.ticketId, { state: 'ready', summary })
    tickets.notify(segment.ticketId, summary)
  }

  /**
   * Handles one monitoring round of the quota guard. A warning records an alert; a fault or a stop threshold runs the
   * stop path, and an unconfirmed stop keeps the guard installed.
   */
  async quota(segmentId: string): Promise<void> {
    const { store, runner, quota, tickets } = this.host
    const segment = store.bridge.segments.get(segmentId)
    if (!segment) return
    const observation = await quota.observe(segment)
    if (!observation.requiresStop) {
      this.failure(segment, 'quota', `The quota guard reported ${observation.status}: ${observation.reason}`,
        observation.coverage ?? 'the quota guard', 'Raise the limit or narrow the work')
      return
    }
    const verdict = await runner.stop(segment)
    if (verdict === 'stopped') {
      this.phase(segment, 'stopped')
      await quota.release(segment, true)
      this.failure(segment, 'quota', `The quota guard stopped the run: ${observation.reason}`,
        observation.coverage ?? 'the quota alert', 'Review the usage and raise the limit')
    } else {
      this.phase(segment, 'unknown')
      this.failure(segment, 'quota', `The quota guard asked for a stop that is not confirmed (${verdict}): ${observation.reason}`,
        observation.coverage ?? 'the quota alert', 'Check the runner and stop it manually')
    }
    tickets.report(segment.ticketId, { state: 'blocked', summary: 'The quota guard stopped the Prime run; the quota monitoring stays active until the stop is confirmed.' })
  }

  /**
   * Reserves the next segment after a human gate, when the gate decision is approved, verified, and bound to the
   * manifest and the ticket. Nothing else may continue the work.
   * @returns The new segment, or undefined when the gate is not approved or the prior segment is not quiescent.
   */
  async resumeAfterGate(segmentId: string): Promise<BridgeSegment | undefined> {
    const { store, approval, runner } = this.host
    const segment = store.bridge.segments.get(segmentId)
    if (!segment || segment.phase !== 'gate_wait') return undefined
    const manifest = this.host.manifest(segment.ticketId)
    if (!manifest) return undefined
    const decision = await approval.gateDecision(segment, manifest)
    if (!decision) return undefined
    const quiescence = await runner.reconcile(segment)
    if (quiescence.stop !== 'stopped') return undefined
    // The human's gate commit changed exactly the gate's checkbox, and the decision record was made from that
    // commit, so the gate counts as complete for the continuation.
    const tasks = taskLines(manifest).map(task => task.id === decision.gateId ? { ...task, checked: true } : task)
    const next = nextSegment(tasks, decision.gateId!, decision)
    if (!next.ok) return undefined
    // The gate is approved and the segment is quiescent, so this segment ends here. It releases the runner slot in
    // the same transaction that reserves the slot for the continuation; a segment that keeps the slot would leave the
    // continuation waiting for a slot it can never take.
    return store.atomic(() => {
      this.phase(segment, 'stopped')
      return this.reserve({
        ticketId: segment.ticketId,
        assignmentId: segment.assignmentId,
        manifest,
        taskIds: next.segment.map(task => task.id),
        nextGateId: next.gate?.id ?? null,
        branch: segment.runner.branch,
        workspace: segment.runner.workspace,
        // The continuation builds on the commit the human made for the gate: that commit sits on the branch of the
        // run and carries the gate's checkbox, so it is the revision the continuation has to build on. The segment's
        // own baseline is the revision from before the run, which the gate commit does not descend from.
        baseRevision: decision.gateCommit ?? segment.baseRevision,
      })
    })
  }

  /** How many times the delivery of a segment failed, so a retry can be bounded. */
  private deliveryFailures(segment: BridgeSegment): number {
    return this.host.store.bridge.failures.byTicket(segment.ticketId)
      .filter(record => (record.id ?? '').startsWith(segment.segmentId) && record.cause === 'delivery').length
  }

  /** How many times the launch of a segment failed, so a retry can be bounded. */
  private launchFailures(segment: BridgeSegment): number {
    return this.host.store.bridge.failures.byTicket(segment.ticketId)
      .filter(record => (record.id ?? '').startsWith(segment.segmentId) && record.cause === 'provider').length
  }

  /** Records a failure of a segment with its cause and the action an operator must take. */
  failure(segment: BridgeSegment, cause: FailureCause, summary: string, evidence: string, nextAction: string): FailureRecord {
    const record: FailureRecord = { id: `${segment.segmentId}-${cause}-${this.host.now()}`, ticketId: segment.ticketId, cause, summary, evidence, nextAction, at: this.host.now() }
    this.host.store.bridge.failures.save(record)
    return record
  }

  /** Moves a segment to a phase and records the change. */
  private phase(segment: BridgeSegment, phase: BridgeSegment['phase']): void {
    this.update(segment, { phase })
  }

  /** Saves a segment, keeping its generation and stop epoch. */
  private update(segment: BridgeSegment, patch: Partial<BridgeSegment>): void {
    const { store, now } = this.host
    const updated: BridgeSegment = { ...segment, ...patch, updatedAt: now() }
    store.bridge.segments.save(updated)
  }

  /** Blocks a segment and tells the operator what is needed, in the notice the operator reads. */
  private block(segment: BridgeSegment, cause: FailureCause, summary: string, evidence: string, nextAction: string): void {
    const failure = this.failure(segment, cause, summary, evidence, nextAction)
    this.phase(segment, 'blocked')
    this.host.tickets.report(segment.ticketId, { state: 'blocked', summary: noticeText(failure) })
  }
}
