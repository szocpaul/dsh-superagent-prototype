import { describe, expect, it } from 'vitest'
import { buildLaunchInvocation, segmentGoal, segmentPrompt, DEFAULT_LIMITS } from '../src/executor/prime-launch.ts'
import { runCredential } from '../src/app/prime-service.ts'
import type { ApprovedManifest } from '../src/executor/prime-model.ts'

const manifest = {
  environment: {
    runner: { cli: 'prime-agent', version: '0.10.1' },
    model: { provider: 'minimax', id: 'MiniMax-M3.1-Flash' },
    isolation: { backend: 'bubblewrap', writablePaths: [], network: 'none', allowedEndpoints: [] },
    credentials: [],
    quota: { warnTokens: 0, stopTokens: 0, maxWallMs: 0, meteringScope: 'session' },
    digest: 'd',
  },
  checks: [{ name: 'focused', argv: ['pnpm', 'exec', 'vitest', 'run', 'tests/prime-*.spec.ts'], cwd: '.', timeoutMs: 60_000 }],
} as unknown as ApprovedManifest

describe('the bounded autonomous invocation', () => {
  it('builds the vector from the approved manifest, not from free text', () => {
    const invocation = buildLaunchInvocation(manifest, {
      taskIds: ['T010', 'T011'],
      nextGateId: 'T012',
      barrier: { path: '/tmp/barrier', release: 'seg:1' },
      reportPath: '/tmp/runner-report.md',
    })
    expect(invocation.argv[0]).toBe('prime-agent')
    expect(invocation.argv).toContain('--autonomous')
    expect(invocation.argv).toContain('--goal')
    expect(invocation.argv.filter(part => part === '--autonomous-gate')).toHaveLength(1)
    const gate = invocation.argv[invocation.argv.indexOf('--autonomous-gate') + 1]
    expect(gate).toContain('vitest')
    expect(gate).toContain('tests/prime-*.spec.ts')
  })

  it('names the approved model, so the run uses the model the operator approved', () => {
    const invocation = buildLaunchInvocation(manifest, { taskIds: ['T010'], barrier: { path: '/b', release: 'r' }, reportPath: '/tmp/runner-report.md' })
    expect(invocation.argv[invocation.argv.indexOf('--provider') + 1]).toBe('minimax')
    expect(invocation.argv[invocation.argv.indexOf('--model') + 1]).toBe('MiniMax-M3.1-Flash')
  })

  it('gives the run only the credential the deployment approved, and never a value of its own', () => {
    const name = process.env.DSH_PRIME_CREDENTIAL_ENV
    const previous = process.env.DSH_PRIME_CREDENTIAL_ENV
    const value = process.env['DSH_PRIME_TEST_KEY']
    process.env.DSH_PRIME_CREDENTIAL_ENV = 'DSH_PRIME_TEST_KEY'
    process.env['DSH_PRIME_TEST_KEY'] = 'a-secret'
    try {
      expect(runCredential()).toEqual({ DSH_PRIME_TEST_KEY: 'a-secret' })
      delete process.env['DSH_PRIME_TEST_KEY']
      expect(runCredential()).toEqual({})
    } finally {
      if (previous === undefined) delete process.env.DSH_PRIME_CREDENTIAL_ENV
      else process.env.DSH_PRIME_CREDENTIAL_ENV = previous
      if (value !== undefined) process.env['DSH_PRIME_TEST_KEY'] = value
      else delete process.env['DSH_PRIME_TEST_KEY']
    }
  })

  it('bounds the goal to the approved task range and the human gate', () => {
    const goal = segmentGoal(manifest, ['T010', 'T011'], 'T012')
    expect(goal).toContain('T010')
    expect(goal).toContain('T011')
    expect(goal).toContain('T012')
    expect(goal).toContain('stop at the human gate')
  })

  it('names no gate when the segment has none', () => {
    expect(segmentGoal(manifest, ['T010'], undefined)).toContain('end of the approved segment')
  })

  it('uses the default limits when the manifest approves none', () => {
    const invocation = buildLaunchInvocation(manifest, { taskIds: [], barrier: { path: '/b', release: 'r' }, reportPath: '/tmp/runner-report.md' })
    const turns = invocation.argv[invocation.argv.indexOf('--autonomous-max-turns') + 1]
    expect(turns).toBe(String(DEFAULT_LIMITS.maxTurns))
  })

  it('states the constraints the runner must not break', () => {
    const prompt = segmentPrompt({
      featureDir: 'specs/001-prime-runner-bridge',
      taskIds: ['T010'],
      nextGateId: 'T012',
      reportPath: 'specs/001-prime-runner-bridge/runner-report.md',
      barrierPath: '/tmp/barrier',
    })
    expect(prompt).toContain('approved scope')
    expect(prompt).toContain('MANUAL GATE')
    expect(prompt).toContain('never improvise a substitute')
    expect(prompt).toContain('never poll in consecutive turns')
    expect(prompt).toContain('/tmp/barrier')
    expect(prompt).toContain('runner-report.md')
    expect(prompt).toContain('T012')
  })

  it('never names a task outside the approved range', () => {
    const prompt = segmentPrompt({
      featureDir: 'specs/x', taskIds: ['T010', 'T011'], nextGateId: 'T012',
      reportPath: 'r.md', barrierPath: '/b',
    })
    expect(prompt).toContain('T010 through T011')
    expect(prompt).not.toContain('T013')
  })
})
