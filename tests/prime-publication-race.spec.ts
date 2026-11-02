/**
 * The publication race of the Prime Runner Bridge: an unknown in-flight GitHub call, a delayed visibility, and a
 * refused push lease keep the delivery unknown or blocked. The controller never publishes twice on its own, and it
 * never claims that it rolled the remote action back.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { acceptedOutcome, decidePublication } from '../src/executor/prime-recovery.ts'
import { createDeliveryLedger, deliver, type DeliveryRequest, type PullPort } from '../src/executor/prime-delivery.ts'
import { harness, reserve, type Harness } from './fixtures/prime-bridge-host.ts'

let host: Harness
beforeEach(() => { host = harness() })
afterEach(() => host.dispose())

/** The request the delivery publishes. */
const request = (overrides: Partial<DeliveryRequest> = {}): DeliveryRequest => ({
  ticketId: 'ticket-1', segmentId: 'segment-1', branch: 'agent/ticket-1', base: 'main',
  commit: 'commit-result', expectedOldSha: 'commit-baseline', title: 'The approved segment',
  summary: 'The segment is implemented.', checks: [], limitations: [], ...overrides,
})

/** A fake GitHub side that records what the controller did. */
class FakeGitHub implements PullPort {
  /** The pull requests the controller created. */
  creates: number[] = []
  /** The pull requests the controller updated. */
  updates: number[] = []
  /** The heads of the branches the controller pushed to. */
  pushed: string[] = []
  /** The result of the next create call. */
  createError?: Error
  /** The result of the next push call. */
  pushResult: { ok: boolean; reason?: string } = { ok: true }
  private next = 1
  /** The current head of the branch. */
  head = 'commit-baseline'

  async branchHead(): Promise<string | undefined> { return this.head }
  async createPull(): Promise<{ number: number; url: string }> {
    if (this.createError) { const error = this.createError; this.createError = undefined; throw error }
    const number = this.next++
    this.creates.push(number)
    return { number, url: `https://example.test/pull/${number}` }
  }
  async updatePull(number: number): Promise<{ number: number; url: string }> {
    this.updates.push(number)
    return { number, url: `https://example.test/pull/${number}` }
  }
  async pushRef(_branch: string, commit: string): Promise<{ ok: boolean; reason?: string }> {
    this.pushed.push(commit)
    if (this.pushResult.ok) this.head = commit
    return this.pushResult
  }
  async pull(number: number): Promise<{ state: string; draft: boolean; autoMerge: boolean; head: string; base: string; url: string }> {
    if (!this.creates.includes(number)) throw new Error(`pull ${number} not found`)
    return { state: 'open', draft: false, autoMerge: false, head: 'agent/ticket-1', base: 'main', url: `https://example.test/pull/${number}` }
  }
  async branchProtection(): Promise<{ required: boolean; forbidsMerge: boolean }> { return { required: true, forbidsMerge: true } }
  async pullForBranch(): Promise<number | undefined> { return undefined }
  async treeOf(): Promise<string | undefined> { return undefined }
}

describe('the publication decision', () => {
  it('publishes when the remote state is known and no stop fences it', () => {
    const decision = decidePublication({ stopRequested: false, remote: 'known' })
    expect(decision.status).toBe('publish')
    expect(decision.retried).toBe(false)
    expect(decision.rolledBack).toBe(false)
  })

  it('keeps an unknown remote outcome unknown and never repeats it', () => {
    const decision = decidePublication({ stopRequested: false, remote: 'unknown' })
    expect(decision.status).toBe('unknown')
    expect(decision.retried).toBe(false)
    expect(decision.rolledBack).toBe(false)
    expect(decision.reason).toMatch(/must not be repeated/)
    expect(decision.nextAction).toMatch(/operator/)
  })

  it('keeps a result that is not visible yet unknown', () => {
    const decision = decidePublication({ stopRequested: false, remote: 'not-visible' })
    expect(decision.status).toBe('unknown')
    expect(decision.retried).toBe(false)
    expect(decision.rolledBack).toBe(false)
    expect(decision.reason).toMatch(/not visible/)
  })

  it('blocks a refused push lease and asks an operator to reconcile the branch head', () => {
    const decision = decidePublication({ stopRequested: false, remote: 'lease-failed' })
    expect(decision.status).toBe('blocked')
    expect(decision.reason).toMatch(/lease/)
    expect(decision.nextAction).toMatch(/operator/)
    expect(decision.rolledBack).toBe(false)
  })

  it('blocks every new publication after a stop', () => {
    const decision = decidePublication({ stopRequested: true, remote: 'known' })
    expect(decision.status).toBe('blocked')
    expect(decision.reason).toMatch(/stop/)
    expect(decision.rolledBack).toBe(false)
  })
})

describe('an operation that was accepted before the stop', () => {
  it('reports a completed operation after the stop and never claims a rollback', () => {
    const outcome = acceptedOutcome({ operation: 'createPull', completed: true, stopBeforeAccept: false })
    expect(outcome.status).toBe('completed-after-stop')
    expect(outcome.rolledBack).toBe(false)
    expect(outcome.reason).toMatch(/completed after the stop/)
    expect(outcome.nextAction).toMatch(/operator/)
  })

  it('reports an operation whose outcome was lost as unknown', () => {
    const outcome = acceptedOutcome({ operation: 'pushRef', completed: false, stopBeforeAccept: true })
    expect(outcome.status).toBe('unknown')
    expect(outcome.rolledBack).toBe(false)
    expect(outcome.nextAction).toMatch(/operator/)
  })
})

describe('an unknown in-flight GitHub call', () => {
  it('keeps the delivery unknown and retains it for an operator', async () => {
    const github = new FakeGitHub()
    github.createError = new Error('connection reset')
    const ledger = createDeliveryLedger()
    const result = await deliver(request(), github, ledger)
    expect(result.status).toBe('unknown')
    expect(result.status === 'unknown' && result.retried).toBe(false)
    expect(result.status === 'unknown' && result.rolledBack).toBe(false)
    expect(ledger.unknowns()).toHaveLength(1)
  })

  it('blocks the Ticket and claims no readiness', async () => {
    const unknown = harness({ deliver: async () => ({ draft: false, unknown: true }) })
    try {
      const segment = reserve(unknown)
      await unknown.bridge.deliver(segment.segmentId)
      expect(unknown.store.bridge.segments.get(segment.segmentId)?.phase).toBe('unknown')
      expect(unknown.store.bridge.segments.current()?.segmentId).toBe(segment.segmentId)
      const failures = unknown.store.bridge.failures.byTicket('ticket-1')
      expect(failures.map(failure => failure.cause)).toContain('delivery')
      expect(failures.map(failure => failure.summary).join(' ')).toMatch(/unknown/)
      expect(unknown.calls.reports.map(report => report.state)).not.toContain('ready')
    } finally {
      unknown.dispose()
    }
  })

  it('never claims that it rolled the remote action back', async () => {
    const unknown = harness({ deliver: async () => ({ draft: false, unknown: true }) })
    try {
      const segment = reserve(unknown)
      await unknown.bridge.deliver(segment.segmentId)
      const said = [
        ...unknown.calls.reports.map(report => report.summary),
        ...unknown.calls.notifications,
        ...unknown.store.bridge.failures.byTicket('ticket-1').map(failure => `${failure.summary} ${failure.nextAction}`),
      ].join(' ')
      expect(said).not.toMatch(/rolled back|reverted|undo/i)
      expect(said).toMatch(/unknown|reconcil/i)
    } finally {
      unknown.dispose()
    }
  })

  it('does not repeat the publication on its own', async () => {
    const unknown = harness({ deliver: async () => ({ draft: false, unknown: true }) })
    try {
      const segment = reserve(unknown)
      await unknown.bridge.deliver(segment.segmentId)
      expect(unknown.calls.deliver).toBe(1)
      const rows = unknown.store.db.prepare('SELECT kind FROM effect WHERE key=?').all(segment.segmentId)
      expect(rows.filter(row => row.kind === 'prime-deliver')).toHaveLength(0)
    } finally {
      unknown.dispose()
    }
  })
})

describe('a repeated publication', () => {
  it('opens one pull request for the segment, however often the delivery runs', async () => {
    const github = new FakeGitHub()
    const ledger = createDeliveryLedger()
    const repeated = harness({
      deliver: async () => {
        const result = await deliver(request({ segmentId: 'segment-1' }), github, ledger)
        if (result.status === 'delivered') return { prNumber: result.pullNumber, draft: result.draft, unknown: false }
        if (result.status === 'unknown') return { draft: false, unknown: true }
        throw new Error(result.reason)
      },
    })
    try {
      const segment = reserve(repeated)
      await repeated.bridge.deliver(segment.segmentId)
      await repeated.bridge.deliver(segment.segmentId)
      expect(github.creates).toHaveLength(1)
    } finally {
      repeated.dispose()
    }
  })
})

describe('a delayed visibility of the result', () => {
  it('updates the pull request of the segment instead of opening a second one', async () => {
    const github = new FakeGitHub()
    const ledger = createDeliveryLedger()
    const first = await deliver(request(), github, ledger)
    expect(first.status).toBe('delivered')
    const second = await deliver(request({ commit: 'commit-result-2', expectedOldSha: 'commit-result' }), github, ledger)
    expect(second.status).toBe('delivered')
    expect(github.creates).toHaveLength(1)
    expect(github.updates).toHaveLength(1)
  })

  it('keeps a result that is not visible yet unknown instead of publishing it again', () => {
    const decision = decidePublication({ stopRequested: false, remote: 'not-visible' })
    expect(decision.status).toBe('unknown')
    expect(decision.nextAction).toMatch(/operator/)
  })
})

describe('a refused push lease', () => {
  it('blocks the publication and opens no pull request', async () => {
    const github = new FakeGitHub()
    github.pushResult = { ok: false, reason: 'the branch head changed' }
    const result = await deliver(request(), github)
    expect(result.status).toBe('blocked')
    expect(result.status === 'blocked' && result.reason).toMatch(/lease/)
    expect(result.status === 'blocked' && result.nextAction).toMatch(/operator/)
    expect(github.creates).toEqual([])
  })

  it('blocks the Ticket, keeps the evidence, and claims no readiness', async () => {
    const refused = harness({ deliverError: new Error('the push was refused under the expected-old-SHA lease') })
    try {
      const segment = reserve(refused)
      await refused.bridge.deliver(segment.segmentId)
      expect(refused.store.bridge.segments.get(segment.segmentId)?.phase).toBe('blocked')
      const failures = refused.store.bridge.failures.byTicket('ticket-1')
      expect(failures.map(failure => failure.cause)).toContain('delivery')
      expect(failures.map(failure => failure.summary).join(' ')).toMatch(/could not be delivered/)
      expect(refused.calls.reports.map(report => report.state)).not.toContain('ready')
    } finally {
      refused.dispose()
    }
  })

  it('publishes nothing when the verification itself fails', async () => {
    const failed = harness({ verifyError: new Error('the result revision is stale') })
    try {
      const segment = reserve(failed)
      await failed.bridge.deliver(segment.segmentId)
      expect(failed.calls.deliver).toBe(0)
      expect(failed.store.bridge.segments.get(segment.segmentId)?.phase).toBe('blocked')
      expect(failed.store.bridge.failures.byTicket('ticket-1').map(failure => failure.cause)).toContain('report')
    } finally {
      failed.dispose()
    }
  })
})
