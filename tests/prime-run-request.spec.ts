import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findGateApproval, findRunApproval, manifestKey, requestRun } from '../src/app/prime-service.ts'
import { Store } from '../src/app/store.ts'
import { SettingsSchema } from '../src/policy.ts'
import type { Ticket, Trigger } from '../src/core/index.ts'
import type { Commands } from '../src/infra/commands.ts'
import type { Effects } from '../src/app/effects.ts'
import type { ApprovedManifest } from '../src/executor/prime-model.ts'

/** The id the fake GitHub API reports for the repository under test. */
const REPOSITORY_ID = 4242

/** A temporary repository holding the disposable fixture, so the manifest is built from real git bytes. */
function fixtureRepository(): string {
  const root = mkdtempSync(join(tmpdir(), 'prime-run-request-'))
  mkdirSync(join(root, 'specs/002-smoke-fixture'), { recursive: true })
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, 'tests'), { recursive: true })
  for (const file of ['spec.md', 'plan.md', 'tasks.md']) {
    cpSync(join('specs/002-smoke-fixture', file), join(root, 'specs/002-smoke-fixture', file))
  }
  cpSync('src/smoke.ts', join(root, 'src/smoke.ts'))
  cpSync('tests/smoke.spec.ts', join(root, 'tests/smoke.spec.ts'))
  cpSync('package.json', join(root, 'package.json'))
  const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
  git(['init', '-q'])
  git(['add', '.'])
  git(['-c', 'user.email=fixture@example.com', '-c', 'user.name=Fixture', 'commit', '-q', '-m', 'the fixture'])
  return root
}

/** The comments of the ticket's conversation, as the approval protocol reads them. */
function comments(digest: string): unknown[] {
  return [{ id: 101, body: `@agent APPROVE RUN ${digest}`, user: { login: 'human', id: 7, type: 'User' } }]
}

/** The service dependencies of the run request, with a fake GitHub and a real store. */
function dependencies(root: string, store: Store, rows: unknown[], repository: { id: number }, commit?: unknown) {
  const settings = SettingsSchema.parse({ policy: { sources: { github: { allowed: [{ id: 'human' }] } } } })
  const commands = {
    git: async (args: string[], cwd: string) => execFileSync('git', args, { cwd, encoding: 'utf8' }),
    api: async (_schema: unknown, path: string) => {
      if (path === '') return { id: repository.id, name: 'example/fixture' }
      // The gate commit is read from the repository under its own path.
      if (/^commits\/[0-9a-f]{40}$/.test(path)) return commit
      // GitHub serves one issue comment under issues/comments/<id>; any other route is a 404.
      const comment = /^issues\/comments\/(\d+)$/.exec(path)
      if (!comment) throw new Error(`404 Not Found (${path})`)
      const id = Number(comment[1])
      return (rows as { id: number }[]).find(row => row.id === id)
    },
    pages: async () => rows,
  }
  return {
    store,
    effects: { enqueue: () => {} } as unknown as Effects,
    report: () => ({}) as unknown as Ticket,
    send: () => {},
    settings: () => settings,
    deployment: () => ({
      repository: 'example/fixture',
      github: { login: 'agent', cli: 'gh', noreply: 'agent@example.com' },
      stateDir: '/tmp/fixture-state',
      promptMaxChars: { get: () => 1000 },
      admissionContextMaxPages: { get: () => 1 },
      admissionContextTimeoutMs: { get: () => 1000 },
    }),
    commands: () => commands as unknown as Commands,
    repositoryRoot: () => root,
    environment: () => ({
      deploymentId: 'deployment-fixture',
      runner: { cli: 'prime-agent', version: '0.10.1' },
      model: { provider: 'fixture', id: 'fixture-model' },
      isolation: { backend: 'bubblewrap' as const, writablePaths: [], network: 'none' as const, allowedEndpoints: [] },
      credentials: ['model-api'],
      quota: { warnTokens: 1000, stopTokens: 2000, maxWallMs: 600000, meteringScope: 'session' },
    }),
    manifests: () => [],
    now: () => '2026-11-01T00:00:00.000Z',
  }
}

/** A ticket with one trigger, so the approval protocol can find the conversation of the issue. */
function ticketAndTrigger(store: Store): void {
  const trigger = { id: 'trigger-1', at: '2026-11-01T00:00:00.000Z', meta: { number: 7 }, threads: [] } as unknown as Trigger
  store.triggers.save(trigger)
  const ticket = { id: 'ticket-1', origin: { triggerId: 'trigger-1' }, channels: [] } as unknown as Ticket
  store.tickets.save(ticket)
}

/** The gate decision comment and the gate commit it names, as GitHub serves them. */
function gateDecision(digest: string, sha: string, line: string): { rows: unknown[]; commit: unknown } {
  const rows = [{ id: 201, body: `@agent APPROVE GATE T003 ${digest} ${sha}`, user: { login: 'human', id: 7, type: 'User' } }]
  const commit = {
    sha,
    parents: [{ sha: 'd'.repeat(40) }],
    author: { login: 'human', id: 7, type: 'User' },
    committer: { login: 'web-flow' },
    commit: { verification: { verified: true, reason: 'valid' } },
    files: [{ filename: 'specs/002-smoke-fixture/tasks.md', patch: `@@ -16,7 +16,7 @@\n-- [ ] ${line}\n+- [x] ${line}\n` }],
  }
  return { rows, commit }
}

describe('the run request of a Prime run', () => {
  it('names the repository GitHub reports, so the manifest can be built and approved', async () => {
    const root = fixtureRepository()
    const store = new Store(join(mkdtempSync(join(tmpdir(), 'prime-run-store-')), 'db.sqlite'))
    try {
      const deps = dependencies(root, store, [], { id: REPOSITORY_ID })
      const { manifest, digest } = await requestRun(deps, 'ticket-1', 'specs/002-smoke-fixture')
      expect(manifest.repository).toEqual({ id: REPOSITORY_ID, fullName: 'example/fixture' })
      expect(digest).toMatch(/^[0-9a-f]{64}$/)
      expect(manifest.allowedPaths).toEqual(['src/smoke.ts', 'tests/smoke.spec.ts'])
      // The confinement writes exactly the approved scope, so the manifest and the isolation cannot disagree.
      expect(manifest.environment.isolation.writablePaths).toEqual(manifest.allowedPaths)
      expect(manifest.tasks.map(task => task.kind)).toEqual(['automated', 'automated', 'human', 'automated', 'automated'])
      expect(store.get(manifestKey('ticket-1'))).toEqual(manifest)
    } finally {
      store.close()
    }
  })

  it('accepts the approval of an allowlisted human on the same repository, and refuses another one', async () => {
    const root = fixtureRepository()
    const store = new Store(join(mkdtempSync(join(tmpdir(), 'prime-run-store-')), 'db.sqlite'))
    try {
      ticketAndTrigger(store)
      const repository = { id: REPOSITORY_ID }
      const first = dependencies(root, store, [], repository)
      const { manifest, digest } = await requestRun(first, 'ticket-1', 'specs/002-smoke-fixture')
      store.set(manifestKey('ticket-1'), manifest as unknown as ApprovedManifest)
      const approval = dependencies(root, store, comments(digest), repository)
      const record = await findRunApproval(approval, 'ticket-1', digest)
      expect(record?.decision).toBe('approved')
      expect(record?.repositoryId).toBe(REPOSITORY_ID)

      // The poll that follows the same decision answers with it instead of recording it again.
      const again = await findRunApproval(approval, 'ticket-1', digest)
      expect(again?.approvalId).toBe(record?.approvalId)
      expect(store.bridge.approvals.byTicket('ticket-1')).toHaveLength(1)

      repository.id = REPOSITORY_ID + 1
      const other = dependencies(root, store, comments(digest), repository)
      expect(await findRunApproval(other, 'ticket-1', digest)).toBeUndefined()
    } finally {
      store.close()
    }
  })
})

describe('the gate decision of a Prime run', () => {
  it('records the verified gate decision, so the continuation past the gate finds it', async () => {
    const root = fixtureRepository()
    const store = new Store(join(mkdtempSync(join(tmpdir(), 'prime-run-store-')), 'db.sqlite'))
    try {
      ticketAndTrigger(store)
      const repository = { id: REPOSITORY_ID }
      const first = dependencies(root, store, [], repository)
      const { manifest, digest } = await requestRun(first, 'ticket-1', 'specs/002-smoke-fixture')
      store.set(manifestKey('ticket-1'), manifest as unknown as ApprovedManifest)
      const gate = manifest.tasks.find(task => task.id === 'T003')!
      const line = `${gate.id} ${gate.text}`
      const sha = 'e'.repeat(40)
      const { rows, commit } = gateDecision(digest, sha, line)
      const deps = dependencies(root, store, rows, repository, commit)
      const record = await findGateApproval(deps, 'ticket-1', 'T003', digest, { taskLine: line, parent: 'd'.repeat(40) })
      expect(record?.decision).toBe('approved')
      expect(record?.gateCommit).toBe(sha)
      // The decision is recorded, so the continuation past the gate finds it bound to the gate.
      const recorded = store.bridge.approvals.byTicket('ticket-1')
      expect(recorded).toHaveLength(1)
      expect(recorded[0]!.gateId).toBe('T003')
      // The poll that follows the same decision answers with it instead of recording it again.
      const again = await findGateApproval(deps, 'ticket-1', 'T003', digest, { taskLine: line, parent: 'd'.repeat(40) })
      expect(again?.approvalId).toBe(record?.approvalId)
      expect(store.bridge.approvals.byTicket('ticket-1')).toHaveLength(1)
    } finally {
      store.close()
    }
  })
})
