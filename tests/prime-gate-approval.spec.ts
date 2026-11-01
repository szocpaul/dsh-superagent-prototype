
/** The human-gate evidence of the Prime Runner Bridge: a verified gate commit and the bound decision comment. */
import { describe, expect, it } from 'vitest'
import { ApprovalError, approvalIsCurrent, revoke, verifyGateCommit, verifyGateDecision,
  type ApprovalEvidence, type GateDecisionSource, type GateExpectations } from '../src/app/prime-approval.ts'
import type { CommitEvidence } from '../src/sources/github-read.ts'
import type { ApprovalRecord } from '../src/executor/prime-model.ts'

const SHA = 'e'.repeat(40)
const PARENT = 'd'.repeat(40)
const DIGEST = 'a'.repeat(64)
const TASKS = 'specs/001-feature/tasks.md'
const LINE = 'T031 [US2] Test the gate approval protocol'

const commit = (over: Partial<CommitEvidence> = {}): CommitEvidence => ({
  sha: SHA,
  parent: PARENT,
  author: { id: 7, login: 'octocat', type: 'User' },
  committer: { login: 'web-flow' },
  verification: { verified: true, reason: 'valid', signer: { id: 7, login: 'octocat', type: 'User' } },
  changed: [{ path: TASKS, added: [`- [x] ${LINE}`], removed: [`- [ ] ${LINE}`] }],
  ...over,
})

const expectations = (over: Partial<GateExpectations> = {}): GateExpectations => ({
  gateId: 'T031', tasksPath: TASKS, taskLine: LINE, parent: PARENT, allowlist: ['octocat'], ...over,
})

const decisionBody = (over: Partial<{ gateId: string; digest: string; sha: string }> = {}) =>
  `@dsh-agent APPROVE GATE ${over.gateId ?? 'T031'} ${over.digest ?? DIGEST} ${over.sha ?? SHA}`

const evidence = (over: Partial<ApprovalEvidence> = {}): ApprovalEvidence => ({
  commentId: 'comment-9', commentBody: decisionBody(),
  actor: { id: 7, login: 'octocat', type: 'User' }, repoId: 42, at: '2026-11-01T00:00:00.000Z', ...over,
})

const source = (over: Partial<GateDecisionSource> & { comments?: Record<string, ApprovalEvidence | undefined> } = {}) => {
  const comments = over.comments ?? { 'comment-9': evidence() }
  const value: GateDecisionSource = {
    allowlist: () => ['octocat'],
    policyVersion: () => 'policy-1',
    fetchComment: async (id: string) => comments[id],
    ...over,
  }
  return value
}

const request = (over: Partial<Parameters<typeof verifyGateDecision>[1]> = {}) => ({
  ticketId: 'ticket-1', triggerId: 'trigger-1', commentId: 'comment-9', gateId: 'T031',
  manifestSha256: DIGEST, commitSha: SHA, editorLogin: 'octocat', policyVersion: 'policy-1', ...over,
})

describe('the gate commit', () => {
  it('accepts a verified commit by the allowlisted human that changes exactly the gate checkbox', () => {
    const verified = verifyGateCommit(commit(), expectations())
    expect(verified.sha).toBe(SHA)
    expect(verified.author.login).toBe('octocat')
  })

  it('refuses an unsigned commit and a generic verified badge', () => {
    const unsigned = commit({ verification: { verified: false, reason: 'unsigned', signer: undefined } })
    expect(() => verifyGateCommit(unsigned, expectations())).toThrow(ApprovalError)
    const badge = commit({ verification: { verified: true, reason: 'valid', signer: undefined } })
    expect(() => verifyGateCommit(badge, expectations())).toThrow(ApprovalError)
  })

  it('refuses a signer who is not allowlisted and an author who is not that account', () => {
    const other = commit({ verification: { verified: true, reason: 'valid', signer: { id: 9, login: 'stranger', type: 'User' } } })
    expect(() => verifyGateCommit(other, expectations())).toThrow(/allowlist/)
    const mismatch = commit({ author: { id: 9, login: 'stranger', type: 'User' } })
    expect(() => verifyGateCommit(mismatch, expectations())).toThrow(/author/)
  })

  it('refuses a bot author and an unknown author type', () => {
    const bot = commit({ author: { id: 7, login: 'octocat', type: 'Bot' } })
    expect(() => verifyGateCommit(bot, expectations())).toThrow(/author/)
    const unknown = commit({ author: { id: 7, login: 'octocat', type: 'Unknown' } })
    expect(() => verifyGateCommit(unknown, expectations())).toThrow(/author/)
  })

  it('refuses a commit on another parent', () => {
    expect(() => verifyGateCommit(commit({ parent: 'f'.repeat(40) }), expectations())).toThrow(/parent/)
  })

  it('refuses a diff that changes more than the gate checkbox', () => {
    const two = commit({ changed: [{ path: TASKS, added: [`- [x] ${LINE}`, '- [x] T032 [US2] Something else'], removed: [`- [ ] ${LINE}`, '- [ ] T032 [US2] Something else'] }] })
    expect(() => verifyGateCommit(two, expectations())).toThrow(ApprovalError)
    const otherText = commit({ changed: [{ path: TASKS, added: [`- [x] ${LINE} and more`], removed: [`- [ ] ${LINE}`] }] })
    expect(() => verifyGateCommit(otherText, expectations())).toThrow(ApprovalError)
    const otherTask = commit({ changed: [{ path: TASKS, added: ['- [x] T030 [US2] Another task'], removed: ['- [ ] T030 [US2] Another task'] }] })
    expect(() => verifyGateCommit(otherTask, expectations())).toThrow(ApprovalError)
    const otherFile = commit({ changed: [{ path: 'README.md', added: [`- [x] ${LINE}`], removed: [`- [ ] ${LINE}`] }] })
    expect(() => verifyGateCommit(otherFile, expectations())).toThrow(ApprovalError)
  })

  it('refuses a gate commit that is not the branch head', () => {
    const behind = commit({ head: 'f'.repeat(40) })
    expect(() => verifyGateCommit(behind, expectations())).toThrow(/head/)
    expect(() => verifyGateCommit(commit(), expectations({ head: 'f'.repeat(40) }))).toThrow(/head/)
  })

  it('refuses an edited marker', () => {
    const edited = commit({ changed: [{ path: TASKS, added: [`- [ ] ${LINE}`], removed: [`- [x] ${LINE}`] }] })
    expect(() => verifyGateCommit(edited, expectations())).toThrow(ApprovalError)
  })
})

describe('the gate decision', () => {
  it('records the decision of the same allowlisted human', async () => {
    const record: ApprovalRecord = await verifyGateDecision(source(), request())
    expect(record.kind).toBe('gate')
    expect(record.decision).toBe('approved')
    expect(record.gateId).toBe('T031')
    expect(record.gateCommit).toBe(SHA)
    expect(record.manifestSha256).toBe(DIGEST)
    expect(record.actor.login).toBe('octocat')
  })

  it('refuses a denied, unrelated, stale or edited decision', async () => {
    const denied = source({ comments: { 'comment-9': evidence({ commentBody: `@dsh-agent DENY GATE T031 ${DIGEST} ${SHA}` }) } })
    await expect(verifyGateDecision(denied, request())).rejects.toThrow(ApprovalError)
    const unrelated = source({ comments: { 'comment-9': evidence({ commentBody: 'looks good to me' }) } })
    await expect(verifyGateDecision(unrelated, request())).rejects.toThrow(ApprovalError)
    const stale = source({ comments: { 'comment-9': evidence({ commentBody: decisionBody({ digest: 'b'.repeat(64) }) }) } })
    await expect(verifyGateDecision(stale, request())).rejects.toThrow(/manifest/)
    const wrongCommit = source({ comments: { 'comment-9': evidence({ commentBody: decisionBody({ sha: 'f'.repeat(40) }) }) } })
    await expect(verifyGateDecision(wrongCommit, request())).rejects.toThrow(/commit/)
    const edited = source({ comments: { 'comment-9': evidence({ commentBody: `${decisionBody()} thanks` }) } })
    await expect(verifyGateDecision(edited, request())).rejects.toThrow(ApprovalError)
    const deleted = source({ comments: {} })
    await expect(verifyGateDecision(deleted, request())).rejects.toThrow(/comment/)
  })

  it('refuses an unauthorized, bot-authored or different-human decision', async () => {
    const unauthorized = source({ allowlist: () => ['someone-else'] })
    await expect(verifyGateDecision(unauthorized, request())).rejects.toThrow(/allowlist/)
    const bot = source({ comments: { 'comment-9': evidence({ actor: { id: 7, login: 'octocat', type: 'Bot' } }) } })
    await expect(verifyGateDecision(bot, request())).rejects.toThrow(ApprovalError)
    const other = source({ comments: { 'comment-9': evidence({ actor: { id: 9, login: 'stranger', type: 'User' } }) } })
    await expect(verifyGateDecision(other, request())).rejects.toThrow(/human/)
  })

  it('does not count a plain yes or a pull request review', async () => {
    const yes = source({ comments: { 'comment-9': evidence({ commentBody: 'yes' }) } })
    await expect(verifyGateDecision(yes, request())).rejects.toThrow(ApprovalError)
    const review = source({ comments: { 'comment-9': evidence({ commentBody: 'Approved' }) } })
    await expect(verifyGateDecision(review, request())).rejects.toThrow(ApprovalError)
  })

  it('refuses a decision under a changed policy version', async () => {
    const changed = source({ policyVersion: () => 'policy-2' })
    await expect(verifyGateDecision(changed, request())).rejects.toThrow(/policy/)
  })

  it('withdraws the decision when the allowlist entry is revoked', async () => {
    const record = await verifyGateDecision(source(), request())
    expect(approvalIsCurrent(record, ['octocat'])).toBe(true)
    expect(approvalIsCurrent(record, [])).toBe(false)
    expect(revoke(record, []).decision).toBe('denied')
  })
})
