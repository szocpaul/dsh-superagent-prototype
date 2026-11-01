/**
 * The reconciliation and publication policy of the Prime Runner Bridge: what the controller does with a segment it
 * finds after a restart, a lost notification, or an unknown remote outcome. Every decision is a pure function of what
 * was observed, so the coordinator can be tested without a process, a clock, or a network.
 */
import type { BridgeSegment } from './prime-model.ts'

/** What the controller knows about the workspace of a run. */
export type WorkspaceState = 'intact' | 'missing' | 'changed'

/** What the controller knows about the quota guard of a run. */
export type GuardState = 'installed' | 'missing'

/** What the controller knows about the remote side of a run. */
export type RemoteState = 'known' | 'unknown' | 'not-visible' | 'lease-failed'

/** The state the controller observed for one segment. */
export interface RecoveryObservation {
  /** The segment the controller holds. */
  segment: BridgeSegment
  /** Whether the durable session identity of the run was persisted before it began to work. */
  identityKnown: boolean
  /** Whether the runner still holds a process. */
  runnerRunning: boolean
  /** Whether the stop was proven. */
  stop: 'stopped' | 'unconfirmed' | 'unknown'
  /** The state of the workspace the runner wrote. */
  workspace: WorkspaceState
  /** The state of the quota guard of the run. */
  guard: GuardState
  /** Whether a usable run report was found. */
  reportPresent: boolean
  /** What the controller knows about the remote side of the segment. */
  remote: RemoteState
  /** Whether the Ticket of the segment ended. */
  ticketEnded: boolean
}

/** What the controller does with the segment. */
export type RecoveryAction =
  /** The runner is still working; the controller waits and keeps the reservation. */
  | 'continue'
  /** The segment is complete and its result may be verified and delivered. */
  | 'deliver'
  /** The segment cannot be decided; the reservation and the guard stay until an operator resolves it. */
  | 'hold'
  /** The segment must be stopped; the stop is not confirmed yet. */
  | 'stop'

/** The decision the controller acts on, with the evidence and the next action it shows. */
export interface RecoveryDecision {
  /** What the controller does next. */
  action: RecoveryAction
  /** The reason of the decision, in one line. */
  reason: string
  /** The evidence the decision rests on. */
  evidence: string
  /** The one action an operator must take when the decision needs one. */
  nextAction: string
  /** Whether the segment keeps the single runner slot. */
  keepReservation: boolean
  /** Whether the quota guard of the segment stays installed. */
  keepGuard: boolean
}

/**
 * Decides what the controller does with a segment it found after a restart or a lost notification.
 *
 * A missing identity, an unknown runner, a changed workspace, a missing report, and an unknown remote outcome all
 * hold the segment: the reservation and the quota guard stay, and no replacement runner starts until an operator
 * resolves the state. A Ticket that ended is reconciled like any other; the fact that it ended never hides a run.
 */
export const decideRecovery = (observation: RecoveryObservation): RecoveryDecision => {
  if (!observation.identityKnown) {
    return {
      action: 'hold',
      reason: 'the durable session identity of the run was never persisted, so the runner cannot be identified',
      evidence: 'the runner identity of the segment',
      nextAction: 'an operator must identify the runner of the segment before any replacement starts',
      keepReservation: true,
      keepGuard: true,
    }
  }
  if (observation.runnerRunning) {
    return {
      action: 'continue',
      reason: 'the runner still holds a process and is reconciled again later',
      evidence: 'the cgroup state of the run',
      nextAction: '',
      keepReservation: true,
      keepGuard: true,
    }
  }
  if (observation.stop !== 'stopped') {
    return {
      action: 'stop',
      reason: `the runner was not confirmed stopped (${observation.stop}), so no replacement may start`,
      evidence: 'the cgroup state of the run',
      nextAction: 'an operator must check the runner and stop it manually',
      keepReservation: true,
      keepGuard: true,
    }
  }
  if (observation.workspace === 'missing') {
    return {
      action: 'hold',
      reason: 'the workspace of the run is gone, so its result cannot be verified',
      evidence: 'the workspace of the run',
      nextAction: 'an operator must inspect the run and decide whether a new segment may start',
      keepReservation: true,
      keepGuard: true,
    }
  }
  if (observation.workspace === 'changed') {
    return {
      action: 'hold',
      reason: 'the workspace of the run changed outside the controller, so it must be reconciled first',
      evidence: 'the workspace digest of the run',
      nextAction: 'an operator must reconcile the changed workspace before the result is published',
      keepReservation: true,
      keepGuard: true,
    }
  }
  if (!observation.reportPresent) {
    return {
      action: 'hold',
      reason: 'the runner stopped without a usable report, so the result cannot be verified',
      evidence: 'the run report',
      nextAction: 'an operator must inspect the run and decide whether a new segment may start',
      keepReservation: true,
      keepGuard: true,
    }
  }
  if (observation.remote === 'unknown') {
    return {
      action: 'hold',
      reason: 'the remote outcome of the segment is unknown, so it must not be published again',
      evidence: 'the delivery evidence',
      nextAction: 'an operator must read the remote state and decide whether the operation already happened',
      keepReservation: true,
      keepGuard: true,
    }
  }
  if (observation.remote === 'not-visible') {
    return {
      action: 'hold',
      reason: 'the remote result of the segment is not visible yet, so it must not be published again',
      evidence: 'the delivery evidence',
      nextAction: 'an operator must read the remote state and decide whether the publication already happened',
      keepReservation: true,
      keepGuard: true,
    }
  }
  if (observation.remote === 'lease-failed') {
    return {
      action: 'hold',
      reason: 'the push lease of the segment was refused, so the branch head must be reconciled first',
      evidence: 'the delivery evidence',
      nextAction: 'an operator must reconcile the branch head before the result is published again',
      keepReservation: true,
      keepGuard: true,
    }
  }
  return {
    action: 'deliver',
    reason: observation.ticketEnded
      ? 'the Ticket ended, but the run is complete and its result is reconciled and delivered'
      : 'the run is complete and its result may be verified and delivered',
    evidence: 'the run report',
    nextAction: '',
    keepReservation: false,
    keepGuard: false,
  }
}

/** What the controller knows about the remote side of a publication. */
export interface PublicationObservation {
  /** Whether a stop was requested for the segment. */
  stopRequested: boolean
  /** What the remote side of the publication is. */
  remote: RemoteState
}

/** What the controller publishes, and what it claims about the remote side. */
export interface PublicationDecision {
  /** What the controller does with the publication. */
  status: 'publish' | 'unknown' | 'blocked'
  /** The reason of the decision, in one line. */
  reason: string
  /** The one action an operator must take when the decision needs one. */
  nextAction: string
  /** The delivery is never retried on its own. */
  retried: false
  /** The controller never claims that it rolled the remote action back. */
  rolledBack: false
}

/**
 * Decides what the controller does with a publication.
 *
 * An unknown remote outcome stays unknown and is never repeated; a refused push lease blocks the publication; a
 * requested stop blocks every new publication, and an operation that was already accepted before the stop stays
 * unknown rather than being reported as rolled back.
 */
export const decidePublication = (observation: PublicationObservation): PublicationDecision => {
  if (observation.remote === 'unknown') {
    return {
      status: 'unknown',
      reason: 'the result of the remote operation was lost, so it must not be repeated',
      nextAction: 'an operator must read the remote state and decide whether the operation already happened',
      retried: false,
      rolledBack: false,
    }
  }
  if (observation.remote === 'not-visible') {
    return {
      status: 'unknown',
      reason: 'the remote result is not visible yet, so the publication must not be repeated',
      nextAction: 'an operator must read the remote state and decide whether the publication already happened',
      retried: false,
      rolledBack: false,
    }
  }
  if (observation.remote === 'lease-failed') {
    return {
      status: 'blocked',
      reason: 'the push was refused under the expected-old-SHA lease, so the branch head changed',
      nextAction: 'an operator must reconcile the branch head before the result is published again',
      retried: false,
      rolledBack: false,
    }
  }
  if (observation.stopRequested) {
    return {
      status: 'blocked',
      reason: 'a stop was requested, so no new external action starts for this segment',
      nextAction: 'an operator must approve a new authorization before the segment continues',
      retried: false,
      rolledBack: false,
    }
  }
  return {
    status: 'publish',
    reason: 'the remote state is known and no stop fences the publication',
    nextAction: '',
    retried: false,
    rolledBack: false,
  }
}


/**
 * The stop fence of the Prime Runner Bridge: the guard every external action of a segment passes through. A stop
 * request, or a stop epoch that moved while the action was in flight, fences the action, so a late callback can
 * never start a later run, publish a stopped result, or repeat a delivery.
 */

/** Reads the current state of a segment; it returns undefined when the segment is gone. */
export type SegmentReader = (segmentId: string) => BridgeSegment | undefined

/**
 * The fence of one segment.
 *
 * The coordinator builds it with the store's segment reader and the stop epoch it captured when it began. Before
 * every external action it asks the fence whether the action may still run.
 */
export class StopFence {
  /**
   * @param read - Reads the current segment from the store.
   * @param segmentId - The segment the fence belongs to.
   * @param epoch - The stop epoch the caller captured when it began.
   */
  constructor(private readonly read: SegmentReader, private readonly segmentId: string, private readonly epoch: number) {}

  /** The segment as the store holds it now. */
  segment(): BridgeSegment | undefined { return this.read(this.segmentId) }

  /**
   * Whether the action is fenced.
   *
   * A stop that was requested fences every new external action. A stop epoch that moved while the action was in
   * flight fences it too, because the callback belongs to an older epoch.
   */
  fenced(): boolean {
    const segment = this.segment()
    if (!segment) return true
    return segment.stopRequested || staleCallback(segment, this.epoch)
  }

  /**
   * Runs the action only when it is not fenced.
   * @returns Whether the action ran, and its value when it did.
   */
  async run<T>(action: () => Promise<T>): Promise<{ ran: boolean; value?: T }> {
    if (this.fenced()) return { ran: false }
    const value = await action()
    if (this.fenced()) return { ran: false }
    return { ran: true, value }
  }
}

/**
 * Builds the fence of one segment from the store's segment reader.
 * @param read - Reads the current segment from the store.
 * @param segmentId - The segment the fence belongs to.
 * @param epoch - The stop epoch the caller captured when it began.
 */
export const stopFence = (read: SegmentReader, segmentId: string, epoch: number): StopFence => new StopFence(read, segmentId, epoch)

/** What the controller knows about a remote operation that was already accepted when a stop arrived. */
export interface AcceptedOperation {
  /** The remote operation, such as `createPull`. */
  operation: string
  /** Whether the remote side completed the operation. */
  completed: boolean
  /** Whether the stop was requested before the operation was accepted. */
  stopBeforeAccept: boolean
}

/** What the controller reports about an operation that was already in flight when a stop arrived. */
export interface AcceptedOutcome {
  /** The state the operator sees. */
  status: 'completed-after-stop' | 'unknown'
  /** The reason of the outcome, in one line. */
  reason: string
  /** The one action an operator must take. */
  nextAction: string
  /** The controller never claims that it rolled the remote action back. */
  rolledBack: false
}

/**
 * Reports the outcome of a remote operation that was already accepted when a stop arrived.
 *
 * The controller does not promise to reverse the remote action. It reports the operation as completed after the stop
 * when the remote side finished it, and as unknown when the outcome was lost, so an operator resolves it.
 */
export const acceptedOutcome = (operation: AcceptedOperation): AcceptedOutcome => {
  if (operation.completed) {
    return {
      status: 'completed-after-stop',
      reason: `the remote operation ${operation.operation} completed after the stop was requested`,
      nextAction: 'an operator must inspect the remote state and decide what to do with the published result',
      rolledBack: false,
    }
  }
  return {
    status: 'unknown',
    reason: `the remote operation ${operation.operation} was accepted before the stop and its outcome is unknown`,
    nextAction: 'an operator must read the remote state and decide whether the operation already happened',
    rolledBack: false,
  }
}

/** Whether a callback that names an older stop epoch is stale and must be dropped. */
export const staleCallback = (segment: BridgeSegment, epoch: number): boolean => epoch < segment.stopEpoch

/** Whether a stop fences every new external action of the segment. */
export const externalActionFenced = (segment: BridgeSegment): boolean => segment.stopRequested
