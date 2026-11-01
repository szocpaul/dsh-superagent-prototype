/**
 * Stop behaviour of the Prime Runner Bridge: the stop intent is durable and atomic, a stale callback is dropped, and a
 * stop that races a launch, an approval, a report, or a publication starts no new external action.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PrimeBridge } from '../src/executor/prime-bridge.ts'
import { externalActionFenced, staleCallback, stopFence } from '../src/executor/prime-recovery.ts'
import { harness, manifest, reserve, type Harness } from './fixtures/prime-bridge-host.ts'

let host: Harness
beforeEach(() => { host = harness() })
afterEach(() => host.dispose())

describe('the stop intent', () => {
  it('records the stop intent and the durable stop effect in one transaction', () => {
    const segment = reserve(host)
    host.bridge.requestStop('ticket-1', 'the operator stopped the ticket')
    const stored = host.store.bridge.segments.get(segment.segmentId)
    expect(stored?.stopRequested).toBe(true)
    expect(stored?.phase).toBe('stopping')
    const rows = host.store.db.prepare('SELECT kind FROM effect WHERE key=?').all(segment.segmentId)
    expect(rows.map(row => row.kind)).toContain('prime-stop')
  })

  it('increases the stop epoch so every later callback is recognizable as stale', () => {
    const segment = reserve(host)
    expect(segment.stopEpoch).toBe(0)
    host.bridge.requestStop('ticket-1', 'the operator stopped the ticket')
    expect(host.store.bridge.segments.get(segment.segmentId)?.stopEpoch).toBe(1)
  })

  it('leaves no stop intent behind when the durable effect cannot be written', () => {
    const segment = reserve(host)
    const failing = new PrimeBridge({
      store: host.store,
      effects: { enqueue: () => {}, enqueueSegment: () => { throw new Error('the effect queue is full') }, handle: () => {} },
      approval: { revalidate: async () => {}, gateDecision: async () => undefined },
      preflight: { run: async () => ({ ok: true, failures: [] }) },
      runner: { launch: async () => ({}), stop: async () => 'stopped', reconcile: async () => ({ running: false, stop: 'stopped' }), cleanup: async () => {} },
      verify: { verify: async () => ({ runner: {} as never, verification: {} as never }) },
      delivery: { deliver: async () => ({ draft: false, unknown: false }) },
      quota: { install: async () => {}, release: async () => {} },
      tickets: { report: () => {}, notify: () => {} },
      manifest: () => manifest(),
      now: host.clock.now,
    } as never)
    expect(() => failing.requestStop('ticket-1', 'the operator stopped the ticket')).toThrow(/effect queue/)
    const stored = host.store.bridge.segments.get(segment.segmentId)
    expect(stored?.stopRequested).toBe(false)
    expect(stored?.stopEpoch).toBe(0)
  })

  it('drops a callback that names an older stop epoch', () => {
    const segment = reserve(host)
    host.bridge.requestStop('ticket-1', 'the operator stopped the ticket')
    const stored = host.store.bridge.segments.get(segment.segmentId)!
    expect(staleCallback(stored, 0)).toBe(true)
    expect(staleCallback(stored, 1)).toBe(false)
    host.store.bridge.segments.save({ ...stored, phase: 'running', stopEpoch: 0 })
    expect(host.store.bridge.segments.get(segment.segmentId)?.phase).toBe('stopping')
  })

  it('drops a bridge effect that names an older generation', () => {
    const segment = reserve(host)
    expect(host.effects.enqueueSegment('prime-launch', segment.segmentId, 0)).toBe(false)
  })

  it('commits the stop intent with the transaction that ends the Ticket', () => {
    const segment = reserve(host)
    expect(() => host.store.atomic(() => {
      host.bridge.requestStop('ticket-1', 'the operator stopped the ticket')
      throw new Error('the Ticket end was rolled back')
    })).toThrow(/rolled back/)
    const stored = host.store.bridge.segments.get(segment.segmentId)
    expect(stored?.stopRequested).toBe(false)
    expect(stored?.stopEpoch).toBe(0)
    const rows = host.store.db.prepare('SELECT kind FROM effect WHERE key=?').all(segment.segmentId)
    expect(rows.map(row => row.kind)).not.toContain('prime-stop')
  })

  it('blocks a replacement runner while the stop is unconfirmed', () => {
    const segment = reserve(host)
    host.bridge.requestStop('ticket-1', 'the operator stopped the ticket')
    const replacement = host.bridge.reserve({
      ticketId: 'ticket-1', assignmentId: 'assignment-2', manifest: manifest(), taskIds: ['T001'],
      nextGateId: null, branch: 'agent/ticket-1', workspace: '/tmp/workspace',
    })
    expect(replacement).toBeUndefined()
    expect(host.store.bridge.segments.current()?.segmentId).toBe(segment.segmentId)
  })

  it('keeps the stop intent across a restart', () => {
    const segment = reserve(host)
    host.bridge.requestStop('ticket-1', 'the operator stopped the ticket')
    host.reopen()
    const stored = host.store.bridge.segments.get(segment.segmentId)
    expect(stored?.stopRequested).toBe(true)
    expect(stored?.stopEpoch).toBe(1)
  })
})

describe('a stop that fences an external action', () => {
  it('starts no runner when the stop is recorded before the launch runs', async () => {
    const segment = reserve(host)
    host.bridge.requestStop('ticket-1', 'the operator stopped the ticket')
    await host.bridge.launch(segment.segmentId)
    expect(host.calls.launch).toBe(0)
    expect(host.calls.quotaInstall).toBe(0)
  })

  it('reconciles no report when the stop is recorded before the reconciliation', async () => {
    const segment = reserve(host)
    host.bridge.requestStop('ticket-1', 'the operator stopped the ticket')
    await host.bridge.reconcile(segment.segmentId)
    expect(host.calls.verify).toBe(0)
    expect(host.calls.deliver).toBe(0)
  })

  it('delivers nothing when the stop lands while the runner is reconciled', async () => {
    const racing = harness({
      reconcile: async () => {
        racing.bridge.requestStop('ticket-1', 'the operator stopped the ticket')
        const { runnerReport } = await import('./fixtures/prime-bridge-host.ts')
        return { running: false, stop: 'stopped' as const, report: runnerReport() }
      },
    })
    try {
      const segment = reserve(racing)
      await racing.bridge.reconcile(segment.segmentId)
      await racing.bridge.deliver(segment.segmentId)
      expect(racing.calls.verify).toBe(0)
      expect(racing.calls.deliver).toBe(0)
      expect(racing.calls.reports.map(report => report.state)).not.toContain('ready')
    } finally {
      racing.dispose()
    }
  })

  it('publishes nothing when the stop is recorded before the delivery', async () => {
    const segment = reserve(host)
    host.bridge.requestStop('ticket-1', 'the operator stopped the ticket')
    await host.bridge.deliver(segment.segmentId)
    expect(host.calls.verify).toBe(0)
    expect(host.calls.deliver).toBe(0)
    expect(host.calls.reports.map(report => report.state)).not.toContain('ready')
  })

  // The two tests below pin the gap the coordinator still has: a stop that lands while an external action is in
  // flight must stop that action. They fail today and pass once the coordinator consults the stop fence.
  it('starts no runner when the stop lands while the approval is revalidated', async () => {
    const racing = harness({ revalidate: async (current) => { current.bridge.requestStop('ticket-1', 'the operator stopped the ticket') } })
    try {
      const segment = reserve(racing)
      await racing.bridge.launch(segment.segmentId)
      expect(racing.calls.launch).toBe(0)
      expect(racing.calls.quotaInstall).toBe(0)
    } finally {
      racing.dispose()
    }
  })

  it('publishes nothing when the stop lands while the result is verified', async () => {
    const racing = harness({
      verify: async (current) => {
        current.bridge.requestStop('ticket-1', 'the operator stopped the ticket')
        const { runnerReport, verification } = await import('./fixtures/prime-bridge-host.ts')
        return { runner: runnerReport(), verification: verification() }
      },
    })
    try {
      const segment = reserve(racing)
      await racing.bridge.deliver(segment.segmentId)
      expect(racing.calls.deliver).toBe(0)
      expect(racing.calls.reports.map(report => report.state)).not.toContain('ready')
    } finally {
      racing.dispose()
    }
  })

  it('keeps the stop intent and the reservation when a launch races the stop', async () => {
    const racing = harness({ revalidate: async (current) => { current.bridge.requestStop('ticket-1', 'the operator stopped the ticket') } })
    try {
      const segment = reserve(racing)
      await racing.bridge.launch(segment.segmentId)
      const stored = racing.store.bridge.segments.get(segment.segmentId)
      expect(stored?.stopRequested).toBe(true)
      expect(stored?.stopEpoch).toBe(1)
      expect(stored?.phase).not.toBe('running')
      expect(racing.store.bridge.segments.current()?.segmentId).toBe(segment.segmentId)
    } finally {
      racing.dispose()
    }
  })

  it('keeps the stop intent when a delivery races the stop', async () => {
    const racing = harness({
      verify: async (current) => {
        current.bridge.requestStop('ticket-1', 'the operator stopped the ticket')
        const { runnerReport, verification } = await import('./fixtures/prime-bridge-host.ts')
        return { runner: runnerReport(), verification: verification() }
      },
    })
    try {
      const segment = reserve(racing)
      await racing.bridge.deliver(segment.segmentId)
      const stored = racing.store.bridge.segments.get(segment.segmentId)
      expect(stored?.stopRequested).toBe(true)
      expect(stored?.phase).not.toBe('ready')
      expect(racing.store.bridge.segments.current()?.segmentId).toBe(segment.segmentId)
    } finally {
      racing.dispose()
    }
  })

  it('drops a phase write that follows a stop', () => {
    const segment = reserve(host)
    host.bridge.requestStop('ticket-1', 'the operator stopped the ticket')
    const stale = host.store.bridge.segments.get(segment.segmentId)!
    host.store.bridge.segments.save({ ...stale, phase: 'running', stopEpoch: stale.stopEpoch - 1 })
    expect(host.store.bridge.segments.get(segment.segmentId)?.phase).toBe('stopping')
    expect(host.store.bridge.segments.get(segment.segmentId)?.stopRequested).toBe(true)
  })

  it('fences an action whose stop epoch moved while it was in flight', async () => {
    const segment = reserve(host)
    const fence = stopFence(id => host.store.bridge.segments.get(id), segment.segmentId, segment.stopEpoch)
    expect(fence.fenced()).toBe(false)
    const outcome = await fence.run(async () => {
      host.bridge.requestStop('ticket-1', 'the operator stopped the ticket')
      return 'launched'
    })
    expect(outcome.ran).toBe(false)
    expect(outcome.value).toBeUndefined()
  })

  it('fences an action of a segment that was stopped before it began', async () => {
    const segment = reserve(host)
    host.bridge.requestStop('ticket-1', 'the operator stopped the ticket')
    const fence = stopFence(id => host.store.bridge.segments.get(id), segment.segmentId, segment.stopEpoch)
    expect(fence.fenced()).toBe(true)
    const outcome = await fence.run(async () => 'launched')
    expect(outcome.ran).toBe(false)
  })

  it('fences every new external action of a stopped segment', () => {
    const segment = reserve(host)
    expect(externalActionFenced(segment)).toBe(false)
    host.bridge.requestStop('ticket-1', 'the operator stopped the ticket')
    expect(externalActionFenced(host.store.bridge.segments.get(segment.segmentId)!)).toBe(true)
  })
})

describe('the confirmation of a stop', () => {
  it('keeps the reservation and the quota guard while the stop is unconfirmed', async () => {
    const racing = harness({ stop: 'unconfirmed' })
    try {
      const segment = reserve(racing)
      racing.bridge.requestStop('ticket-1', 'the operator stopped the ticket')
      const verdict = await racing.bridge.stopSegment(segment.segmentId, 'the operator stopped the ticket')
      expect(verdict).toBe('unconfirmed')
      expect(racing.store.bridge.segments.current()?.segmentId).toBe(segment.segmentId)
      expect(racing.store.bridge.segments.get(segment.segmentId)?.phase).toBe('unknown')
      expect(racing.calls.quotaRelease).toBe(0)
      expect(racing.calls.cleanup).toBe(0)
      expect(racing.store.bridge.failures.byTicket('ticket-1').map(failure => failure.cause)).toContain('stop')
    } finally {
      racing.dispose()
    }
  })

  it('keeps the reservation and the quota guard while the stop is unknown', async () => {
    const racing = harness({ stop: 'unknown' })
    try {
      const segment = reserve(racing)
      racing.bridge.requestStop('ticket-1', 'the operator stopped the ticket')
      const verdict = await racing.bridge.stopSegment(segment.segmentId, 'the operator stopped the ticket')
      expect(verdict).toBe('unknown')
      expect(racing.store.bridge.segments.current()?.segmentId).toBe(segment.segmentId)
      expect(racing.calls.quotaRelease).toBe(0)
      expect(racing.calls.cleanup).toBe(0)
    } finally {
      racing.dispose()
    }
  })

  it('releases the reservation and the quota guard once the stop is confirmed', async () => {
    const segment = reserve(host)
    host.bridge.requestStop('ticket-1', 'the operator stopped the ticket')
    const verdict = await host.bridge.stopSegment(segment.segmentId, 'the operator stopped the ticket')
    expect(verdict).toBe('stopped')
    expect(host.store.bridge.segments.current()).toBeUndefined()
    expect(host.calls.quotaRelease).toBe(1)
    expect(host.calls.cleanup).toBe(1)
  })

  it('never claims a confirmed stop when the runner could not be stopped', async () => {
    const racing = harness({ stop: 'unconfirmed' })
    try {
      const segment = reserve(racing)
      racing.bridge.requestStop('ticket-1', 'the operator stopped the ticket')
      await racing.bridge.stopSegment(segment.segmentId, 'the operator stopped the ticket')
      const summary = racing.store.bridge.failures.byTicket('ticket-1').map(failure => failure.summary).join(' ')
      expect(summary).toMatch(/not confirmed stopped/)
      expect(summary).not.toMatch(/\bwas confirmed stopped\b/)
    } finally {
      racing.dispose()
    }
  })
})
