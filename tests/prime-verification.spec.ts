import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { bytesDigest } from '../src/executor/prime-manifest.ts'
import { revisionPort, verifierPort, verifierEnvironment } from '../src/app/prime-verification.ts'
import { collectSnapshot } from '../src/executor/prime-verify.ts'
import type { Commands } from '../src/infra/commands.ts'

const exec = promisify(execFile)

/** A Commands stand-in that runs git for real in the given root. */
function gitCommands(root: string): Commands {
  return {
    git: async (args: string[], cwd: string) => {
      const result = await exec('git', args, { cwd: cwd || root })
      return result.stdout
    },
    run: async (program: string, args: string[], cwd?: string) => {
      const result = await exec(program, args, { cwd: cwd || root })
      return result.stdout
    },
  } as unknown as Commands
}

async function gitRoot(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'prime-verify-'))
  await exec('git', ['init', '--quiet'], { cwd: root })
  await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: root })
  await exec('git', ['config', 'user.name', 'test'], { cwd: root })
  return root
}

describe('the host verification', () => {
  it('creates the controller commit of the approved files', async () => {
    const root = await gitRoot()
    try {
      const committer = revisionPort(gitCommands(root), root)
      const revision = await committer.commit({
        files: [{ path: 'src/smoke.ts', content: Buffer.from('export const smoke = () => "smoke"\n') }],
        message: 'controller: the verified result',
      })
      expect(revision).toMatch(/^[0-9a-f]{40}$/)
      const committed = readFileSync(join(root, 'src/smoke.ts'), 'utf8')
      expect(committed).toContain('export const smoke')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('creates the same revision every time, when the date is fixed', async () => {
    const root = await gitRoot()
    try {
      await exec('git', ['-c', 'user.email=t@e.com', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'base'], { cwd: root })
      const committer = revisionPort(gitCommands(root), root)
      const input = {
        files: [{ path: 'src/smoke.ts', content: Buffer.from('export const smoke = () => "smoke"\n') }],
        message: 'controller: the verified result',
        date: '2026-11-01T00:00:00.000Z',
      }
      const first = await committer.commit(input)
      const second = await committer.commit(input)
      expect(second).toBe(first)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('creates the controller commit of a result that changes no file', async () => {
    const root = await gitRoot()
    try {
      await exec('git', ['-c', 'user.email=t@e.com', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'base'], { cwd: root })
      const parent = (await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim()
      const committer = revisionPort(gitCommands(root), root)
      // A segment that only runs the checks and records the evidence changes no file.
      const revision = await committer.commit({ files: [], message: 'controller: the verified result' })
      expect(revision).toMatch(/^[0-9a-f]{40}$/)
      expect(revision).not.toBe(parent)
      // The revision is a commit of its own, and it carries no change.
      const tree = (await exec('git', ['rev-parse', `${revision}^{tree}`], { cwd: root })).stdout.trim()
      const parentTree = (await exec('git', ['rev-parse', `${parent}^{tree}`], { cwd: root })).stdout.trim()
      expect(tree).toBe(parentTree)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('creates the controller commit on the branch of the run', async () => {
    const root = await gitRoot()
    try {
      await exec('git', ['-c', 'user.email=t@e.com', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'base'], { cwd: root })
      const parent = (await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim()
      const committer = revisionPort(gitCommands(root), root, 'agent/ticket-1')
      const revision = await committer.commit({
        files: [{ path: 'src/smoke.ts', content: Buffer.from('export const smoke = () => "smoke"\n') }],
        message: 'controller: the verified result',
      })
      // The revision is a child of the head of the branch of the run, so the delivery can publish it there.
      expect((await exec('git', ['rev-parse', `${revision}^`], { cwd: root })).stdout.trim()).toBe(parent)
      // The checkout holds the branch of the run.
      expect((await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root })).stdout.trim()).toBe('agent/ticket-1')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reruns a check against the exact revision in a separate checkout', async () => {
    const root = await gitRoot()
    try {
      await exec('git', ['-c', 'user.email=t@e.com', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'base'], { cwd: root })
      const revision = (await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim()
      const verifier = verifierPort(gitCommands(root), root)
      const outcome = await verifier.run(
        { name: 'rev', argv: ['git', 'rev-parse', 'HEAD'], cwd: '.', timeoutMs: 30_000 },
        revision,
        verifierEnvironment(root),
      )
      expect(outcome.exitCode).toBe(0)
      expect(outcome.evidence.trim()).toBe(revision)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reports a failing check with its exit code instead of throwing', async () => {
    const root = await gitRoot()
    try {
      await exec('git', ['-c', 'user.email=t@e.com', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'base'], { cwd: root })
      const revision = (await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim()
      const verifier = verifierPort(gitCommands(root), root)
      const outcome = await verifier.run(
        { name: 'fail', argv: ['sh', '-c', 'exit 3'], cwd: '.', timeoutMs: 30_000 },
        revision,
        verifierEnvironment(root),
      )
      expect(outcome.exitCode).toBe(3)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reads the changed files of the repository the runner worked in', async () => {
    const root = await gitRoot()
    try {
      mkdirSync(join(root, 'src'), { recursive: true })
      writeFileSync(join(root, 'src', 'smoke.ts'), 'export const smoke = 1\n')
      await exec('git', ['add', '.'], { cwd: root })
      await exec('git', ['-c', 'user.email=t@e.com', '-c', 'user.name=t', 'commit', '-m', 'base'], { cwd: root })
      writeFileSync(join(root, 'src', 'smoke.ts'), 'export const smoke = 2\n')
      const snapshot = await collectSnapshot(gitCommands(root), root, ['src'])
      expect(snapshot.paths).toContain('src/smoke.ts')
      expect(snapshot.files[0]?.sha256).toBe(bytesDigest(Buffer.from('export const smoke = 2\n')))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('gives the check the dependencies of the project, so it can run against the exact revision', async () => {
    const root = await gitRoot()
    try {
      mkdirSync(join(root, 'node_modules'), { recursive: true })
      writeFileSync(join(root, 'node_modules', 'marker.txt'), 'the dependency\n')
      await exec('git', ['-c', 'user.email=t@e.com', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'base'], { cwd: root })
      const revision = (await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim()
      const verifier = verifierPort(gitCommands(root), root)
      const outcome = await verifier.run(
        { name: 'read', argv: ['sh', '-c', 'cat node_modules/marker.txt'], cwd: '.', timeoutMs: 60_000 },
        revision,
        verifierEnvironment(root),
      )
      expect(outcome.exitCode).toBe(0)
      expect(outcome.evidence).toContain('the dependency')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)

  it('hands no credential to the verifier', () => {
    const environment = verifierEnvironment('/tmp/workspace')
    expect(environment.GH_TOKEN).toBeUndefined()
    expect(environment.GITHUB_TOKEN).toBeUndefined()
    expect(environment.GIT_CONFIG_GLOBAL).toBeUndefined()
    expect(environment.HOME).toBe('/tmp/workspace')
    for (const [name, value] of Object.entries(environment)) {
      if (value === undefined) continue
      expect(name).not.toMatch(/(TOKEN|SECRET|PASSWORD|APIKEY|API_KEY|CREDENTIAL)$/)
    }
  })

  it('gives the check no credential and no git identity of the controller', async () => {
    const root = await gitRoot()
    const model = process.env.MINIMAX_API_KEY
    const identity = process.env.GIT_CONFIG_GLOBAL
    process.env.MINIMAX_API_KEY = 'the model key of the deployment'
    process.env.GIT_CONFIG_GLOBAL = join(root, 'worker-gitconfig')
    try {
      await exec('git', ['-c', 'user.email=t@e.com', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'base'], { cwd: root })
      const revision = (await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim()
      const verifier = verifierPort(gitCommands(root), root)
      const outcome = await verifier.run(
        {
          name: 'env',
          argv: ['sh', '-c', 'echo "key=${MINIMAX_API_KEY-unset} git=${GIT_CONFIG_GLOBAL-unset} home=${HOME-unset}"'],
          cwd: '.',
          timeoutMs: 30_000,
        },
        revision,
        verifierEnvironment(root),
      )
      expect(outcome.exitCode).toBe(0)
      expect(outcome.evidence).toContain('key=unset')
      expect(outcome.evidence).toContain('git=unset')
      expect(outcome.evidence).toContain(`home=${root}`)
    } finally {
      if (model === undefined) delete process.env.MINIMAX_API_KEY
      else process.env.MINIMAX_API_KEY = model
      if (identity === undefined) delete process.env.GIT_CONFIG_GLOBAL
      else process.env.GIT_CONFIG_GLOBAL = identity
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps the scratch copy of the check in the storage the caller names', async () => {
    const root = await gitRoot()
    const storage = mkdtempSync(join(tmpdir(), 'prime-storage-'))
    try {
      await exec('git', ['-c', 'user.email=t@e.com', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'base'], { cwd: root })
      const revision = (await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim()
      const verifier = verifierPort(gitCommands(root), root, storage)
      const outcome = await verifier.run(
        { name: 'cwd', argv: ['sh', '-c', 'pwd'], cwd: '.', timeoutMs: 30_000 },
        revision,
        verifierEnvironment(root),
      )
      expect(outcome.exitCode).toBe(0)
      expect(outcome.evidence.startsWith(storage)).toBe(true)
    } finally {
      rmSync(storage, { recursive: true, force: true })
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('checks out the revision, not the working tree', async () => {
    const root = await gitRoot()
    try {
      writeFileSync(join(root, 'marker.txt'), 'from the first commit\n')
      await exec('git', ['add', '.'], { cwd: root })
      await exec('git', ['-c', 'user.email=t@e.com', '-c', 'user.name=t', 'commit', '-m', 'first'], { cwd: root })
      const revision = (await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim()
      writeFileSync(join(root, 'marker.txt'), 'changed afterwards\n')
      const verifier = verifierPort(gitCommands(root), root)
      const outcome = await verifier.run(
        { name: 'read', argv: ['sh', '-c', 'cat marker.txt'], cwd: '.', timeoutMs: 30_000 },
        revision,
        verifierEnvironment(root),
      )
      expect(outcome.evidence).toContain('from the first commit')
      expect(outcome.evidence).not.toContain('changed afterwards')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
