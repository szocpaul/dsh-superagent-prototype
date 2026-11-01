
/**
 * Tests for the isolation adapter and the supervised runner: the argument vector of an isolation plan, the
 * deterministic run identities, the containment probes, and the stop, quiescence and cleanup verdicts. Every
 * external effect is faked, so the tests need no bubblewrap, systemd, or root.
 */
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, linkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildBwrapArgs,
  cgroupPath,
  cgroupProcesses,
  collectArtifacts,
  containmentProbes,
  isQuiescent,
  isolationPlan,
  PROBE_KINDS,
  quiescenceState,
  socketPath,
  systemdUnitName,
  tmuxServerName,
  verifyConfinement,
  IsolationError,
} from '../src/infra/prime-isolation.ts'
import type { IsolationPlan, IsolationRunner, ProbeAttempt, ProbeKind } from '../src/infra/prime-isolation.ts'
import { PrimeSupervisor } from '../src/executor/prime-supervisor.ts'
import type { RunEnvironment } from '../src/executor/prime-supervisor.ts'
import type { ApprovedManifest, SegmentRunnerIdentity } from '../src/executor/prime-model.ts'

/** A manifest whose only writable path is one source file, used as the base of the plan tests. */
function manifest(overrides: Partial<ApprovedManifest['environment']['isolation']> = {}): ApprovedManifest {
  return {
    schemaVersion: 1,
    repository: { id: 4242, fullName: 'example/fixture' },
    featureDir: 'specs/001-fixture',
    baselineCommit: 'a'.repeat(40),
    artifacts: {
      specSha256: 'b'.repeat(64), planSha256: 'c'.repeat(64), tasksSha256: 'd'.repeat(64),
      constitutionSha256: null, guidanceSha256: null, hooksSha256: null, treeSha256: 'e'.repeat(64),
    },
    allowedPaths: ['src/fixture.ts'],
    tasks: [{ id: 'T001', kind: 'automated', order: 0, text: 'Set up the fixture workspace' }],
    checks: [],
    environment: {
      deploymentId: 'deployment-fixture',
      runner: { cli: 'prime-agent', version: '0.10.1' },
      model: { provider: 'fixture', id: 'fixture-model' },
      isolation: { backend: 'bubblewrap', writablePaths: ['src/fixture.ts'], network: 'none', allowedEndpoints: [], ...overrides },
      credentials: ['model-api'],
      quota: { warnTokens: 1000, stopTokens: 2000, maxWallMs: 600000, meteringScope: 'session' },
      digest: 'f'.repeat(64),
    },
  }
}

/** A workspace directory with the approved source tree, so the plan resolves real paths. */
function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'prime-isolation-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'fixture.ts'), 'export const fixture = 1\n')
  mkdirSync(join(root, 'specs', '001-fixture'), { recursive: true })
  writeFileSync(join(root, 'specs', '001-fixture', 'plan.md'), '# plan\n')
  return root
}

/** A recorded call of the fake runner. */
interface Recorded { argv: string[]; options?: unknown }

function fakeRunner(result: { exitCode?: number; stdout?: string; stderr?: string } = {}): IsolationRunner & { calls: Recorded[] } {
  const calls: Recorded[] = []
  return {
    calls,
    async run(argv, options) {
      calls.push({ argv, options })
      return { exitCode: result.exitCode ?? 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
    },
    spawn(argv, options) {
      calls.push({ argv, options })
      return { pid: 4242, kill() {}, async wait() { return { exitCode: 0, stdout: result.stdout ?? '', stderr: '' } } }
    },
  }
}

describe('isolation plan', () => {
  it('refuses a manifest without an isolation backend, because the bridge stays disabled without a real boundary', () => {
    expect(() => isolationPlan(manifest({ backend: 'none' }), workspace())).toThrow(IsolationError)
    expect(() => isolationPlan(manifest({ backend: 'none' }), workspace())).toThrow(/disabled/)
  })

  it('refuses a writable path that escapes the workspace', () => {
    expect(() => isolationPlan(manifest({ writablePaths: ['../outside/file.ts'] }), workspace())).toThrow(IsolationError)
    expect(() => isolationPlan(manifest({ writablePaths: ['/etc/passwd'] }), workspace())).toThrow(IsolationError)
  })

  it('builds an argument vector with a private proc, a masked home and tmp, and the approved mounts', () => {
    const root = workspace()
    const plan = isolationPlan(manifest(), root, { argv: ['prime-agent', 'run'] })
    const args = buildBwrapArgs(plan)
    expect(args[0]).toBe('bwrap')
    expect(args).toContain('--unshare-pid')
    expect(args).toContain('--unshare-ipc')
    expect(args).toContain('--unshare-uts')
    expect(args).toContain('--unshare-net')
    expect(args.slice(args.indexOf('--proc'), args.indexOf('--proc') + 2)).toEqual(['--proc', '/proc'])
    expect(args.slice(args.indexOf('--tmpfs'), args.indexOf('--tmpfs') + 2)).toEqual(['--tmpfs', '/home'])
    expect(args).toContain('/tmp')
    expect(args).toContain('--ro-bind')
    expect(args).toContain(root)
    expect(args).toContain('--bind')
    expect(args).toContain(join(root, 'src', 'fixture.ts'))
    expect(args.slice(-3)).toEqual(['--', 'prime-agent', 'run'])
    expect(args).not.toContain('--sync-fd')
    expect(plan.inheritedDescriptors).toEqual([0, 1, 2])
  })

  it('binds only the approved writable paths writable', () => {
    const root = workspace()
    const plan = isolationPlan(manifest({ writablePaths: ['src/fixture.ts'] }), root)
    const args = buildBwrapArgs(plan)
    const writable = args.reduce<string[]>((found, value, index) => (args[index - 1] === '--bind' ? [...found, value] : found), [])
    expect(writable).toEqual([join(root, 'src', 'fixture.ts')])
    const readOnly = args.reduce<string[]>((found, value, index) => (args[index - 1] === '--ro-bind' ? [...found, value] : found), [])
    expect(readOnly).toContain(root)
    expect(readOnly).not.toContain(join(root, 'src', 'fixture.ts'))
  })
})

describe('deterministic run identities', () => {
  it('derives the same names for the same segment', () => {
    expect(systemdUnitName('seg-1')).toBe(systemdUnitName('seg-1'))
    expect(cgroupPath('seg-1')).toBe(cgroupPath('seg-1'))
    expect(tmuxServerName('seg-1')).toBe(tmuxServerName('seg-1'))
    expect(socketPath('seg-1')).toBe(socketPath('seg-1'))
  })

  it('never lets two runs collide', () => {
    const names = ['seg-1', 'seg-2', 'seg-1 '].map(id => [systemdUnitName(id), cgroupPath(id), tmuxServerName(id), socketPath(id)])
    expect(new Set(names.flat()).size).toBe(names.flat().length)
    expect(systemdUnitName('seg-1')).not.toBe(tmuxServerName('seg-1'))
  })
})

describe('containment probes', () => {
  const attempt = (escaped: boolean): ProbeAttempt => async () => ({ escaped, detail: 'probe detail' })

  it('covers every documented probe kind', () => {
    expect(PROBE_KINDS.length).toBeGreaterThanOrEqual(9)
  })

  it('reports each escape attempt as a failed probe with a reason', async () => {
    const root = workspace()
    const plan = isolationPlan(manifest(), root)
    const results = await containmentProbes(plan, attempt(true))
    expect(results).toHaveLength(PROBE_KINDS.length)
    expect(results.every(result => !result.passed)).toBe(true)
    expect(results.every(result => result.reason.length > 0)).toBe(true)
  })

  it('passes every probe when no escape is possible', async () => {
    const root = workspace()
    const plan = isolationPlan(manifest(), root)
    const verdict = await verifyConfinement(plan, attempt(false))
    expect(verdict.confined).toBe(true)
    expect(verdict.failures).toEqual([])
  })

  it('names a single failed probe kind in the verdict', async () => {
    const root = workspace()
    const plan = isolationPlan(manifest(), root)
    const kind: ProbeKind = 'filesystem-escape'
    const verdict = await verifyConfinement(plan, async probe => ({ escaped: probe === kind, detail: 'wrote outside' }))
    expect(verdict.confined).toBe(false)
    expect(verdict.failures).toHaveLength(1)
    expect(verdict.failures[0]).toContain(kind)
  })
})

describe('cgroup quiescence', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'prime-cgroup-')) })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('is quiescent when the cgroup holds no process', () => {
    const cgroup = join(root, 'empty')
    mkdirSync(cgroup)
    writeFileSync(join(cgroup, 'cgroup.procs'), '')
    expect(cgroupProcesses(cgroup)).toEqual([])
    expect(isQuiescent(cgroup)).toBe(true)
    expect(quiescenceState(cgroup)).toBe('quiescent')
  })

  it('is not quiescent while the cgroup holds a process', () => {
    const cgroup = join(root, 'busy')
    mkdirSync(cgroup)
    writeFileSync(join(cgroup, 'cgroup.procs'), '1234\n')
    expect(cgroupProcesses(cgroup)).toEqual([1234])
    expect(isQuiescent(cgroup)).toBe(false)
    expect(quiescenceState(cgroup)).toBe('busy')
  })

  it('reports a missing cgroup as unknown, never as quiescent', () => {
    const cgroup = join(root, 'missing')
    expect(() => cgroupProcesses(cgroup)).toThrow(IsolationError)
    expect(isQuiescent(cgroup)).toBe(false)
    expect(quiescenceState(cgroup)).toBe('unknown')
  })
})

describe('supervised runner', () => {
  let root: string
  let identity: SegmentRunnerIdentity
  let processes: number[]
  let removed: string[]

  const environment = (): RunEnvironment => ({
    supported: () => true,
    async start() { },
    async cancel() { processes = [] },
    processes() {
      if (processes === null) throw new IsolationError('the cgroup cannot be read')
      return processes
    },
    async remove(current) {
      removed = [current.serviceUnit, current.socket, current.tmux, current.workspace]
      return removed
    },
  })

  beforeEach(() => {
    root = workspace()
    processes = [4242]
    removed = []
    identity = {
      serviceUnit: systemdUnitName('seg-1'),
      cgroup: cgroupPath('seg-1'),
      tmux: tmuxServerName('seg-1'),
      socket: socketPath('seg-1'),
      workspace: root,
      branch: 'feature/prime-runner-bridge',
    }
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('fails closed when the host cannot provide the required confinement', async () => {
    const supervisor = new PrimeSupervisor(fakeRunner(), { ...environment(), supported: () => false })
    await expect(supervisor.launch(isolationPlan(manifest(), root), identity)).rejects.toThrow(IsolationError)
  })

  it('reports an unconfirmed stop while the cgroup still holds a process', async () => {
    const supervisor = new PrimeSupervisor(fakeRunner(), { ...environment(), cancel: async () => {} })
    const verdict = await supervisor.stop(identity, 'operator stopped the ticket')
    expect(verdict.status).toBe('unconfirmed')
    expect(verdict.processes).toEqual([4242])
  })

  it('reports a confirmed stop only when the cgroup empties', async () => {
    const supervisor = new PrimeSupervisor(fakeRunner(), environment())
    const verdict = await supervisor.stop(identity, 'operator stopped the ticket')
    expect(verdict.status).toBe('stopped')
    expect(verdict.processes).toEqual([])
  })

  it('reports an unknown stop when the cgroup cannot be read', async () => {
    const supervisor = new PrimeSupervisor(fakeRunner(), { ...environment(), cancel: async () => { processes = null as never } })
    const verdict = await supervisor.stop(identity, 'operator stopped the ticket')
    expect(verdict.status).toBe('unknown')
  })

  it('refuses to clean up while the stop is unconfirmed', async () => {
    const supervisor = new PrimeSupervisor(fakeRunner(), { ...environment(), cancel: async () => {} })
    await expect(supervisor.cleanup(identity)).rejects.toThrow(IsolationError)
    expect(removed).toEqual([])
  })

  it('removes only the resources of the run itself after a confirmed quiescence', async () => {
    const supervisor = new PrimeSupervisor(fakeRunner(), environment())
    processes = []
    const result = await supervisor.cleanup(identity)
    expect(result.removed).toEqual([identity.serviceUnit, identity.socket, identity.tmux, identity.workspace])
    expect(result.removed).not.toContain(cgroupPath('seg-2'))
  })

  it('fails closed when the runner reports no durable session identity', async () => {
    const supervisor = new PrimeSupervisor(fakeRunner({ stdout: 'nothing useful\n' }), environment())
    await expect(supervisor.launch(isolationPlan(manifest(), root), identity)).rejects.toThrow(IsolationError)
  })

  it('observes the durable session identity of the launched run', async () => {
    const runner = fakeRunner({ stdout: 'session id: session-abc\nsession file: /run/prime/session-abc.jsonl\n' })
    const supervisor = new PrimeSupervisor(runner, environment())
    const result = await supervisor.launch(isolationPlan(manifest(), root, { argv: ['prime-agent', 'run'] }), identity)
    expect(result.identity.sessionId).toBe('session-abc')
    expect(result.identity.sessionFile).toBe('/run/prime/session-abc.jsonl')
    expect(runner.calls[0]?.argv).toContain('--unshare-net')
  })
})

describe('artifact collection', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'prime-artifacts-')) })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('collects the files under the root', () => {
    writeFileSync(join(root, 'report.md'), '# report\n')
    mkdirSync(join(root, 'nested'))
    writeFileSync(join(root, 'nested', 'evidence.txt'), 'evidence\n')
    const artifacts = collectArtifacts(root)
    expect(artifacts.map(artifact => artifact.path).sort()).toEqual(['nested/evidence.txt', 'report.md'])
    expect(artifacts.every(artifact => /^[0-9a-f]{64}$/.test(artifact.sha256))).toBe(true)
  })

  it('refuses a symlink that points outside the root', () => {
    const outside = mkdtempSync(join(tmpdir(), 'prime-outside-'))
    writeFileSync(join(outside, 'secret.txt'), 'secret\n')
    symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'))
    expect(() => collectArtifacts(root)).toThrow(IsolationError)
    rmSync(outside, { recursive: true, force: true })
  })

  it('refuses a hard link whose other links lie outside the root', () => {
    const outside = mkdtempSync(join(tmpdir(), 'prime-outside-'))
    writeFileSync(join(outside, 'shared.txt'), 'shared\n')
    linkSync(join(outside, 'shared.txt'), join(root, 'shared.txt'))
    expect(() => collectArtifacts(root)).toThrow(IsolationError)
    rmSync(outside, { recursive: true, force: true })
  })

  it('refuses a root that is not a directory', () => {
    const file = join(root, 'file.txt')
    writeFileSync(file, 'x\n')
    expect(() => collectArtifacts(file)).toThrow(IsolationError)
  })
})
