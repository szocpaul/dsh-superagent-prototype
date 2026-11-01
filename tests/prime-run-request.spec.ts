import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findRunApproval, manifestKey, requestRun } from '../src/app/prime-service.ts'
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
function dependencies(root: string, store: Store, rows: unknown[], repository: { id: number }) {
  const settings = SettingsSchema.parse({ policy: { sources: { github: { allowed: [{ id: 'human' }] } } } })
  const commands = {
    git: async (args: string[], cwd: string) => execFileSync('git', args, { cwd, encoding: 'utf8' }),
    api: async (_schema: unknown, path: string) => {
      if (path === '') return { id: repository.id, name: 'example/fixture' }
      const id = Number(path.split('/').pop())
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

      repository.id = REPOSITORY_ID + 1
      const other = dependencies(root, store, comments(digest), repository)
      expect(await findRunApproval(other, 'ticket-1', digest)).toBeUndefined()
    } finally {
      store.close()
    }
  })
})
