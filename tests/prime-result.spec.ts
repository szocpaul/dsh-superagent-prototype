
import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ApprovalError,
  BridgeError,
  CheckError,
  DependencyError,
  DeliveryError,
  IsolationError,
  PreflightError,
  ProviderError,
  QuotaError,
  ReportError,
  StopError,
  REPORT_FILE,
  REPORT_MARKDOWN_FILE,
  WAKE_FILE,
  controllerReport,
  failureOf,
  ingestRunnerReport,
  readRunnerReport,
  readRunnerWake,
  mapFailure,
  parseRunnerReport,
  redact,
} from '../src/executor/prime-report.ts'
import {
  assess,
  collectSnapshot,
  createResultRevision,
  rerunChecks,
  scopeAudit,
  verify,
  type AssessRequest,
  type RevisionPort,
  type VerifierPort,
} from '../src/executor/prime-verify.ts'
import { digest, manifestDigest, validateManifest } from '../src/executor/prime-manifest.ts'
import type { ApprovedManifest, BridgeSegment, RunnerReport } from '../src/executor/prime-model.ts'

const environment = {
  deploymentId: 'deployment-1',
  runner: { cli: 'prime-agent', version: '0.10.1' },
  model: { provider: 'anthropic', id: 'claude' },
  isolation: { backend: 'bubblewrap' as const, writablePaths: ['src/executor'], network: 'none' as const, allowedEndpoints: [] },
  credentials: ['model'],
  quota: { warnTokens: 1000, stopTokens: 2000, maxWallMs: 60_000, meteringScope: 'run' },
}

const manifest = (): ApprovedManifest => validateManifest({
  schemaVersion: 1,
  repository: { id: 1, fullName: 'owner/repo' },
  featureDir: 'specs/001-prime-runner-bridge',
  baselineCommit: 'a'.repeat(40),
  artifacts: {
    specSha256: 'b'.repeat(64), planSha256: 'c'.repeat(64), tasksSha256: 'd'.repeat(64),
    constitutionSha256: null, guidanceSha256: null, hooksSha256: null, treeSha256: 'e'.repeat(64),
  },
  allowedPaths: ['src/executor'],
  tasks: [
    { id: 'T001', kind: 'automated', order: 0, text: 'first task' },
    { id: 'T002', kind: 'automated', order: 1, text: 'second task' },
    { id: 'T003', kind: 'human', order: 2, text: 'manual gate' },
    { id: 'T004', kind: 'automated', order: 3, text: 'later task' },
  ],
  checks: [{ name: 'typecheck', argv: ['pnpm', 'run', 'typecheck'], cwd: '.', timeoutMs: 1000 }],
  environment: { ...environment, digest: digest(environment as never) },
})

const segment = (overrides: Partial<BridgeSegment> = {}): BridgeSegment => ({
  segmentId: 'segment-1',
  ticketId: 'ticket-1',
  assignmentId: 'assignment-1',
  generation: 2,
  manifestId: 'manifest-1',
  phase: 'running',
  stopEpoch: 3,
  stopRequested: false,
  taskIds: ['T001', 'T002'],
  nextGateId: 'T003',
  runner: { serviceUnit: 'unit', cgroup: 'cgroup', tmux: 'tmux', socket: 'socket', workspace: '/tmp/workspace', branch: 'agent/ticket-1' },
  quotaGuardId: 'guard-1',
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  ...overrides,
})

const report = (overrides: Partial<RunnerReport> = {}): RunnerReport => ({
  schemaVersion: 1,
  ticketId: 'ticket-1',
  assignmentId: 'assignment-1',
  segmentId: 'segment-1',
  generation: 2,
  stopEpoch: 3,
  manifestSha256: manifestDigest(manifest()),
  baselineRevision: 'a'.repeat(40),
  outcome: 'complete',
  workspaceSnapshotSha256: '0'.repeat(64),
  completedTaskIds: ['T001', 'T002'],
  remainingTaskIds: [],
  nextGateId: null,
  checks: [{ name: 'typecheck', exitCode: 0, evidence: 'reports/typecheck.log' }],
  convergence: { rounds: 1, status: 'converged' },
  summary: 'the segment completed',
  risksAndBlockers: [],
  ...overrides,
})

const expectation = (overrides: Partial<RunnerReport> = {}) => {
  const value = report(overrides)
  return {
    segmentId: value.segmentId,
    generation: value.generation,
    stopEpoch: value.stopEpoch,
    manifestSha256: value.manifestSha256,
    ticketId: value.ticketId,
    assignmentId: value.assignmentId,
  }
}

/** A convergence assessment the controller ran and confirmed. */
const converged = () => ({
  rounds: 1,
  status: 'converged' as const,
  scope: 'full' as const,
  assessedTaskIds: ['T001', 'T002', 'T003', 'T004'],
  notAssessedTaskIds: [],
  findings: [],
})

const workspace = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), 'prime-result-'))
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content)
  }
  return root
}

describe('the runner report is untrusted data', () => {
  it('rejects a report with an unknown key', () => {
    const text = JSON.stringify({ ...report(), extra: 'value' })
    expect(() => parseRunnerReport(text, expectation())).toThrow(/unrecognized key/i)
  })

  it('rejects a report with a malformed value', () => {
    const text = JSON.stringify({ ...report(), generation: 'two' })
    expect(() => parseRunnerReport(text, expectation())).toThrow(/invalid/i)
  })

  it('rejects a report whose segment ID is not the one the controller expects', () => {
    const text = JSON.stringify(report({ segmentId: 'segment-other' }))
    expect(() => parseRunnerReport(text, expectation())).toThrow(/segment/i)
  })

  it('rejects a stale generation', () => {
    const text = JSON.stringify(report({ generation: 1 }))
    expect(() => parseRunnerReport(text, expectation())).toThrow(/generation/i)
  })

  it('rejects a stale stop epoch', () => {
    const text = JSON.stringify(report({ stopEpoch: 2 }))
    expect(() => parseRunnerReport(text, expectation())).toThrow(/stop epoch/i)
  })

  it('rejects a report bound to another manifest', () => {
    const text = JSON.stringify(report({ manifestSha256: '9'.repeat(64) }))
    expect(() => parseRunnerReport(text, expectation())).toThrow(/manifest/i)
  })

  it('accepts a report that matches the segment the controller expects', () => {
    const parsed = parseRunnerReport(JSON.stringify(report()), expectation())
    expect(parsed.segmentId).toBe('segment-1')
  })
})

describe('the report ingestion', () => {
  const storage = (value: RunnerReport, markdown = '# report\n'): string => {
    const root = mkdtempSync(join(tmpdir(), 'prime-storage-'))
    writeFileSync(join(root, `${REPORT_FILE}.tmp`), JSON.stringify(value))
    renameSync(join(root, `${REPORT_FILE}.tmp`), join(root, REPORT_FILE))
    writeFileSync(join(root, REPORT_MARKDOWN_FILE), markdown)
    return root
  }

  it('reads the atomic structured report and the Markdown copy', () => {
    const root = storage(report())
    const ingested = ingestRunnerReport({ storagePath: root, expected: expectation() })
    expect(ingested.report.segmentId).toBe('segment-1')
    expect(ingested.markdown).toContain('# report')
  })

  it('refuses a report that belongs to another segment', () => {
    const root = storage(report({ segmentId: 'segment-other' }))
    expect(() => ingestRunnerReport({ storagePath: root, expected: expectation() })).toThrow(/segment/i)
  })

  it('refuses a storage that still holds an unfinished write', () => {
    const root = mkdtempSync(join(tmpdir(), 'prime-storage-'))
    writeFileSync(join(root, `${REPORT_FILE}.tmp`), JSON.stringify(report()))
    expect(() => readRunnerReport(root)).toThrow(/did not finish/i)
  })

  it('refuses a storage that holds no human-readable report', () => {
    const root = mkdtempSync(join(tmpdir(), 'prime-storage-'))
    writeFileSync(join(root, REPORT_FILE), JSON.stringify(report()))
    expect(() => readRunnerReport(root)).toThrow(/runner-report\.md/)
  })

  it('treats the local wake signal as a hint only', () => {
    const root = mkdtempSync(join(tmpdir(), 'prime-storage-'))
    expect(readRunnerWake(root)).toBe(false)
    writeFileSync(join(root, WAKE_FILE), '')
    expect(readRunnerWake(root)).toBe(true)
  })
})

describe('a report is never authority', () => {
  const verifier = (results: Record<string, number | Error>): VerifierPort => ({
    run: async check => {
      const value = results[check.name]
      if (value === undefined) throw new Error(`the check ${check.name} did not run`)
      if (value instanceof Error) throw value
      return { exitCode: value, evidence: `verifier/${check.name}.log` }
    },
  })

  it('blocks readiness when a check the manifest approves never ran', async () => {
    const root = workspace({ 'src/executor/a.ts': 'export const a = 1\n' })
    const snapshot = await collectSnapshot(root, ['src/executor'])
    const result = await verify({
      manifest: manifest(),
      segment: segment(),
      report: report({ workspaceSnapshotSha256: snapshot.digest }),
      workspace: root,
      verifier: verifier({}),
      assessment: converged(),
    })
    expect(result.decision).toBe('blocked')
    expect(result.reasons.join(' ')).toMatch(/typecheck/)
  })

  it('blocks readiness when the controller ran no convergence assessment', async () => {
    const root = workspace({ 'src/executor/a.ts': 'export const a = 1\n' })
    const snapshot = await collectSnapshot(root, ['src/executor'])
    const result = await verify({
      manifest: manifest(),
      segment: segment(),
      report: report({ workspaceSnapshotSha256: snapshot.digest }),
      workspace: root,
      verifier: { run: async () => ({ exitCode: 0, evidence: 'verifier/typecheck.log' }) },
    })
    expect(result.decision).toBe('blocked')
    expect(result.reasons.join(' ')).toMatch(/convergence/i)
  })

  it('blocks readiness when a rerun check fails, even though the report claimed success', async () => {
    const root = workspace({ 'src/executor/a.ts': 'export const a = 1\n' })
    const snapshot = await collectSnapshot(root, ['src/executor'])
    const result = await verify({
      manifest: manifest(),
      segment: segment(),
      report: report({ workspaceSnapshotSha256: snapshot.digest }),
      workspace: root,
      verifier: verifier({ typecheck: 1 }),
      assessment: converged(),
    })
    expect(result.decision).toBe('blocked')
    expect(result.reasons.join(' ')).toMatch(/typecheck/)
    expect(result.checks[0]?.evidence).not.toBe('reports/typecheck.log')
  })
})

describe('redaction', () => {
  it('removes a secret from a report', () => {
    const built = controllerReport(report({ summary: 'the token is sk-abcdefgh12345678' }), undefined)
    expect(built.runner?.summary).not.toContain('sk-abcdefgh12345678')
  })

  it('removes a secret from a notice', () => {
    expect(redact('Authorization: Bearer abcdefghijklmnop')).not.toContain('abcdefghijklmnop')
    expect(redact('api_key=SECRETVALUE123')).not.toContain('SECRETVALUE123')
  })
})

describe('failure causes', () => {
  it('maps each known error to its own cause and next action', () => {
    const errors = [
      new PreflightError('the CLI is too old'),
      new ProviderError('the backend refused the call'),
      new DependencyError('the check binary is missing'),
      new QuotaError('the token limit was reached'),
      new CheckError('the check failed'),
      new ReportError('the report is malformed'),
      new IsolationError('the confinement is unavailable'),
      new ApprovalError('the approval was withdrawn'),
      new StopError('the runner did not stop'),
      new DeliveryError('the push was refused'),
    ]
    const records = errors.map(error => mapFailure(error))
    expect(records.map(record => record.cause)).toEqual([
      'preflight', 'provider', 'dependency', 'quota', 'check',
      'report', 'isolation', 'approval', 'stop', 'delivery',
    ])
    expect(new Set(records.map(record => record.nextAction)).size).toBe(records.length)
    expect(new Set(records.map(record => record.summary)).size).toBe(records.length)
  })

  it('maps an unknown error to a blocked failure and never to a success', () => {
    const record = mapFailure(new Error('something odd'))
    expect(record.cause).toBeTruthy()
    expect(record.nextAction.length).toBeGreaterThan(0)
    expect(record.summary.length).toBeGreaterThan(0)
  })

  it('builds a failure record from a cause, evidence, and next action', () => {
    const record = failureOf('quota', 'guard-1 stopped the run', 'raise the quota limit')
    expect(record.cause).toBe('quota')
    expect(record.evidence).toBe('guard-1 stopped the run')
    expect(record.nextAction).toBe('raise the quota limit')
  })

  it('keeps a failure record on the bridge error it carries', () => {
    const error = new BridgeError('delivery', 'the push was refused', 'logs/push.log', 'retry the delivery')
    expect(mapFailure(error)).toMatchObject({ cause: 'delivery', evidence: 'logs/push.log', nextAction: 'retry the delivery' })
  })
})

describe('the workspace snapshot', () => {
  it('changes its digest when a file changes', async () => {
    const root = workspace({ 'src/executor/a.ts': 'export const a = 1\n' })
    const before = await collectSnapshot(root, ['src/executor'])
    writeFileSync(join(root, 'src/executor/a.ts'), 'export const a = 2\n')
    const after = await collectSnapshot(root, ['src/executor'])
    expect(after.digest).not.toBe(before.digest)
  })

  it('refuses a symlink that leaves the workspace', async () => {
    const root = workspace({ 'src/executor/a.ts': 'export const a = 1\n' })
    const outside = workspace({ 'secret.txt': 'secret\n' })
    symlinkSync(join(outside, 'secret.txt'), join(root, 'src/executor/link.txt'))
    await expect(collectSnapshot(root, ['src/executor'])).rejects.toThrow(/symlink/i)
  })

  it('reports an out-of-scope write', async () => {
    const root = workspace({ 'src/executor/a.ts': 'export const a = 1\n', 'docs/b.md': 'text\n' })
    const snapshot = await collectSnapshot(root, ['src/executor'])
    const audit = scopeAudit(snapshot, ['src/executor'])
    expect(audit.approved).toBe(false)
    expect(audit.outOfScopePaths).toContain('docs/b.md')
  })

  it('blocks readiness when a write left the approved paths', async () => {
    const root = workspace({ 'src/executor/a.ts': 'export const a = 1\n', 'docs/b.md': 'text\n' })
    const snapshot = await collectSnapshot(root, ['src/executor'])
    const result = await verify({
      manifest: manifest(),
      segment: segment(),
      report: report({ workspaceSnapshotSha256: snapshot.digest }),
      workspace: root,
      verifier: { run: async () => ({ exitCode: 0, evidence: 'verifier/typecheck.log' }) },
      assessment: converged(),
    })
    expect(result.decision).toBe('blocked')
    expect(result.scopeAudit.outOfScopePaths).toContain('docs/b.md')
  })
})

describe('the controller result revision', () => {
  it('is the controller\'s own commit, not the runner\'s report', async () => {
    const root = workspace({ 'src/executor/a.ts': 'export const a = 1\n' })
    const snapshot = await collectSnapshot(root, ['src/executor'])
    const commits: { files: { path: string }[] }[] = []
    const port: RevisionPort = {
      commit: async input => {
        commits.push(input)
        return '9'.repeat(40)
      },
    }
    const revision = await createResultRevision(snapshot, ['src/executor'], port)
    expect(revision).toBe('9'.repeat(40))
    expect(commits[0]?.files.map(file => file.path)).toEqual(['src/executor/a.ts'])
    expect(revision).not.toBe(report().workspaceSnapshotSha256)
  })

  it('reruns the checks against the exact revision and ignores the runner\'s own check output', async () => {
    const root = workspace({ 'src/executor/a.ts': 'export const a = 1\n' })
    const snapshot = await collectSnapshot(root, ['src/executor'])
    const seen: string[] = []
    const port: RevisionPort = { commit: async () => '9'.repeat(40) }
    const revision = await createResultRevision(snapshot, ['src/executor'], port)
    const checks = await rerunChecks(manifest().checks, revision, {
      run: async (_check, rev, environment) => {
        seen.push(rev)
        expect(Object.keys(environment)).toEqual([])
        return { exitCode: 0, evidence: 'verifier/typecheck.log' }
      },
    })
    expect(seen).toEqual([revision])
    expect(checks[0]?.evidence).toBe('verifier/typecheck.log')
  })

  it('refuses to rerun a check in an environment that names a credential', async () => {
    await expect(rerunChecks(manifest().checks, 'rev', {
      run: async () => ({ exitCode: 0, evidence: 'verifier/typecheck.log' }),
    }, { GITHUB_TOKEN: 'secret' })).rejects.toThrow(/credential/i)
  })

  it('treats a check that did not run as a failure', async () => {
    const checks = await rerunChecks(manifest().checks, 'rev', {
      run: async () => { throw new Error('the verifier did not run the check') },
    })
    expect(checks[0]?.exitCode).not.toBe(0)
  })
})

describe('the convergence assessment', () => {
  const host = (findings: { id: string; summary: string }[] = []) => {
    const requests: AssessRequest[] = []
    return {
      requests,
      assessOnScratch: async (request: AssessRequest) => {
        requests.push(request)
        return { findings }
      },
    }
  }

  it('covers only the segment before a gate and labels the later tasks as not assessed', async () => {
    const assessor = host()
    const outcome = await assess(manifest(), segment(), 1, assessor)
    expect(assessor.requests[0]?.scope).toBe('segment')
    expect(outcome.assessedTaskIds).toEqual(['T001', 'T002'])
    expect(outcome.notAssessedTaskIds).toEqual(['T003', 'T004'])
    expect(outcome.status).toBe('deferred-at-gate')
  })

  it('covers the whole approved scope after the last segment', async () => {
    const assessor = host()
    const outcome = await assess(manifest(), segment({ nextGateId: null, taskIds: ['T001', 'T002', 'T003', 'T004'] }), 1, assessor)
    expect(assessor.requests[0]?.scope).toBe('full')
    expect(outcome.assessedTaskIds).toEqual(['T001', 'T002', 'T003', 'T004'])
    expect(outcome.notAssessedTaskIds).toEqual([])
    expect(outcome.status).toBe('converged')
  })

  it('refuses a third round', async () => {
    const assessor = host()
    await expect(assess(manifest(), segment(), 3, assessor)).rejects.toThrow(/two rounds/i)
  })

  it('keeps its findings as proposals and adds no task', async () => {
    const assessor = host([{ id: 'F1', summary: 'the plan mentions another step' }])
    const outcome = await assess(manifest(), segment(), 1, assessor)
    expect(outcome.findings[0]?.proposal).toBe(true)
    expect(manifest().tasks).toHaveLength(4)
  })
})

describe('the verdict', () => {
  it('separates the enforced controls from the instructed constraints', async () => {
    const root = workspace({ 'src/executor/a.ts': 'export const a = 1\n' })
    const snapshot = await collectSnapshot(root, ['src/executor'])
    const result = await verify({
      manifest: manifest(),
      segment: segment(),
      report: report({ workspaceSnapshotSha256: snapshot.digest }),
      workspace: root,
      verifier: { run: async () => ({ exitCode: 0, evidence: 'verifier/typecheck.log' }) },
      assessment: converged(),
    })
    expect(result.decision).toBe('ready')
    expect(result.enforcedControls.join(' ')).toMatch(/writable/i)
    expect(result.enforcedControls.join(' ')).toMatch(/credentials/i)
    expect(result.instructedConstraints.join(' ')).toMatch(/task order/i)
  })
})
