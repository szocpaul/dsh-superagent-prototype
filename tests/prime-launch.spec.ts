import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { buildLaunchInvocation, segmentGoal, segmentPrompt, DEFAULT_LIMITS } from '../src/executor/prime-launch.ts'
import { runCredential, runnerAdapter, writeRunnerModel, type PrimeServiceDeps } from '../src/app/prime-service.ts'
import type { PrimeSupervisor } from '../src/executor/prime-supervisor.ts'
import type { Commands } from '../src/infra/commands.ts'
import type { ApprovedManifest, BridgeSegment } from '../src/executor/prime-model.ts'

const exec = promisify(execFile)

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

const bindings = {
  ticketId: 'ticket-1',
  assignmentId: 'assignment-1',
  segmentId: 'segment-1',
  generation: 1,
  stopEpoch: 0,
  manifestSha256: 'a'.repeat(64),
  baselineRevision: 'b'.repeat(40),
  outcome: 'gate' as const,
}

describe('the bounded autonomous invocation', () => {
  it('builds the vector from the approved manifest, not from free text', () => {
    const invocation = buildLaunchInvocation(manifest, {
      taskIds: ['T010', 'T011'],
      nextGateId: 'T012',
      barrier: { path: '/tmp/barrier', release: 'seg:1' },
      reportPath: '/tmp/runner-report.json',
      markdownPath: '/tmp/runner-report.md',
      sessionDir: '/tmp/session',
      bindings,
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
    const invocation = buildLaunchInvocation(manifest, { taskIds: ['T010'], barrier: { path: '/b', release: 'r' }, reportPath: '/tmp/runner-report.json', markdownPath: '/tmp/runner-report.md', sessionDir: '/tmp/session', bindings })
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

  it('tells the runner exactly what its report has to carry', () => {
    const prompt = segmentPrompt({
      featureDir: 'specs/002-smoke-fixture', taskIds: ['T001'], nextGateId: 'T003',
      reportPath: '/tmp/runner-report.json', markdownPath: '/tmp/runner-report.md',
      barrierPath: '/tmp/barrier', bindings,
    })
    expect(prompt).toContain('ticketId')
    expect(prompt).toContain('segmentId')
    expect(prompt).toContain('manifestSha256')
    expect(prompt).toContain('segmentId="segment-1"')
    expect(prompt).toContain('files')
    expect(prompt).toContain('sha256sum')
    expect(prompt).toContain('/tmp/runner-report.json')
  })

  it('writes the approved model into the run\'s own home, with the credential named and never valued', () => {
    const models = mkdtempSync(join(tmpdir(), 'prime-models-'))
    writeFileSync(join(models, 'models.json'), JSON.stringify({
      providers: {
        minimax: {
          baseUrl: 'https://api.minimax.io/v1',
          api: 'openai-completions',
          apiKey: 'a-secret-value',
          models: [{ id: 'MiniMax-M3.1-Flash', name: 'MiniMax' }, { id: 'other', name: 'Other' }],
        },
      },
    }))
    const storage = mkdtempSync(join(tmpdir(), 'prime-storage-'))
    const previous = process.env.DSH_PRIME_MODELS_FILE
    const credential = process.env.DSH_PRIME_CREDENTIAL_ENV
    process.env.DSH_PRIME_MODELS_FILE = join(models, 'models.json')
    process.env.DSH_PRIME_CREDENTIAL_ENV = 'MINIMAX_API_KEY'
    try {
      const file = writeRunnerModel(storage, manifest)
      expect(file).toBe(join(storage, '.prime', 'agent', 'models.json'))
      const written = JSON.parse(readFileSync(file!, 'utf8'))
      expect(written.providers.minimax.baseUrl).toBe('https://api.minimax.io/v1')
      expect(written.providers.minimax.api).toBe('openai-completions')
      expect(written.providers.minimax.apiKey).toBe('MINIMAX_API_KEY')
      expect(written.providers.minimax.models.map((model: { id: string }) => model.id)).toEqual(['MiniMax-M3.1-Flash'])
      expect(readFileSync(file!, 'utf8')).not.toContain('a-secret-value')
    } finally {
      if (previous === undefined) delete process.env.DSH_PRIME_MODELS_FILE
      else process.env.DSH_PRIME_MODELS_FILE = previous
      if (credential === undefined) delete process.env.DSH_PRIME_CREDENTIAL_ENV
      else process.env.DSH_PRIME_CREDENTIAL_ENV = credential
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
    const invocation = buildLaunchInvocation(manifest, { taskIds: [], barrier: { path: '/b', release: 'r' }, reportPath: '/tmp/runner-report.json', markdownPath: '/tmp/runner-report.md', sessionDir: '/tmp/session', bindings })
    const turns = invocation.argv[invocation.argv.indexOf('--autonomous-max-turns') + 1]
    expect(turns).toBe(String(DEFAULT_LIMITS.maxTurns))
  })

  it('states the constraints the runner must not break', () => {
    const prompt = segmentPrompt({
      featureDir: 'specs/001-prime-runner-bridge',
      taskIds: ['T010'],
      nextGateId: 'T012',
      reportPath: 'specs/001-prime-runner-bridge/runner-report.json',
      markdownPath: 'specs/001-prime-runner-bridge/runner-report.md',
      barrierPath: '/tmp/barrier',
      bindings,
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
      reportPath: 'r.json', markdownPath: 'r.md', barrierPath: '/b', bindings,
    })
    expect(prompt).toContain('T010 through T011')
    expect(prompt).not.toContain('T013')
  })
})

describe('the runner adapter', () => {
  /** A repository with one commit, so the checkout has a branch to leave. */
  const gitRoot = async (): Promise<string> => {
    const root = mkdtempSync(join(tmpdir(), 'prime-launch-'))
    await exec('git', ['init', '--quiet'], { cwd: root })
    await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: root })
    await exec('git', ['config', 'user.name', 'test'], { cwd: root })
    await exec('git', ['-c', 'user.email=t@e.com', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'base'], { cwd: root })
    return root
  }

  it('puts the checkout on the branch of the run before the runner starts', async () => {
    const root = await gitRoot()
    try {
      mkdirSync(join(root, 'workspace'), { recursive: true })
      const commands = { git: async (args: string[], cwd: string) => (await exec('git', args, { cwd })).stdout } as unknown as Commands
      const supervisor = {
        launch: async () => ({ identity: { sessionId: 'session-1', sessionFile: '/run/session-1.jsonl' } }),
      } as unknown as PrimeSupervisor
      const deps = { commands: () => commands, repositoryRoot: () => root } as unknown as PrimeServiceDeps
      const segment = {
        segmentId: 'segment-1', ticketId: 'ticket-1', assignmentId: 'assignment-1', generation: 1, stopEpoch: 0,
        taskIds: ['T004'], nextGateId: null,
        runner: {
          serviceUnit: 'dsh-prime-segment1', cgroup: '/sys/fs/cgroup/dsh-prime-segment1', tmux: 'dsh-prime-segment1',
          socket: join(root, 'socket'), workspace: join(root, 'workspace'), branch: 'agent/ticket-1',
        },
      } as unknown as BridgeSegment
      await runnerAdapter(supervisor, deps).launch(segment, manifest)
      // The runner works in the repository itself, so it has to find the branch of the run there.
      expect((await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root })).stdout.trim()).toBe('agent/ticket-1')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
