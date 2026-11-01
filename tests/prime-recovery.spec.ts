/**
 * Restart recovery of the Prime Runner Bridge: the coordinator reconciles what it finds before it does anything, an
 * unknown runner keeps the reservation, and a replayed effect never acts twice.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { decideRecovery, type RecoveryObservation } from '../src/executor/prime-recovery.ts'
import type { BridgeSegment } from '../src/executor/prime-model.ts'
import { harness, manifest, reserve, type Harness } from './fixtures/prime-bridge-host.ts'

let host: Harness
beforeEach(() => { host = harness() })
afterEach(() => host.dispose())

/** The segment a recovery observation is built from. */
const segment = (overrides: Partial<BridgeSegment> = {}): BridgeSegment => ({
  segmentId: 'segment-1', ticketId: 'ticket-1', assignmentId: 'assignment-1', generation: 1,
  manifestId: 'manifest-1', phase: 'running', stopEpoch: 0, stopRequested: false,
  taskIds: ['T001'], nextGateId: null,
  runner: { serviceUnit: 'unit', cgroup: 'cgroup', tmux: 'tmux', socket: 'socket', workspace: '/tmp/workspace', branch: 'agent/ticket-1' },
  quotaGuardId: 'guard-1', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', ...overrides,
})

/** A complete observation of a segment that finished normally. */
const observation = (overrides: Partial<RecoveryObservation> = {}): RecoveryObservation => ({
  segment: segment(),
  identityKnown: true,
  runnerRunning: false,
  stop: 'stopped',
  workspace: 'intact',
  guard: 'installed',
  reportPresent: true,
  remote: 'known',
  ticketEnded: false,
  ...overrides,
})

describe('the recovery decision', () => {
  it('delivers a finished run whose state is known', () => {
    const decision = decideRecovery(observation())
    expect(decision.action).toBe('deliver')
    expect(decision.keepReservation).toBe(false)
    expect(decision.nextAction).toBe('')
  })

  it('reconciles an ended Ticket instead of ignoring its run', () => {
    const decision = decideRecovery(observation({ ticketEnded: true }))
    expect(decision.action).toBe('deliver')
    expect(decision.reason).toMatch(/Ticket ended/)
  })

  it('holds a run whose session identity was never persisted', () => {
    const decision = decideRecovery(observation({ identityKnown: false }))
    expect(decision.action).toBe('hold')
    expect(decision.keepReservation).toBe(true)
    expect(decision.keepGuard).toBe(true)
    expect(decision.reason).toMatch(/identity/)
    expect(decision.nextAction).toMatch(/operator/)
  })

  it('holds a run whose runner is still running and keeps the reservation', () => {
    const decision = decideRecovery(observation({ runnerRunning: true }))
    expect(decision.action).toBe('continue')
    expect(decision.keepReservation).toBe(true)
    expect(decision.keepGuard).toBe(true)
  })

  it('holds an orphan runner whose identity the controller cannot establish', () => {
    const decision = decideRecovery(observation({ identityKnown: false, runnerRunning: true }))
    expect(decision.action).toBe('hold')
    expect(decision.keepReservation).toBe(true)
    expect(decision.keepGuard).toBe(true)
    expect(decision.nextAction).toMatch(/identify the runner/)
  })

  it('holds an orphan runner whose stop is not confirmed', () => {
    for (const stop of ['unconfirmed', 'unknown'] as const) {
      const decision = decideRecovery(observation({ stop }))
      expect(decision.action).toBe('stop')
      expect(decision.keepReservation).toBe(true)
      expect(decision.keepGuard).toBe(true)
      expect(decision.reason).toMatch(/not confirmed stopped/)
    }
  })

  it('holds a run whose report was lost', () => {
    const decision = decideRecovery(observation({ reportPresent: false }))
    expect(decision.action).toBe('hold')
    expect(decision.keepReservation).toBe(true)
    expect(decision.reason).toMatch(/report/)
  })

  it('holds a run whose workspace is missing or changed', () => {
    expect(decideRecovery(observation({ workspace: 'missing' })).action).toBe('hold')
    const changed = decideRecovery(observation({ workspace: 'changed' }))
    expect(changed.action).toBe('hold')
    expect(changed.reason).toMatch(/changed/)
  })

  it('holds a run whose remote outcome is unknown or whose push lease was refused', () => {
    const unknown = decideRecovery(observation({ remote: 'unknown' }))
    expect(unknown.action).toBe('hold')
    expect(unknown.reason).toMatch(/unknown/)
    const lease = decideRecovery(observation({ remote: 'lease-failed' }))
    expect(lease.action).toBe('hold')
    expect(lease.reason).toMatch(/lease/)
  })
})

describe('the coordinator after a restart', () => {
  it('finds the segment and its reservation again after a restart', () => {
    const segment = reserve(host)
    host.reopen()
    expect(host.store.bridge.segments.get(segment.segmentId)?.segmentId).toBe(segment.segmentId)
    expect(host.store.bridge.segments.current()?.segmentId).toBe(segment.segmentId)
  })

  it('reconciles a running runner without starting a replacement', async () => {
    const running = harness({ reconcile: () => ({ running: true, stop: 'unconfirmed' as const }) })
    try {
      const segment = reserve(running)
      await running.bridge.reconcile(segment.segmentId)
      expect(running.store.bridge.segments.get(segment.segmentId)?.phase).toBe('running')
      expect(running.store.bridge.segments.current()?.segmentId).toBe(segment.segmentId)
      expect(running.calls.verify).toBe(0)
      expect(running.calls.deliver).toBe(0)
    } finally {
      running.dispose()
    }
  })

  it('holds the reservation while the runner state is unknown', async () => {
    const unknown = harness({ reconcile: () => ({ running: false, stop: 'unknown' as const }) })
    try {
      const segment = reserve(unknown)
      await unknown.bridge.reconcile(segment.segmentId)
      expect(unknown.store.bridge.segments.get(segment.segmentId)?.phase).toBe('unknown')
      expect(unknown.store.bridge.segments.current()?.segmentId).toBe(segment.segmentId)
      expect(unknown.calls.deliver).toBe(0)
      expect(unknown.store.bridge.failures.byTicket('ticket-1').map(failure => failure.cause)).toContain('stop')
    } finally {
      unknown.dispose()
    }
  })

  it('blocks a replacement runner while the state of the segment is unknown', async () => {
    const unknown = harness({ reconcile: () => ({ running: false, stop: 'unknown' as const }) })
    try {
      const segment = reserve(unknown)
      await unknown.bridge.reconcile(segment.segmentId)
      const replacement = unknown.bridge.reserve({
        ticketId: 'ticket-1', assignmentId: 'assignment-2', manifest: manifest(), taskIds: ['T001'],
        nextGateId: null, branch: 'agent/ticket-1', workspace: '/tmp/workspace',
      })
      expect(replacement).toBeUndefined()
    } finally {
      unknown.dispose()
    }
  })

  it('blocks a run whose report was lost and tells the operator what is missing', async () => {
    const lost = harness({ reconcile: () => ({ running: false, stop: 'stopped' as const }) })
    try {
      const segment = reserve(lost)
      await lost.bridge.reconcile(segment.segmentId)
      expect(lost.store.bridge.segments.get(segment.segmentId)?.phase).toBe('blocked')
      const failures = lost.store.bridge.failures.byTicket('ticket-1')
      expect(failures.map(failure => failure.cause)).toContain('report')
      expect(failures.map(failure => failure.nextAction).join(' ')).toMatch(/[Ii]nspect/)
      expect(lost.calls.deliver).toBe(0)
    } finally {
      lost.dispose()
    }
  })

  it('delivers a run whose report arrived after the runner stopped', async () => {
    const { runnerReport } = await import('./fixtures/prime-bridge-host.ts')
    const finished = harness({ reconcile: () => ({ running: false, stop: 'stopped' as const, report: runnerReport() }) })
    try {
      const segment = reserve(finished)
      await finished.bridge.reconcile(segment.segmentId)
      expect(finished.store.bridge.segments.get(segment.segmentId)?.phase).toBe('verifying')
      const rows = finished.store.db.prepare('SELECT kind FROM effect WHERE key=?').all(segment.segmentId)
      expect(rows.map(row => row.kind)).toContain('prime-deliver')
    } finally {
      finished.dispose()
    }
  })

  it('runs a replayed reconcile effect once and delivers once', async () => {
    const { runnerReport } = await import('./fixtures/prime-bridge-host.ts')
    const finished = harness({ reconcile: () => ({ running: false, stop: 'stopped' as const, report: runnerReport() }) })
    try {
      const segment = reserve(finished)
      const runs: number[] = []
      finished.effects.handle('prime-reconcile', async () => { runs.push(1); await finished.bridge.reconcile(segment.segmentId) })
      finished.effects.start()
      finished.effects.enqueueSegment('prime-reconcile', segment.segmentId, 1)
      finished.effects.enqueueSegment('prime-reconcile', segment.segmentId, 1)
      await finished.effects.idle()
      expect(runs).toHaveLength(1)
      const rows = finished.store.db.prepare('SELECT kind FROM effect WHERE key=?').all(segment.segmentId)
      expect(rows.filter(row => row.kind === 'prime-deliver')).toHaveLength(1)
      await finished.effects.drain()
    } finally {
      finished.dispose()
    }
  })

  it('reconciles the segment of an ended Ticket', async () => {
    const unknown = harness({ reconcile: () => ({ running: true, stop: 'unconfirmed' as const }) })
    try {
      const segment = reserve(unknown)
      unknown.store.tickets.save({
        id: 'ticket-1', title: 'A ticket', decisionId: 'decision-1', mandate: { id: 'mandate-1' } as never,
        channels: [], assignments: [], inputs: [], undelivered: [],
        ended: { at: '2026-11-01T00:00:00.000Z', by: 'human', outcome: 'stopped' },
        createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z',
        origin: { triggerId: 'trigger-1', triggerIds: ['trigger-1'] },
      })
      await unknown.bridge.reconcile(segment.segmentId)
      expect(unknown.store.bridge.segments.get(segment.segmentId)?.phase).toBe('running')
      expect(unknown.store.bridge.segments.current()?.segmentId).toBe(segment.segmentId)
    } finally {
      unknown.dispose()
    }
  })

  it('keeps the quota guard of a segment whose runner state is unknown', async () => {
    const unknown = harness({ reconcile: () => ({ running: false, stop: 'unknown' as const }) })
    try {
      const segment = reserve(unknown)
      await unknown.bridge.launch(segment.segmentId)
      expect(unknown.calls.quotaInstall).toBe(1)
      await unknown.bridge.reconcile(segment.segmentId)
      expect(unknown.calls.quotaRelease).toBe(0)
      expect(unknown.store.bridge.segments.get(segment.segmentId)?.quotaGuardId).toBe(segment.quotaGuardId)
    } finally {
      unknown.dispose()
    }
  })

  it('reconciles a segment after a lost notification', async () => {
    const { runnerReport } = await import('./fixtures/prime-bridge-host.ts')
    const finished = harness({ reconcile: () => ({ running: false, stop: 'stopped' as const, report: runnerReport() }) })
    try {
      const segment = reserve(finished)
      const runs: number[] = []
      finished.effects.handle('prime-reconcile', async () => { runs.push(1); await finished.bridge.reconcile(segment.segmentId) })
      finished.effects.start()
      // The wake signal of the run never arrived; the low-frequency reconciliation covers it.
      finished.effects.enqueueSegment('prime-reconcile', segment.segmentId, 1)
      await finished.effects.idle()
      expect(runs).toHaveLength(1)
      expect(finished.store.bridge.segments.get(segment.segmentId)?.phase).toBe('verifying')
      await finished.effects.drain()
    } finally {
      finished.dispose()
    }
  })

  // The next test pins the gap the coordinator still has: a segment whose session identity was never persisted must
  // be held, not delivered. It fails today and passes once the coordinator consults the recovery decision.
  it('holds a segment whose session identity was never persisted', async () => {
    const { runnerReport } = await import('./fixtures/prime-bridge-host.ts')
    const crashed = harness({ reconcile: () => ({ running: false, stop: 'stopped' as const, report: runnerReport() }) })
    try {
      const segment = reserve(crashed)
      // The crash happened between the reservation and the launch, so no session identity was ever written.
      crashed.store.bridge.segments.save({ ...segment, phase: 'running' })
      expect(crashed.store.bridge.segments.get(segment.segmentId)?.runner.sessionId).toBeUndefined()
      await crashed.bridge.reconcile(segment.segmentId)
      expect(crashed.store.bridge.segments.get(segment.segmentId)?.phase).toBe('unknown')
      expect(crashed.store.bridge.segments.current()?.segmentId).toBe(segment.segmentId)
    } finally {
      crashed.dispose()
    }
  })

  // The next test pins the gap the coordinator still has: a lost report keeps the reservation, because the operator
  // must resolve it before a replacement starts. It fails today and passes once the coordinator holds the segment.
  it('keeps the reservation while the lost report is unresolved', async () => {
    const lost = harness({ reconcile: () => ({ running: false, stop: 'stopped' as const }) })
    try {
      const segment = reserve(lost)
      await lost.bridge.reconcile(segment.segmentId)
      expect(lost.store.bridge.segments.current()?.segmentId).toBe(segment.segmentId)
      const replacement = lost.bridge.reserve({
        ticketId: 'ticket-1', assignmentId: 'assignment-2', manifest: manifest(), taskIds: ['T001'],
        nextGateId: null, branch: 'agent/ticket-1', workspace: '/tmp/workspace',
      })
      expect(replacement).toBeUndefined()
    } finally {
      lost.dispose()
    }
  })

  it('does not deliver a segment whose stop was requested', async () => {
    const segment = reserve(host)
    host.bridge.requestStop('ticket-1', 'the operator stopped the ticket')
    await host.bridge.reconcile(segment.segmentId)
    expect(host.calls.verify).toBe(0)
    expect(host.calls.deliver).toBe(0)
  })
})
