/**
 * The fake host the coordinator tests share: a real Store and Effects queue, a fake clock, and fake ports for the
 * runner, the verification, the delivery, the quota guard, and the Ticket surface.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effects } from '../../src/app/effects.ts'
import { Store } from '../../src/app/store.ts'
import { HealthBoard } from '../../src/infra/health.ts'
import { PrimeBridge } from '../../src/executor/prime-bridge.ts'
import type { ApprovalRecord, ApprovedManifest, BridgeSegment, RunnerReport, VerificationResult } from '../../src/executor/prime-model.ts'

/** The approved manifest the fake host serves. */
export const manifest = (): ApprovedManifest => ({
  schemaVersion: 1,
  repository: { id: 42, fullName: 'octocat/repo' },
  featureDir: 'specs/001-prime',
  baselineCommit: 'c'.repeat(40),
  artifacts: { specSha256: '1'.repeat(64), planSha256: '2'.repeat(64), tasksSha256: '3'.repeat(64), constitutionSha256: null, guidanceSha256: null, hooksSha256: null, treeSha256: '4'.repeat(64) },
  allowedPaths: ['src/app'],
  tasks: [{ id: 'T001', kind: 'automated', order: 0, text: 'Do the thing' }],
  checks: [{ name: 'typecheck', argv: ['pnpm', 'typecheck'], cwd: '.', timeoutMs: 60000 }],
  environment: {
    deploymentId: 'local', runner: { cli: 'prime-agent', version: '0.10.1' }, model: { provider: 'test', id: 'model' },
    isolation: { backend: 'bubblewrap', writablePaths: ['src/app'], network: 'none', allowedEndpoints: [] },
    credentials: ['model-api'], quota: { warnTokens: 1000, stopTokens: 2000, maxWallMs: 60000, meteringScope: 'session' },
    digest: '5'.repeat(64),
  },
})

/** The runner report the fake verification answers with. */
export const runnerReport = (): RunnerReport => ({
  schemaVersion: 1, ticketId: 'ticket-1', assignmentId: 'assignment-1', segmentId: 'segment-1', generation: 1,
  stopEpoch: 0, manifestSha256: 'a'.repeat(64), baselineRevision: 'c'.repeat(40), outcome: 'complete',
  workspaceSnapshotSha256: 'd'.repeat(64), completedTaskIds: ['T001'], remainingTaskIds: [], nextGateId: null,
  checks: [{ name: 'typecheck', exitCode: 0, evidence: 'evidence/typecheck.log' }],
  convergence: { rounds: 1, status: 'converged' }, summary: 'the segment is done', risksAndBlockers: [],
})

/** The controller's own verification of the runner report. */
export const verification = (): VerificationResult => ({
  reportSha256: 'a'.repeat(64), resultRevision: 'e'.repeat(40),
  checks: [{ name: 'typecheck', exitCode: 0, evidence: 'evidence/typecheck.log' }],
  scopeAudit: { approved: true, outOfScopePaths: [] },
  enforcedControls: ['the writable path boundary'], instructedConstraints: ['the task order inside an allowed path'],
  decision: 'ready', reasons: [], at: '2026-11-01T00:00:00.000Z',
})

/** The fake clock the tests advance by hand. */
export class Clock {
  private value = '2026-11-01T00:00:00.000Z'
  /** The current time of the clock. */
  now = (): string => this.value
  /** Moves the clock one second forward. */
  advance(): void { this.value = '2026-11-01T00:00:01.000Z' }
}

/** What the fake ports recorded. */
export interface Recorder {
  launch: number
  stop: number
  cleanup: number
  quotaInstall: number
  quotaRelease: number
  verify: number
  deliver: number
  notifications: string[]
  reports: { state: string; summary: string; question?: string }[]
}

/** A fresh recorder. */
export const recorder = (): Recorder => ({
  launch: 0, stop: 0, cleanup: 0, quotaInstall: 0, quotaRelease: 0, verify: 0, deliver: 0, notifications: [], reports: [],
})

/** The fake host of one test. */
export interface Harness {
  store: Store
  effects: Effects
  clock: Clock
  calls: Recorder
  bridge: PrimeBridge
  /** Opens the Store again on the same file, as a restart does. */
  reopen(): void
  /** Closes the Store and removes the temporary directory. */
  dispose(): void
}

/** The options one fake host takes. */
export interface HarnessOptions {
  /** The verdict the fake runner gives for a stop. */
  stop?: 'stopped' | 'unconfirmed' | 'unknown'
  /** The state the fake runner reports when it is reconciled. */
  reconcile?: () => { running: boolean; stop: 'stopped' | 'unconfirmed' | 'unknown'; report?: RunnerReport } | Promise<{ running: boolean; stop: 'stopped' | 'unconfirmed' | 'unknown'; report?: RunnerReport }>
  /** The approval port; it may record a stop while it revalidates. */
  revalidate?: (host: Harness) => Promise<void>
  /** The run approval the fake approval port reports; without it, the human has not answered yet. */
  runApproval?: () => ApprovalRecord | undefined
  /** The verification port; it may record a stop while it verifies. */
  verify?: (host: Harness) => Promise<{ runner: RunnerReport; verification: VerificationResult }>
  /** The delivery port; it may record a stop while it delivers. */
  deliver?: (host: Harness) => Promise<{ prNumber?: number; url?: string; draft: boolean; unknown: boolean }>
  /** Whether the delivery port fails instead of answering. */
  deliverError?: Error
  /** The verification port fails instead of answering. */
  verifyError?: Error
}

/** Builds a coordinator over a real Store and Effects queue with fake ports. */
export const harness = (options: HarnessOptions = {}): Harness => {
  const directory = mkdtempSync(join(tmpdir(), 'prime-bridge-'))
  let store = new Store(join(directory, 'db.sqlite'))
  let effects = new Effects(store, new HealthBoard())
  const clock = new Clock()
  const calls = recorder()
  const state = { harness: undefined as unknown as Harness }
  const host = {
    get store() { return store },
    get effects() { return effects },
    approval: {
      revalidate: async () => { await options.revalidate?.(state.harness) },
      gateDecision: async () => undefined,
      findRunApproval: async () => options.runApproval?.(),
      findGateApproval: async () => undefined,
    },
    preflight: { run: async () => ({ ok: true, failures: [] }) },
    runner: {
      launch: async () => { calls.launch++; return { sessionId: 'session-1', sessionFile: '/run/session-1.jsonl' } },
      stop: async () => { calls.stop++; return options.stop ?? 'stopped' },
      reconcile: async () => (await options.reconcile?.()) ?? { running: false, stop: 'stopped' as const },
      cleanup: async () => { calls.cleanup++ },
    },
    verify: {
      verify: async () => {
        calls.verify++
        if (options.verifyError) throw options.verifyError
        if (options.verify) return options.verify(state.harness)
        return { runner: runnerReport(), verification: verification() }
      },
    },
    delivery: {
      deliver: async () => {
        calls.deliver++
        if (options.deliverError) throw options.deliverError
        if (options.deliver) return options.deliver(state.harness)
        return { prNumber: 7, draft: false, unknown: false }
      },
    },
    quota: {
      install: async () => { calls.quotaInstall++ },
      release: async () => { calls.quotaRelease++ },
    },
    tickets: {
      report: (_ticketId: string, report: { state: string; summary: string; question?: string }) => { calls.reports.push(report) },
      notify: (_ticketId: string, text: string) => { calls.notifications.push(text) },
    },
    manifest: () => manifest(),
    now: clock.now,
  }
  const result: Harness = {
    get store() { return store },
    get effects() { return effects },
    clock,
    calls,
    bridge: new PrimeBridge(host as never),
    reopen: () => {
      store.close()
      store = new Store(join(directory, 'db.sqlite'))
      effects = new Effects(store, new HealthBoard())
    },
    dispose: () => {
      store.close()
      rmSync(directory, { recursive: true, force: true })
    },
  }
  state.harness = result
  return result
}

/** Reserves a segment of the fake coordinator. */
export const reserve = (host: Harness, ticketId = 'ticket-1'): BridgeSegment => {
  const segment = host.bridge.reserve({ ticketId, assignmentId: 'assignment-1', manifest: manifest(), taskIds: ['T001'], nextGateId: null, branch: 'agent/ticket-1', workspace: '/tmp/workspace' })
  if (!segment) throw new Error('the segment was not reserved')
  return segment
}
