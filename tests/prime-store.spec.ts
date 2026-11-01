/** Durable bridge records in the Store: the single runner reservation, its records, and the bridge effects. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Effects, enqueueBridgeEffect } from '../src/app/effects.ts'
import { BridgeReservationError, Store } from '../src/app/store.ts'
import { HealthBoard } from '../src/infra/health.ts'
import type { ApprovalRecord, BridgeReport, BridgeSegment, FailureRecord, SegmentPhase } from '../src/executor/prime-model.ts'
import { deferred } from './fixtures/async.ts'

let directory: string
let store: Store
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'prime-store-')); store = new Store(join(directory, 'db.sqlite')) })
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })

const segment = (segmentId: string, phase: SegmentPhase = 'reserved', generation = 1): BridgeSegment => ({
  segmentId, ticketId: 'ticket-1', assignmentId: 'assignment-1', generation, manifestId: 'manifest-1', phase,
  stopEpoch: 0, stopRequested: false, taskIds: ['T001', 'T002'], nextGateId: null,
  runner: { serviceUnit: 'prime.service', cgroup: 'prime.slice', tmux: 'prime-tmux', socket: '/run/prime.sock',
    workspace: '/tmp/workspace', branch: 'dsh/ticket-1' },
  quotaGuardId: 'quota-1', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z',
})

const approval = (approvalId: string): ApprovalRecord => ({
  approvalId, kind: 'run', manifestId: 'manifest-1', manifestSha256: 'a'.repeat(64), ticketId: 'ticket-1',
  triggerId: 'trigger-1', policyVersion: 'policy-1', repositoryId: 42, commentId: 'comment-1',
  commentSha256: 'b'.repeat(64), actor: { id: 7, login: 'octocat', type: 'User' },
  at: '2026-11-01T00:00:00.000Z', environmentApproved: true, decision: 'approved',
})

const report = (): BridgeReport => ({
  schemaVersion: 1,
  runner: {
    schemaVersion: 1, ticketId: 'ticket-1', assignmentId: 'assignment-1', segmentId: 'segment-1', generation: 1,
    stopEpoch: 0, manifestSha256: 'a'.repeat(64), baselineRevision: 'c'.repeat(40), outcome: 'complete',
    workspaceSnapshotSha256: 'd'.repeat(64), completedTaskIds: ['T001'], remainingTaskIds: [], nextGateId: null,
    checks: [{ name: 'typecheck', exitCode: 0, evidence: 'evidence/typecheck.log' }],
    convergence: { rounds: 1, status: 'converged' }, summary: 'done', risksAndBlockers: [],
  },
})

it('reserves the runner slot for one segment and refuses a second one', () => {
  const first = segment('segment-1')
  expect(store.bridge.reserve(first)).toEqual(first)
  expect(store.bridge.segments.current()?.segmentId).toBe('segment-1')
  expect(() => store.bridge.reserve(segment('segment-2'))).toThrow(BridgeReservationError)
  expect(() => store.bridge.reserve(segment('segment-2'))).toThrow(/runner slot/)
  expect(store.bridge.segments.get('segment-2')).toBeUndefined()
  expect(store.bridge.segments.current()?.segmentId).toBe('segment-1')
})

it('keeps the reservation while the phase is unknown and releases it only on a terminal phase', () => {
  store.bridge.reserve(segment('segment-1', 'running'))
  store.bridge.segments.save(segment('segment-1', 'unknown'))
  expect(store.bridge.segments.current()?.phase).toBe('unknown')
  store.bridge.release('segment-1')
  expect(store.bridge.segments.current()?.phase).toBe('unknown')
  store.bridge.segments.save(segment('segment-1', 'stopped'))
  expect(store.bridge.segments.current()).toBeUndefined()
  expect(() => store.bridge.reserve(segment('segment-2'))).not.toThrow()
})

it('keeps the segment, the approval, the report and the reservation across a reopen', () => {
  const first = segment('segment-1')
  store.bridge.reserve(first)
  store.bridge.approvals.save(approval('approval-1'))
  store.bridge.reports.save('segment-1', report())
  store.close()
  store = new Store(join(directory, 'db.sqlite'))
  expect(store.bridge.segments.get('segment-1')).toEqual(first)
  expect(store.bridge.segments.current()?.segmentId).toBe('segment-1')
  expect(store.bridge.approvals.get('approval-1')).toEqual(approval('approval-1'))
  expect(store.bridge.approvals.byTicket('ticket-1')).toEqual([approval('approval-1')])
  expect(store.bridge.reports.get('segment-1')).toEqual(report())
})

it('keeps the reservation after a crash between reserving and releasing', () => {
  store.bridge.reserve(segment('segment-1', 'running'))
  store.close()
  store = new Store(join(directory, 'db.sqlite'))
  expect(store.bridge.segments.current()?.segmentId).toBe('segment-1')
  expect(store.bridge.segments.byTicket('ticket-1')).toHaveLength(1)
})

it('does not overwrite a newer segment with a stale generation', () => {
  store.bridge.reserve(segment('segment-1', 'running', 2))
  store.bridge.segments.save(segment('segment-1', 'stopped', 1))
  expect(store.bridge.segments.get('segment-1')?.generation).toBe(2)
  expect(store.bridge.segments.get('segment-1')?.phase).toBe('running')
})

it('does not overwrite a newer segment with a stale stop epoch', () => {
  store.bridge.reserve({ ...segment('segment-1', 'running'), stopEpoch: 2 })
  store.bridge.segments.save({ ...segment('segment-1', 'stopped'), stopEpoch: 1 })
  expect(store.bridge.segments.get('segment-1')?.stopEpoch).toBe(2)
  expect(store.bridge.segments.get('segment-1')?.phase).toBe('running')
})

it('keeps a failure record with its ticket', () => {
  const failure: FailureRecord & { id: string; ticketId: string } = {
    id: 'failure-1', ticketId: 'ticket-1', cause: 'preflight', summary: 'the runner CLI is missing',
    evidence: 'evidence/preflight.log', nextAction: 'install the runner CLI', at: '2026-11-01T00:00:00.000Z',
  }
  store.bridge.failures.save(failure)
  expect(store.bridge.failures.byTicket('ticket-1')).toMatchObject([{ cause: 'preflight', summary: 'the runner CLI is missing' }])
})

it('runs a duplicated launch effect for the same segment only once', async () => {
  store.bridge.reserve(segment('segment-1'))
  const effects = new Effects(store, new HealthBoard())
  effects.start()
  const hold = deferred()
  const run = vi.fn(async () => { await hold.promise })
  effects.handle('prime-launch', run)
  store.atomic(() => { enqueueBridgeEffect(effects, 'prime-launch', { segmentId: 'segment-1', generation: 1 }) })
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))
  store.atomic(() => { enqueueBridgeEffect(effects, 'prime-launch', { segmentId: 'segment-1', generation: 1 }) })
  hold.resolve()
  await effects.idle()
  expect(run).toHaveBeenCalledTimes(1)
  await effects.drain()
})

it('runs a bridge effect only after its transaction commits, and drops a stale one', async () => {
  store.bridge.reserve(segment('segment-1', 'running', 2))
  const effects = new Effects(store, new HealthBoard())
  effects.start()
  const run = vi.fn(async () => {})
  effects.handle('prime-reconcile', run)
  expect(() => store.atomic(() => {
    enqueueBridgeEffect(effects, 'prime-reconcile', { segmentId: 'segment-1', generation: 2 })
    throw new Error('rolled back')
  })).toThrow('rolled back')
  await effects.idle()
  expect(run).not.toHaveBeenCalled()
  enqueueBridgeEffect(effects, 'prime-reconcile', { segmentId: 'segment-1', generation: 2 })
  await effects.idle()
  expect(run).toHaveBeenCalledTimes(1)
  enqueueBridgeEffect(effects, 'prime-reconcile', { segmentId: 'segment-1', generation: 1 })
  await effects.idle()
  expect(run).toHaveBeenCalledTimes(1)
  await effects.drain()
})
