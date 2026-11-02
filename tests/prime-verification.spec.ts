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
    expect(environment.HOME).toBe('/tmp/workspace')
    for (const [name, value] of Object.entries(environment)) {
      if (value === undefined) continue
      expect(name).not.toMatch(/(TOKEN|SECRET|PASSWORD|APIKEY|API_KEY|CREDENTIAL)$/)
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
