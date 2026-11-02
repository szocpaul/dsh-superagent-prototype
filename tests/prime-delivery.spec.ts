import { describe, expect, it } from 'vitest'
import {
  assertNoMergeRights,
  createDeliveryLedger,
  deliver,
  draftForGate,
  noAutoMerge,
  reconcileUnknown,
  type BranchProtection,
  type CreatePullInput,
  type DeliveryRequest,
  type PullPort,
  type PullRef,
  type PullState,
  type UpdatePullInput,
} from '../src/executor/prime-delivery.ts'
import { autoMergeEnabled, pullIsOpen } from '../src/sources/github-pull.ts'

class FakePort implements PullPort {
  heads = new Map<string, string>()
  pulls = new Map<number, PullState>()
  protection: BranchProtection = { required: true, forbidsMerge: true }
  pushes: { branch: string; commit: string; expectedOldSha: string }[] = []
  creates: CreatePullInput[] = []
  updates: { number: number; input: UpdatePullInput }[] = []
  nextNumber = 1
  failure?: { operation: string; error: Error }

  async branchHead(branch: string): Promise<string | undefined> {
    this.maybeFail('branchHead')
    return this.heads.get(branch)
  }

  async createPull(input: CreatePullInput): Promise<PullRef> {
    this.maybeFail('createPull')
    this.creates.push(input)
    const number = this.nextNumber++
    this.pulls.set(number, { state: 'open', draft: input.draft, autoMerge: false, head: input.head, base: input.base, url: `https://example.test/pull/${number}` })
    return { number, url: `https://example.test/pull/${number}` }
  }

  async updatePull(number: number, input: UpdatePullInput): Promise<PullRef> {
    this.maybeFail('updatePull')
    this.updates.push({ number, input })
    const url = `https://example.test/pull/${number}`
    this.pulls.set(number, { ...(this.pulls.get(number) ?? { state: 'open', autoMerge: false, head: '', base: '', url }), ...input, url })
    return { number, url }
  }

  async pushRef(branch: string, commit: string, expectedOldSha: string): Promise<{ ok: boolean; reason?: string }> {
    this.maybeFail('pushRef')
    this.pushes.push({ branch, commit, expectedOldSha })
    const head = this.heads.get(branch)
    if (head !== undefined && head !== expectedOldSha) return { ok: false, reason: `head is ${head}` }
    this.heads.set(branch, commit)
    return { ok: true }
  }

  async pull(number: number): Promise<PullState> {
    this.maybeFail('pull')
    const state = this.pulls.get(number)
    if (!state) throw new Error(`pull ${number} not found`)
    return state
  }

  protectedBranches: string[] = []

  async branchProtection(branch: string): Promise<BranchProtection> {
    this.maybeFail('branchProtection')
    this.protectedBranches.push(branch)
    return this.protection
  }

  private maybeFail(operation: string): void {
    if (this.failure?.operation === operation) throw this.failure.error
  }
}

const request = (overrides: Partial<DeliveryRequest> = {}): DeliveryRequest => ({
  ticketId: 'T-1',
  segmentId: 'segment-1',
  branch: 'agent/T-1',
  base: 'main',
  commit: 'commit-result',
  expectedOldSha: 'commit-baseline',
  title: 'T-1: implement the approved specification',
  summary: 'Implements the approved segment of the specification.',
  checks: [{ name: 'typecheck', exitCode: 0, evidence: 'reports/typecheck.log' }],
  limitations: [],
  ...overrides,
})

describe('delivery guards', () => {
  it('asks for the protection of the branch the pull request lands on, not of the branch it publishes from', async () => {
    const port = new FakePort()
    await deliver(request({ branch: 'agent/T-1', base: 'main' }), port)
    expect(port.protectedBranches).toEqual(['main'])
  })

  it('requires server-enforced protection that forbids the controller merge', () => {
    expect(assertNoMergeRights({ required: true, forbidsMerge: true }).ok).toBe(true)
    const forbidden = assertNoMergeRights({ required: true, forbidsMerge: false })
    expect(forbidden.ok).toBe(false)
    expect(forbidden.reason).toContain('branch protection')
    const missing = assertNoMergeRights({ required: false, forbidsMerge: false })
    expect(missing.ok).toBe(false)
    expect(missing.reason).toContain('branch protection')
  })

  it('refuses an auto-merge-enabled pull request and asks a human to resolve it', () => {
    const enabled = noAutoMerge({ state: 'open', draft: false, autoMerge: true, head: 'agent/T-1', base: 'main', url: 'u' })
    expect(enabled.ok).toBe(false)
    expect(enabled.reason).toContain('auto-merge')
    expect(enabled.nextAction).toContain('human')
    expect(noAutoMerge({ state: 'open', draft: false, autoMerge: false, head: 'agent/T-1', base: 'main', url: 'u' }).ok).toBe(true)
  })

  it('keeps an unknown remote outcome unknown, without a retry or a rollback claim', () => {
    const reconciled = reconcileUnknown({ operation: 'createPull', error: 'connection reset' })
    expect(reconciled.status).toBe('unknown')
    expect(reconciled.retried).toBe(false)
    expect(reconciled.rolledBack).toBe(false)
    expect(reconciled.nextAction).toContain('operator')
  })
})

describe('pull request delivery', () => {
  it('creates exactly one pull request and updates it on a second delivery', async () => {
    const port = new FakePort()
    port.heads.set('agent/T-1', 'commit-baseline')
    const ledger = createDeliveryLedger()
    const first = await deliver(request(), port, ledger)
    expect(first.status).toBe('delivered')
    expect(port.creates).toHaveLength(1)
    const second = await deliver(request({ commit: 'commit-result-2', expectedOldSha: 'commit-result' }), port, ledger)
    expect(second.status).toBe('delivered')
    expect(port.creates).toHaveLength(1)
    expect(port.updates).toHaveLength(1)
    expect(port.updates[0]!.number).toBe(first.status === 'delivered' ? first.pullNumber : -1)
  })

  it('pushes with the expected old SHA and refuses to overwrite a changed head', async () => {
    const port = new FakePort()
    port.heads.set('agent/T-1', 'commit-baseline')
    const first = await deliver(request(), port)
    expect(first.status).toBe('delivered')
    expect(port.pushes).toEqual([{ branch: 'agent/T-1', commit: 'commit-result', expectedOldSha: 'commit-baseline' }])

    const changed = new FakePort()
    changed.heads.set('agent/T-1', 'somebody-else-commit')
    const conflict = await deliver(request(), changed)
    expect(conflict.status).toBe('blocked')
    expect(conflict.status === 'blocked' && conflict.reason).toContain('changed')
    expect(changed.pushes).toEqual([])
    expect(changed.creates).toEqual([])
  })

  it('blocks an auto-merge-enabled pull request instead of disabling it', async () => {
    const port = new FakePort()
    port.heads.set('agent/T-1', 'commit-baseline')
    const created = await deliver(request(), port)
    const number = created.status === 'delivered' ? created.pullNumber : 0
    port.pulls.set(number, { state: 'open', draft: false, autoMerge: true, head: 'agent/T-1', base: 'main', url: 'u' })
    const blocked = await deliver(request({ pullNumber: number, expectedOldSha: 'commit-result' }), port)
    expect(blocked.status).toBe('blocked')
    expect(blocked.status === 'blocked' && blocked.reason).toContain('auto-merge')
    expect(blocked.status === 'blocked' && blocked.nextAction).toContain('human')
    expect(port.updates).toEqual([])
  })

  it('blocks before any write when the protection does not forbid the controller merge', async () => {
    const port = new FakePort()
    port.protection = { required: true, forbidsMerge: false }
    const blocked = await deliver(request(), port)
    expect(blocked.status).toBe('blocked')
    expect(blocked.status === 'blocked' && blocked.reason).toContain('branch protection')
    expect(port.pushes).toEqual([])
    expect(port.creates).toEqual([])
  })

  it('retains an unknown remote outcome instead of retrying it', async () => {
    const port = new FakePort()
    port.heads.set('agent/T-1', 'commit-baseline')
    port.failure = { operation: 'createPull', error: new Error('connection reset') }
    const result = await deliver(request(), port)
    expect(result.status).toBe('unknown')
    expect(result.status === 'unknown' && result.rolledBack).toBe(false)
    expect(result.status === 'unknown' && result.retried).toBe(false)
    expect(port.creates).toEqual([])
  })

  it('refuses to update a pull request that points at another branch', async () => {
    const port = new FakePort()
    port.heads.set('agent/T-1', 'commit-baseline')
    port.pulls.set(7, { state: 'open', draft: false, autoMerge: false, head: 'agent/other', base: 'main', url: 'u' })
    const blocked = await deliver(request({ pullNumber: 7 }), port)
    expect(blocked.status).toBe('blocked')
    expect(blocked.status === 'blocked' && blocked.reason).toContain('agent/other')
    expect(port.updates).toEqual([])
  })

  it('retains an unknown remote outcome in the ledger instead of repeating it', async () => {
    const port = new FakePort()
    port.heads.set('agent/T-1', 'commit-baseline')
    port.failure = { operation: 'createPull', error: new Error('connection reset') }
    const ledger = createDeliveryLedger()
    const result = await deliver(request(), port, ledger)
    expect(result.status).toBe('unknown')
    expect(ledger.unknowns()).toHaveLength(1)
    expect(ledger.unknowns()[0]!.result.rolledBack).toBe(false)
  })

  it('carries the actual check results instead of a claim of success', async () => {
    const port = new FakePort()
    port.heads.set('agent/T-1', 'commit-baseline')
    const result = await deliver(request({
      checks: [
        { name: 'typecheck', exitCode: 0, evidence: 'reports/typecheck.log' },
        { name: 'lint', exitCode: 1, evidence: 'reports/lint.log' },
      ],
    }), port)
    expect(result.status).toBe('delivered')
    const body = port.creates[0]!.body
    expect(body).toContain('typecheck')
    expect(body).toContain('exit code 0')
    expect(body).toContain('exit code 1')
    expect(body).toContain('1 passed, 1 failed')
    expect(body).not.toContain('all checks passed')
  })
})

describe('gate draft', () => {
  it('is a draft that carries the evidence and the limitations and claims no readiness', () => {
    const draft = draftForGate(request({
      draft: true,
      limitations: ['The convergence assessment was deferred at the gate.'],
      evidence: [{ label: 'Completed tasks', detail: 'T001, T002' }],
    }))
    expect(draft.input.draft).toBe(true)
    expect(draft.ready).toBe(false)
    expect(draft.input.body).toContain('T001, T002')
    expect(draft.input.body).toContain('The convergence assessment was deferred at the gate.')
    expect(draft.input.body).toContain('not ready')
  })
})

describe('github pull state helpers', () => {
  it('reads the auto-merge state and the open state of a pull request', () => {
    expect(autoMergeEnabled({ auto_merge: { enabled_by: 'someone' } })).toBe(true)
    expect(autoMergeEnabled({ auto_merge: null })).toBe(false)
    expect(pullIsOpen({ state: 'open' })).toBe(true)
    expect(pullIsOpen({ state: 'open', merged: true })).toBe(false)
    expect(pullIsOpen({ state: 'closed' })).toBe(false)
  })
})
