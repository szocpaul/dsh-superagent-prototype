
/** The explicit approval protocol of the Prime Runner Bridge: an allowlisted human approves one exact manifest. */
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ApprovalError, approvalEvidence, approveRun, approvalIsCurrent, parseRunApproval, revoke,
  type ApprovalEvidence, type ApprovalSource, type ApprovalStore } from '../src/app/prime-approval.ts'
import { Store } from '../src/app/store.ts'
import { manifestDigest } from '../src/executor/prime-manifest.ts'
import type { ApprovalRecord, ApprovedManifest } from '../src/executor/prime-model.ts'

const manifest = (): ApprovedManifest => ({
  schemaVersion: 1,
  repository: { id: 42, fullName: 'octocat/repo' },
  featureDir: 'specs/001-feature',
  baselineCommit: 'c'.repeat(40),
  artifacts: { specSha256: '1'.repeat(64), planSha256: '2'.repeat(64), tasksSha256: '3'.repeat(64),
    constitutionSha256: null, guidanceSha256: null, hooksSha256: null, treeSha256: '4'.repeat(64) },
  allowedPaths: ['src/app'],
  tasks: [{ id: 'T001', kind: 'automated', order: 0, text: 'Do the thing' }],
  checks: [{ name: 'typecheck', argv: ['pnpm', 'typecheck'], cwd: '.', timeoutMs: 60000 }],
  environment: { deploymentId: 'local', runner: { cli: 'prime-agent', version: '0.10.1' },
    model: { provider: 'test', id: 'model' }, isolation: { backend: 'bubblewrap', writablePaths: ['src/app'], network: 'none', allowedEndpoints: [] },
    credentials: ['model-api'], quota: { warnTokens: 1000, stopTokens: 2000, maxWallMs: 60000, meteringScope: 'session' },
    digest: '5'.repeat(64) },
})

const DIGEST = manifestDigest(manifest())
const OTHER = 'b'.repeat(64)
const APPROVAL = `@dsh-agent APPROVE RUN ${DIGEST}`

const evidence = (over: Partial<ApprovalEvidence> = {}): ApprovalEvidence => ({
  commentId: 'comment-1', commentBody: APPROVAL,
  actor: { id: 7, login: 'octocat', type: 'User' }, repoId: 42, at: '2026-11-01T00:00:00.000Z', ...over,
})

const source = (over: Partial<ApprovalSource> & { comments?: Record<string, ApprovalEvidence | undefined> } = {}) => {
  const comments = over.comments ?? { 'comment-1': evidence() }
  const value: ApprovalSource = {
    allowlist: () => ['octocat'],
    policyVersion: () => 'policy-1',
    fetchComment: async (id: string) => comments[id],
    manifest: () => manifest(),
    ...over,
  }
  return value
}

const request = (over: Partial<Parameters<typeof approveRun>[1]> = {}) => ({
  ticketId: 'ticket-1', triggerId: 'trigger-1', commentId: 'comment-1',
  manifestSha256: DIGEST, policyVersion: 'policy-1', ...over,
})

const store = () => {
  const saved: ApprovalRecord[] = []
  const value: ApprovalStore = {
    save: record => { saved.push(record) },
    get: id => saved.find(record => record.approvalId === id),
    byTicket: ticketId => saved.filter(record => record.ticketId === ticketId),
  }
  return { value, saved }
}

describe('the approval comment protocol', () => {
  it('accepts the exact approval form and refuses everything else', () => {
    expect(parseRunApproval(APPROVAL, DIGEST)).toBe('approved')
    expect(parseRunApproval(`@dsh-agent DENY RUN ${DIGEST}`, DIGEST)).toBe('denied')
    expect(parseRunApproval('yes', DIGEST)).toBeUndefined()
    expect(parseRunApproval(`> ${APPROVAL}`, DIGEST)).toBeUndefined()
    expect(parseRunApproval(`\`${APPROVAL}\``, DIGEST)).toBeUndefined()
    expect(parseRunApproval(`@dsh-agent APPROVE RUN ${OTHER}`, DIGEST)).toBeUndefined()
    expect(parseRunApproval(`${APPROVAL} please run it`, DIGEST)).toBeUndefined()
    expect(parseRunApproval(`${APPROVAL}\nthanks`, DIGEST)).toBeUndefined()
    expect(parseRunApproval(`@dsh-agent RUN ${DIGEST}`, DIGEST)).toBeUndefined()
  })
})

describe('approving a run', () => {
  it('records the approval of an allowlisted human', async () => {
    const target = store()
    const record = await approveRun(source(), request(), target.value)
    expect(record.kind).toBe('run')
    expect(record.decision).toBe('approved')
    expect(record.environmentApproved).toBe(true)
    expect(record.actor).toEqual({ id: 7, login: 'octocat', type: 'User' })
    expect(record.manifestSha256).toBe(DIGEST)
    expect(record.commentSha256).toBe(createHash('sha256').update(APPROVAL).digest('hex'))
    expect(record.policyVersion).toBe('policy-1')
    expect(target.saved).toHaveLength(1)
  })

  it('refuses a bot, an app, an unknown account and a missing account', async () => {
    for (const type of ['Bot', 'App', 'Unknown'] as const) {
      const from = source({ comments: { 'comment-1': evidence({ actor: { id: 7, login: 'octocat', type } }) } })
      await expect(approveRun(from, request(), store().value)).rejects.toThrow(ApprovalError)
    }
    const missing = source({ comments: { 'comment-1': evidence({ actor: { id: 0, login: 'ghost', type: 'Unknown' } }) } })
    await expect(approveRun(missing, request(), store().value)).rejects.toThrow(/human/)
  })

  it('refuses a human who is not allowlisted', async () => {
    const from = source({ allowlist: () => ['someone-else'] })
    await expect(approveRun(from, request(), store().value)).rejects.toThrow(/allowlist/)
  })

  it('refuses an approval of another manifest', async () => {
    const from = source({ comments: { 'comment-1': evidence({ commentBody: `@dsh-agent APPROVE RUN ${OTHER}` }) } })
    await expect(approveRun(from, request(), store().value)).rejects.toThrow(/manifest/)
  })

  it('refuses an edited comment, a deleted comment and a bare yes', async () => {
    const edited = source({ comments: { 'comment-1': evidence({ commentBody: `@dsh-agent APPROVE RUN ${OTHER}` }) } })
    await expect(approveRun(edited, request(), store().value)).rejects.toThrow(ApprovalError)
    const deleted = source({ comments: {} })
    await expect(approveRun(deleted, request(), store().value)).rejects.toThrow(/comment/)
    const bare = source({ comments: { 'comment-1': evidence({ commentBody: 'yes' }) } })
    await expect(approveRun(bare, request(), store().value)).rejects.toThrow(ApprovalError)
  })

  it('refuses a stale policy version', async () => {
    const from = source({ policyVersion: () => 'policy-2' })
    await expect(approveRun(from, request(), store().value)).rejects.toThrow(/policy/)
  })

  it('refuses a comment from another repository', async () => {
    const from = source({ comments: { 'comment-1': evidence({ repoId: 99 }) } })
    await expect(approveRun(from, request(), store().value)).rejects.toThrow(/repository/)
  })

  it('withdraws the approval when the allowlist entry is revoked', async () => {
    const record = await approveRun(source(), request(), store().value)
    expect(approvalIsCurrent(record, ['octocat'])).toBe(true)
    expect(approvalIsCurrent(record, [])).toBe(false)
    const withdrawn = revoke(record, [])
    expect(withdrawn.decision).toBe('denied')
    expect(approvalIsCurrent(withdrawn, [])).toBe(false)
  })
})

describe('the approval evidence', () => {
  it('carries the comment and the actor the source just read', () => {
    const value = approvalEvidence({ commentId: 'comment-1', body: 'yes', actor: { id: 7, login: 'octocat', type: 'User' }, at: 'now' }, 42)
    expect(value).toEqual({ commentId: 'comment-1', commentBody: 'yes', actor: { id: 7, login: 'octocat', type: 'User' }, repoId: 42, at: 'now' })
  })
})

describe('the approval store', () => {
  it('writes the record through the Store bridge records', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'prime-approval-'))
    const store = new Store(join(directory, 'db.sqlite'))
    try {
      const record = await approveRun(source(), request(), store.bridge.approvals)
      expect(store.bridge.approvals.get(record.approvalId)?.manifestSha256).toBe(DIGEST)
      expect(store.bridge.approvals.byTicket('ticket-1')).toHaveLength(1)
    } finally {
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
