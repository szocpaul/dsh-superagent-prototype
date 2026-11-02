/** The human gate of the Prime Runner Bridge: the bounded segment, the one question, the evidence, and the next segment. */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { digest, manifestDigest } from '../src/executor/prime-manifest.ts'
import type { ApprovedManifest } from '../src/executor/prime-model.ts'
import { parseTasks, scopeViolations, type TaskLine } from '../src/executor/prime-tasks.ts'
import { GateError, gateAssessmentScope, gateDecisionCandidate, gateDecisionRequest, gateEvidence, gateQuestion,
  gateSegment, gateWait, nextSegment, type GateEvent } from '../src/executor/prime-gate.ts'

const fixture = (name: string): string => readFileSync(fileURLToPath(new URL(`./fixtures/prime-bridge/${name}`, import.meta.url)), 'utf8')
const digests = JSON.parse(fixture('digests.json')) as Record<string, string>

/** A manifest built from the pinned fixture digests, so the fixture cannot drift without the test noticing. */
function manifest(overrides: Partial<ApprovedManifest> = {}): ApprovedManifest {
  const environment = {
    deploymentId: 'deployment-fixture',
    runner: { cli: 'prime-agent', version: '0.10.1' },
    model: { provider: 'fixture', id: 'fixture-model' },
    isolation: { backend: 'bubblewrap' as const, writablePaths: ['src/fixture.ts'], network: 'none' as const, allowedEndpoints: [] },
    credentials: ['model-api'],
    quota: { warnTokens: 1000, stopTokens: 2000, maxWallMs: 600000, meteringScope: 'session' },
  }
  const value = {
    schemaVersion: 1 as const,
    repository: { id: 4242, fullName: 'example/fixture' },
    featureDir: 'specs/001-fixture',
    baselineCommit: 'a'.repeat(40),
    artifacts: { specSha256: digests['baseline-spec.md']!, planSha256: digests['baseline-plan.md']!, tasksSha256: digests['tasks-gate.md']!,
      constitutionSha256: null, guidanceSha256: digests['guidance.md']!, hooksSha256: digests['hooks.yml']!, treeSha256: digests['check.sh']! },
    allowedPaths: ['src/fixture.ts'],
    tasks: [{ id: 'T001', kind: 'automated' as const, order: 0, text: 'Set up the fixture workspace' }],
    checks: [{ name: 'fixture-check', argv: ['pnpm', 'test'], cwd: '.', timeoutMs: 60000 }],
    environment: { ...environment, digest: '' },
    ...overrides,
  }
  const withDigest = { ...value, environment: { ...environment, digest: digest(environment as never) } }
  return withDigest as unknown as ApprovedManifest
}

const approved = parseTasks(fixture('tasks-gate.md'))
const GATE = 'T003'
const COMMIT = 'b'.repeat(40)

/** The gate approval the human's bound decision produces. */
const approval = (over: Partial<Parameters<typeof nextSegment>[2] & object> = {}) => ({
  approvalId: 'approval-1', kind: 'gate' as const, manifestId: manifest().environment.digest,
  manifestSha256: manifestDigest(manifest()), ticketId: 'ticket-1', triggerId: 'trigger-1', policyVersion: 'policy-1',
  repositoryId: 4242, commentId: 'comment-1', commentSha256: 'c'.repeat(64),
  actor: { id: 7, login: 'octocat', type: 'User' as const }, at: '2026-11-01T00:00:00.000Z',
  environmentApproved: true, decision: 'approved' as const, gateId: GATE, gateCommit: COMMIT, ...over,
})

describe('the bounded segment before a gate', () => {
  it('stops before the gate and names it', () => {
    const bounded = gateSegment(approved)
    expect(bounded.segment.map(task => task.id)).toEqual(['T001', 'T002'])
    expect(bounded.gate?.id).toBe(GATE)
    expect(bounded.later.map(task => task.id)).toEqual(['T004'])
  })

  it('leaves the gate task and every later task untouched while the run waits', () => {
    const done = approved.map(task => task.id === 'T001' || task.id === 'T002' ? { ...task, checked: true } : task)
    expect(scopeViolations(approved, done)).toEqual([])
    expect(done.find(task => task.id === GATE)?.checked).toBe(false)
    expect(done.find(task => task.id === 'T004')?.checked).toBe(false)
    const ticked = done.map(task => task.id === GATE ? { ...task, checked: true } : task)
    expect(scopeViolations(approved, ticked)).toEqual([{ id: GATE, reason: 'a human gate may only be completed by a person' }])
  })
})

describe('the question the operator receives', () => {
  it('names the gate, the manifest digest, and what the reviewer has to do', () => {
    const question = gateQuestion(approved[2]!, manifest())
    expect(question).toContain(GATE)
    expect(question).toContain(manifestDigest(manifest()))
    expect(question).toContain(`APPROVE GATE ${GATE} ${manifestDigest(manifest())}`)
    expect(question).toContain('[ ]')
    expect(question).toContain('[x]')
    expect(question).toMatch(/bound to your own/i)
  })
})

describe('the evidence of a gate', () => {
  const evidence = gateEvidence({
    gate: approved[2]!,
    manifest: manifest(),
    question: gateQuestion(approved[2]!, manifest()),
    result: { resultRevision: 'd'.repeat(40), completedTaskIds: ['T001', 'T002'], remainingTaskIds: [GATE, 'T004'],
      checks: [{ name: 'fixture-check', exitCode: 0, evidence: 'checks/fixture.log' }], summary: 'The segment is done.' },
    stop: { confirmed: true, verdict: 'stopped' },
    draftPr: { number: 12, url: 'https://example.invalid/pull/12' },
  })

  it('keeps the gate identity, the question, the result evidence, and the stop confirmation', () => {
    expect(evidence.gateId).toBe(GATE)
    expect(evidence.question).toContain(GATE)
    expect(evidence.result.completedTaskIds).toEqual(['T001', 'T002'])
    expect(evidence.stop).toEqual({ confirmed: true, verdict: 'stopped' })
    expect(evidence.ticketState).toBe('waiting')
  })

  it('binds the draft pull request, presents the evidence, and never marks the ticket or feature ready', () => {
    expect(evidence.draftPr?.draft).toBe(true)
    expect(evidence.draftPr?.body).toContain(GATE)
    expect(evidence.draftPr?.body).toContain('fixture-check')
    expect(evidence.draftPr?.body).toMatch(/not ready/i)
    expect(Object.keys(evidence)).not.toContain('ready')
  })
})

describe('the decision request', () => {
  it('goes to the original conversation', () => {
    const request = gateDecisionRequest(approved[2]!, manifest())
    expect(request.channel).toBe('original-conversation')
    expect(request.gateId).toBe(GATE)
    expect(request.text).toContain(`APPROVE GATE ${GATE}`)
  })

  it('keeps the evidence available and the continuation blocked when the conversation is unreachable', () => {
    const request = gateDecisionRequest(approved[2]!, manifest())
    const evidence = gateEvidence({
      gate: approved[2]!, manifest: manifest(), question: request.text,
      result: { completedTaskIds: ['T001'], remainingTaskIds: [GATE], checks: [], summary: 'done' },
      stop: { confirmed: true, verdict: 'stopped' },
    })
    const wait = gateWait(request, evidence, { delivered: false, reason: 'the conversation could not be reached' })
    expect(wait.status).toBe('attention')
    expect(wait.evidence).toBe(evidence)
    expect(wait.continuationBlocked).toBe(true)
    expect(nextSegment(approved, GATE, undefined).ok).toBe(false)
  })
})

describe('the next segment', () => {
  /** The task list after the human marked the gate complete in their own edit. */
  const afterHuman = approved.map(task => task.id === GATE ? { ...task, checked: true } : task)

  it('covers only the work after the gate', () => {
    const result = nextSegment(afterHuman, GATE, approval())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.segment.map(task => task.id)).toEqual(['T004'])
  })

  it('stops before the next gate', () => {
    const two: TaskLine[] = [...afterHuman, { id: 'T005', kind: 'human', order: 4, checked: false, line: 9, text: 'Review again', tags: [] }]
    const result = nextSegment(two, GATE, approval())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.segment.map(task => task.id)).toEqual(['T004'])
    expect(result.gate?.id).toBe('T005')
  })

  it('needs an approved, verified, and bound decision', () => {
    expect(nextSegment(afterHuman, GATE, undefined).ok).toBe(false)
    expect(nextSegment(afterHuman, GATE, approval({ decision: 'denied' })).ok).toBe(false)
    expect(nextSegment(afterHuman, GATE, approval({ kind: 'run' })).ok).toBe(false)
    expect(nextSegment(afterHuman, GATE, approval({ gateId: 'T009' })).ok).toBe(false)
    expect(nextSegment(afterHuman, GATE, approval({ gateCommit: undefined })).ok).toBe(false)
    expect(nextSegment(afterHuman, GATE, approval({ manifestSha256: 'not-a-digest' })).ok).toBe(false)
    expect(nextSegment(afterHuman, GATE, approval({ actor: { id: 9, login: 'stranger', type: 'Bot' } })).ok).toBe(false)
  })

  it('needs the human to have marked the gate complete', () => {
    const unchecked = approved.map(task => task.id === GATE ? { ...task, checked: false } : task)
    expect(nextSegment(unchecked, GATE, approval()).ok).toBe(false)
    expect(nextSegment(afterHuman, GATE, approval()).ok).toBe(true)
  })
})

describe('the events that are never a gate approval', () => {
  it('refuses a generic wake, a bot comment, a report, and a pull request review', () => {
    const wake: GateEvent = { kind: 'wake' }
    const bot: GateEvent = { kind: 'comment', actor: { id: 9, login: 'robot', type: 'Bot' },
      text: `@dsh-agent APPROVE GATE ${GATE} ${manifestDigest(manifest())} ${COMMIT}` }
    const report: GateEvent = { kind: 'report', text: `APPROVE GATE ${GATE} ${manifestDigest(manifest())} ${COMMIT}` }
    const review: GateEvent = { kind: 'pull-request-review', reviewState: 'approved',
      actor: { id: 7, login: 'octocat', type: 'User' } }
    expect(gateDecisionCandidate(wake).candidate).toBe(false)
    expect(gateDecisionCandidate(bot).candidate).toBe(false)
    expect(gateDecisionCandidate(report).candidate).toBe(false)
    expect(gateDecisionCandidate(review).candidate).toBe(false)
    const human: GateEvent = { kind: 'comment', actor: { id: 7, login: 'octocat', type: 'User' },
      text: `@dsh-agent APPROVE GATE ${GATE} ${manifestDigest(manifest())} ${COMMIT}` }
    expect(gateDecisionCandidate(human).candidate).toBe(true)
  })
})

describe('the assessment before a gate', () => {
  it('covers only the segment and records the later tasks as not assessed', () => {
    const scope = gateAssessmentScope(approved)
    expect(scope.scope).toBe('segment')
    expect(scope.assessedTaskIds).toEqual(['T001', 'T002'])
    expect(scope.notAssessedTaskIds).toEqual([GATE, 'T004'])
    expect(scope.findingsAreProposals).toBe(true)
  })

  it('covers the whole scope when the approved list has no gate', () => {
    const scope = gateAssessmentScope(parseTasks(fixture('tasks-no-gate.md')))
    expect(scope.scope).toBe('full')
    expect(scope.notAssessedTaskIds).toEqual([])
  })
})

describe('the gate record', () => {
  it('refuses evidence that belongs to another gate', () => {
    const request = gateDecisionRequest(approved[2]!, manifest())
    const evidence = gateEvidence({
      gate: approved[2]!, manifest: manifest(), question: request.text,
      result: { completedTaskIds: ['T001'], remainingTaskIds: [GATE], checks: [], summary: 'done' },
      stop: { confirmed: true, verdict: 'stopped' },
    })
    const other = { ...request, gateId: 'T009' }
    expect(() => gateWait(other, evidence, { delivered: true })).toThrow(GateError)
  })
})

describe('the revision a gate commit must sit on', () => {
  it('is the revision the controller published for the run, not the revision from before it', async () => {
    const host = harness()
    const segment = reserve(host)
    host.store.bridge.segments.save({ ...segment, phase: 'gate_wait', nextGateId: 'T001' })
    host.store.bridge.reports.save(segment.segmentId, {
      schemaVersion: 1,
      runner: { ...runnerReport(), segmentId: segment.segmentId },
      verification: { ...verification(), resultRevision: 'f'.repeat(40) },
    })
    await host.bridge.awaitGate(segment.segmentId)
    expect(host.calls.gateParent).toBe('f'.repeat(40))
    host.dispose()
  })
})
describe('the continuation past a gate', () => {
  /** The gated segment and the continuation that the approved gate decision produces. */
  const continuePastGate = async () => {
    const gated = manifest({
      tasks: [
        { id: 'T001', kind: 'automated', order: 0, text: 'Do the thing' },
        { id: 'T002', kind: 'human', order: 1, text: 'MANUAL GATE - Review the change' },
        { id: 'T003', kind: 'automated', order: 2, text: 'Run the check' },
      ],
    })
    const decision = {
      approvalId: 'gate-1', kind: 'gate' as const, manifestId: manifestDigest(gated), manifestSha256: manifestDigest(gated),
      ticketId: 'ticket-1', triggerId: 'trigger-1', policyVersion: 'policy-1', repositoryId: 4242,
      commentId: 'comment-1', commentSha256: 'c'.repeat(64),
      actor: { id: 7, login: 'octocat', type: 'User' as const }, at: '2026-11-01T00:00:00.000Z',
      environmentApproved: true, decision: 'approved' as const, gateId: 'T002', gateCommit: 'b'.repeat(40),
    }
    const host = harness({ manifest: () => gated, gateApproval: () => decision, gateDecision: () => decision })
    const segment = reserve(host)
    host.store.bridge.segments.save({ ...segment, phase: 'gate_wait', nextGateId: 'T002', taskIds: ['T001'] })
    await host.bridge.awaitGate(segment.segmentId)
    const segments = host.store.bridge.segments.byTicket('ticket-1')
    return { host, segments, segment }
  }

  it('ends the gated segment and reserves the next one, so the runner slot is free for it', async () => {
    const { host, segments, segment } = await continuePastGate()
    expect(segments.find(item => item.segmentId === segment.segmentId)?.phase).toBe('stopped')
    const next = segments.find(item => item.segmentId !== segment.segmentId)
    expect(next?.taskIds).toEqual(['T003'])
    // The continuation holds the runner slot; the gated segment released it.
    expect(host.store.bridge.segments.current()?.segmentId).toBe(next?.segmentId)
    host.dispose()
  })

  it('builds the continuation on the commit the human made for the gate', async () => {
    const { host, segments, segment } = await continuePastGate()
    const next = segments.find(item => item.segmentId !== segment.segmentId)
    // The gate commit sits on the branch of the run, so it is the revision the continuation has to build on.
    expect(next?.baseRevision).toBe('b'.repeat(40))
    expect(next?.baseRevision).not.toBe(segment.baseRevision)
    host.dispose()
  })
})

import { harness, reserve, runnerReport, verification } from './fixtures/prime-bridge-host.ts'
