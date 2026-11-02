/**
 * The typed supervisor over the isolation adapter.
 *
 * The supervisor owns the run's private service, cgroup, daemon socket and tmux identities, launches the confined
 * runner, and answers whether a stop is confirmed. It fails closed: an unsupported host, an unproven quiescence,
 * or a missing durable session identity stops the run instead of producing a claimed success.
 */
import { buildBwrapArgs, IsolationError } from '../infra/prime-isolation.ts'
import type { IsolationPlan, IsolationProcess, IsolationRunner } from '../infra/prime-isolation.ts'
import type { SegmentRunnerIdentity } from './prime-model.ts'

/** The host services the supervisor needs for one run. */
export interface RunEnvironment {
  /** Whether the host can provide the confinement a run needs. */
  supported(): boolean
  /** Starts the private service, cgroup, socket and tmux identities of the run. */
  start(plan: IsolationPlan, identity: SegmentRunnerIdentity): Promise<void>
  /** Cancels the exact private daemon and session of the run. */
  cancel(identity: SegmentRunnerIdentity): Promise<void>
  /**
   * Reads the process list of a cgroup.
   *
   * A cgroup that is gone holds no process, because the kernel removes a cgroup only when it is empty; a cgroup
   * that exists but cannot be read throws, so the state of the run stays unknown.
   */
  processes(cgroup: string): number[]
  /** Removes the run-owned service, socket, tmux server and scratch directory. */
  remove(identity: SegmentRunnerIdentity): Promise<string[]>
}

/** What a launch observed. */
export interface LaunchResult {
  /** The identity of the run, including the durable session the runner reported. */
  identity: SegmentRunnerIdentity
  /** The argument vector the runner was started with. */
  argv: string[]
  /** The output of the runner. */
  stdout: string
}

/** Whether a stop was confirmed. */
export type StopStatus = 'stopped' | 'unconfirmed' | 'unknown'

/** The verdict of a stop. */
export interface StopVerdict {
  /** `stopped` when an empty cgroup proves the run ended; `unconfirmed` when it still holds a process; `unknown` when the cgroup cannot be read. */
  status: StopStatus
  /** The reason for the verdict, in one line. */
  reason: string
  /** The processes the cgroup held, or `null` when the cgroup could not be read. */
  processes: number[] | null
  /** The failure of the cancellation itself, when the cancellation did not succeed. */
  cancelError?: string
}

/** Whether a run holds no process. */
export type QuiescenceStatus = 'quiescent' | 'busy' | 'unknown'

/** The verdict of a quiescence check. */
export interface QuiescenceVerdict {
  /** The state of the cgroup of the run. */
  status: QuiescenceStatus
  /** The reason for the verdict, in one line. */
  reason: string
  /** The processes the cgroup held, or `null` when the cgroup could not be read. */
  processes: number[] | null
}

/** What a cleanup removed. */
export interface CleanupResult {
  /** The resources the cleanup removed; every one of them belongs to the run. */
  removed: string[]
}

/** How long the launch waits for the runner to report its durable session identity. */
const IDENTITY_TIMEOUT_MS = 120_000

const SESSION_ID = /session[_\s-]?id\s*[:=]\s*"?([^\s"]+)"?/i
const SESSION_FILE = /session[_\s-]?file\s*[:=]\s*"?([^\s"]+)"?/i

/**
 * Reads the durable session identity out of the output of a runner.
 *
 * The runner may report it as a JSON line or as `session id:` and `session file:` lines; both are read, and a line
 * that reports neither is ignored.
 */
export function parseSessionIdentity(text: string): { sessionId?: string; sessionFile?: string } {
  const found: { sessionId?: string; sessionFile?: string } = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('{')) {
      try {
        const value = JSON.parse(trimmed) as Record<string, unknown>
        const id = value['sessionId'] ?? value['session_id']
        const file = value['sessionFile'] ?? value['session_file']
        if (typeof id === 'string') found.sessionId ??= id
        if (typeof file === 'string') found.sessionFile ??= file
        continue
      } catch {
        // The line is not JSON; the patterns below still apply to it.
      }
    }
    const id = SESSION_ID.exec(line)?.[1]
    const file = SESSION_FILE.exec(line)?.[1]
    if (id) found.sessionId ??= id
    if (file) found.sessionFile ??= file
  }
  return found
}

/** Starts, observes, stops and cleans up the confined runner of one run segment. */
export class PrimeSupervisor {
  /**
   * @param runner - the process adapter that starts the confined command.
   * @param environment - the host services of the run.
   */
  constructor(private readonly runner: IsolationRunner, private readonly environment: RunEnvironment) {}

  /**
   * Starts the private identities of a run and the confined runner inside them.
   * @throws IsolationError when the host cannot provide the confinement, or when the runner reports no durable
   * session identity.
   */
  async launch(plan: IsolationPlan, identity: SegmentRunnerIdentity): Promise<LaunchResult> {
    if (plan.backend !== 'bubblewrap') throw new IsolationError('the run needs a real isolation boundary, so the bridge stays disabled')
    if (!this.environment.supported()) throw new IsolationError('the host cannot provide the confinement the bridge requires, so the bridge stays disabled')
    await this.environment.start(plan, identity)
    const argv = buildBwrapArgs(plan)
    // The runner is a long-running process: it is started in the background and its durable identity is awaited,
    // rather than waiting for it to end. A run that ends before it reports an identity failed to start.
    const process = this.runner.spawn(argv, { cwd: plan.workspace, env: plan.env })
    const configured: number = Number(plan.env.IDENTITY_TIMEOUT_MS)
    const timeoutMs: number = Number.isFinite(configured) && configured > 0 ? configured : IDENTITY_TIMEOUT_MS
    const session = await this.awaitSessionIdentity(process, timeoutMs)
    if (!session.sessionId || !session.sessionFile) {
      process.kill(9)
      throw new IsolationError('the runner reported no durable session identity, so the run cannot be reconciled later')
    }
    return { identity: { ...identity, sessionId: session.sessionId, sessionFile: session.sessionFile }, argv, stdout: '' }
  }

  /**
   * Waits for the runner to report its durable session identity.
   *
   * The runner prints the identity once it starts. A runner that ends without one failed, and the wait ends with
   * the reason it gave.
   */
  private async awaitSessionIdentity(process: IsolationProcess, timeoutMs: number): Promise<{ sessionId?: string; sessionFile?: string }> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const found = parseSessionIdentity(process.output())
      if (found.sessionId && found.sessionFile) return found
      if (process.ended()) {
        const found = parseSessionIdentity(process.output())
        if (found.sessionId && found.sessionFile) return found
        throw new IsolationError(`the runner ended before it reported a session identity: ${process.stderr().trim() || 'no diagnostic'}`)
      }
      if (Date.now() > deadline) {
        process.kill(9)
        throw new IsolationError(`the runner reported no session identity within ${Math.round(timeoutMs / 1000)} s`)
      }
      await new Promise(resolve => setTimeout(resolve, 250))
    }
  }

  /**
   * Cancels the exact private daemon and session of a run and verifies that its cgroup is empty.
   *
   * Only an empty cgroup proves the stop. A cgroup that still holds a process is an unconfirmed stop, and a cgroup
   * that cannot be read is unknown; both keep the reservation and the guard of the run.
   */
  async stop(identity: SegmentRunnerIdentity, reason: string): Promise<StopVerdict> {
    let cancelError: string | undefined
    try {
      await this.environment.cancel(identity)
    } catch (error) {
      cancelError = String(error)
    }
    const verdict = await this.quiescence(identity)
    if (verdict.status === 'quiescent') {
      return { status: 'stopped', reason: `the cgroup of the run is empty: ${reason}`, processes: [], cancelError }
    }
    if (verdict.status === 'busy') {
      return { status: 'unconfirmed', reason: `the cgroup of the run still holds ${verdict.processes?.length ?? 0} processes: ${reason}`, processes: verdict.processes, cancelError }
    }
    return { status: 'unknown', reason: `the cgroup of the run cannot be read, so the stop is unconfirmed: ${reason}`, processes: null, cancelError }
  }

  /** Reads the state of the cgroup of a run without stopping it. */
  async quiescence(identity: SegmentRunnerIdentity): Promise<QuiescenceVerdict> {
    let processes: number[] | null
    try {
      processes = this.environment.processes(identity.cgroup)
    } catch {
      return { status: 'unknown', reason: `the cgroup ${identity.cgroup} cannot be read, so the state of the run is unknown`, processes: null }
    }
    if (!processes.length) return { status: 'quiescent', reason: `the cgroup ${identity.cgroup} holds no process`, processes: [] }
    return { status: 'busy', reason: `the cgroup ${identity.cgroup} holds ${processes.length} processes`, processes }
  }

  /**
   * Removes the resources of a run after a confirmed quiescence.
   * @throws IsolationError while the state of the run is not confirmed; an unconfirmed run keeps its guard.
   */
  async cleanup(identity: SegmentRunnerIdentity): Promise<CleanupResult> {
    const verdict = await this.quiescence(identity)
    if (verdict.status !== 'quiescent') {
      throw new IsolationError(`the cleanup is refused because the run is not confirmed quiescent (${verdict.status}): ${verdict.reason}`)
    }
    return { removed: await this.environment.remove(identity) }
  }
}
