
/**
 * The approval protocol of the Prime Runner Bridge: an allowlisted human approves one exact manifest, and a human
 * gate is continued only by a verified gate commit plus a bound decision comment. Every approval is re-read from the
 * source and revalidated against the current allowlist, policy, and manifest before it is recorded.
 */
import { randomUUID } from 'node:crypto'
import { bytesDigest, manifestDigest } from '../executor/prime-manifest.ts'
import type { ApprovalActor, ApprovalRecord, ApprovedManifest } from '../executor/prime-model.ts'
import type { CommitEvidence, GithubCommentEvidence } from '../sources/github-read.ts'

/** Raised when an approval or a gate decision is refused; the message names what is missing. */
export class ApprovalError extends Error {
  constructor(message: string) { super(message); this.name = 'ApprovalError' }
}

/** The account types GitHub reports; only `User` may approve work. */
export type AccountType = 'User' | 'Bot' | 'App' | 'Unknown'

/** The evidence of one original-conversation comment, re-read from the source. */
export interface ApprovalEvidence {
  /** The comment's ID. */
  commentId: string
  /** The comment's current body. */
  commentBody: string
  /** The account that wrote the comment. */
  actor: { id: number; login: string; type: AccountType }
  /** The GitHub repository ID the comment belongs to. */
  repoId: number
  /** The comment's last update time. */
  at: string
}

/**
 * Builds the approval evidence of a comment the source just read, so a caller never has to copy the raw comment shape.
 * @param repoId The GitHub repository ID the comment belongs to.
 */
export function approvalEvidence(comment: GithubCommentEvidence, repoId: number): ApprovalEvidence {
  return { commentId: comment.commentId, commentBody: comment.body, actor: comment.actor, repoId, at: comment.at }
}

/** The source seams an approval needs: the current allowlist, the current policy, the comment, and the approved manifest. */
export interface ApprovalSource {
  /** The GitHub logins that may currently approve work. */
  allowlist(): readonly string[]
  /** The policy version in force now. */
  policyVersion(): string
  /** Re-reads one comment and its actor; undefined when the comment is gone. */
  fetchComment(commentId: string): Promise<ApprovalEvidence | undefined>
  /** The approved manifest of a Ticket, when one exists. */
  manifest(ticketId: string): ApprovedManifest | undefined
}

/** The durable record store an approval is written to; the Store's `bridge.approvals` satisfies it. */
export interface ApprovalStore {
  /** Saves one approval record. */
  save(record: ApprovalRecord): void
  /** Reads one approval record by its ID. */
  get(approvalId: string): ApprovalRecord | undefined
}

/** What a human approves: one exact manifest of one Ticket. */
export interface RunApprovalRequest {
  /** The Ticket the run belongs to. */
  ticketId: string
  /** The trigger that raised the request the approval answers. */
  triggerId: string
  /** The comment that carries the decision. */
  commentId: string
  /** The manifest digest the human reviewed. */
  manifestSha256: string
  /** The policy version in force when the human was asked. */
  policyVersion: string
}

/** The decision a comment expresses: an approval, a denial, or nothing the protocol accepts. */
export type ApprovalDecision = 'approved' | 'denied'

const RUN_APPROVAL = /^@([A-Za-z0-9][A-Za-z0-9-]*) (APPROVE|DENY) RUN ([0-9a-f]{64})$/

/** The decision a run comment expresses, with the manifest digest it names. */
interface RunCommand {
  /** `approved` or `denied`. */
  decision: ApprovalDecision
  /** The manifest digest the comment names. */
  manifestSha256: string
}

/** Parses a run comment of the exact protocol form, whatever manifest it names. */
function decisionOf(text: string): RunCommand | undefined {
  const match = RUN_APPROVAL.exec(text.trim())
  if (!match) return undefined
  return { decision: match[2] === 'APPROVE' ? 'approved' : 'denied', manifestSha256: match[3]! }
}

/**
 * Parses the run approval comment protocol: `@<agent> APPROVE RUN <manifest-sha256>` approves the named manifest and
 * `DENY RUN` denies it. The whole comment must be that one line; a bare yes, a quoted command, a wrong digest, or any
 * other text is not a decision.
 * @returns The decision, or undefined when the comment does not carry the exact form for this manifest.
 */
export function parseRunApproval(text: string, manifestSha256: string): ApprovalDecision | undefined {
  const command = decisionOf(text)
  if (!command || command.manifestSha256 !== manifestSha256) return undefined
  return command.decision
}

/**
 * Checks that an approval is still current: it approved something, its actor is a human, and that human is still
 * allowlisted. A revoked allowlist entry withdraws the approval.
 */
export function approvalIsCurrent(approval: ApprovalRecord, allowlist: readonly string[]): boolean {
  return approval.decision === 'approved' && approval.actor.type === 'User' && allowlist.includes(approval.actor.login)
}

/**
 * Withdraws an approval whose actor is no longer allowlisted.
 * @returns The withdrawn record, or the unchanged record when its actor is still allowlisted.
 */
export function revoke(approval: ApprovalRecord, allowlist: readonly string[]): ApprovalRecord {
  if (allowlist.includes(approval.actor.login)) return approval
  return { ...approval, decision: 'denied' }
}

const actorOf = (evidence: ApprovalEvidence): ApprovalActor =>
  ({ id: evidence.actor.id, login: evidence.actor.login, type: evidence.actor.type })

/**
 * Approves one exact manifest for one Ticket. The comment is re-read from the source, the actor must be a currently
 * allowlisted human, the comment must still carry the exact approval text, the approved manifest must still be the
 * manifest the comment names, and the policy version must not have changed. The caller's copy of the comment is never
 * trusted.
 * @throws ApprovalError when any of these checks fails; the message names what is missing.
 */
export async function approveRun(source: ApprovalSource, request: RunApprovalRequest, store?: ApprovalStore): Promise<ApprovalRecord> {
  const manifest = source.manifest(request.ticketId)
  if (!manifest) throw new ApprovalError(`There is no approved manifest for ${request.ticketId}`)
  const digest = manifestDigest(manifest)
  if (digest !== request.manifestSha256)
    throw new ApprovalError(`The approved manifest of ${request.ticketId} no longer matches the manifest the human reviewed`)
  const evidence = await source.fetchComment(request.commentId)
  if (!evidence) throw new ApprovalError(`The approval comment ${request.commentId} no longer exists`)
  if (evidence.actor.type !== 'User')
    throw new ApprovalError(`The account ${evidence.actor.login} is not a human account and may not approve a run`)
  if (!source.allowlist().includes(evidence.actor.login))
    throw new ApprovalError(`The account ${evidence.actor.login} is not on the current allowlist`)
  const decision = decisionOf(evidence.commentBody)
  if (decision?.decision === 'denied') throw new ApprovalError(`The human denied the run of ${request.ticketId}`)
  if (!decision) throw new ApprovalError(`The comment ${request.commentId} does not carry the exact approval of manifest ${request.manifestSha256}`)
  if (decision.manifestSha256 !== request.manifestSha256)
    throw new ApprovalError(`The comment approves manifest ${decision.manifestSha256}, not the approved manifest ${request.manifestSha256}`)
  if (evidence.repoId !== manifest.repository.id)
    throw new ApprovalError(`The approval comment belongs to another repository than the approved manifest`)
  if (source.policyVersion() !== request.policyVersion)
    throw new ApprovalError(`The policy version changed from ${request.policyVersion} to ${source.policyVersion()}`)
  const record: ApprovalRecord = {
    approvalId: randomUUID(),
    kind: 'run',
    manifestId: digest,
    manifestSha256: digest,
    ticketId: request.ticketId,
    triggerId: request.triggerId,
    policyVersion: source.policyVersion(),
    repositoryId: manifest.repository.id,
    commentId: evidence.commentId,
    commentSha256: bytesDigest(evidence.commentBody),
    actor: actorOf(evidence),
    at: evidence.at,
    environmentApproved: true,
    decision: 'approved',
  }
  store?.save(record)
  return record
}

const GATE_APPROVAL = /^@([A-Za-z0-9][A-Za-z0-9-]*) (APPROVE|DENY) GATE (\S+) ([0-9a-f]{64}) ([0-9a-f]{40})$/

/** The decision a gate comment expresses, with the gate, manifest, and commit it names. */
interface GateCommand {
  /** `approved` or `denied`. */
  decision: ApprovalDecision
  /** The gate ID the comment names. */
  gateId: string
  /** The manifest digest the comment names. */
  manifestSha256: string
  /** The gate commit the comment names. */
  commitSha: string
}

function gateCommand(text: string): GateCommand | undefined {
  const match = GATE_APPROVAL.exec(text.trim())
  if (!match) return undefined
  return { decision: match[2] === 'APPROVE' ? 'approved' : 'denied', gateId: match[3]!, manifestSha256: match[4]!, commitSha: match[5]! }
}

/** What a gate commit must be: one verified edit of exactly one gate checkbox. */
export interface GateExpectations {
  /** The gate's task ID. */
  gateId: string
  /** The repository-relative path of the task list that holds the gate line. */
  tasksPath: string
  /** The gate line without its checkbox, exactly as the approved task list has it. */
  taskLine: string
  /** The revision the gate commit must build on. */
  parent: string
  /** The GitHub logins that may currently approve work. */
  allowlist: readonly string[]
  /** The revision the branch head must point at, when the caller read it. */
  head?: string
}

/** The verified evidence of one gate commit. */
export interface VerifiedGateCommit {
  /** The full commit SHA. */
  sha: string
  /** The account that made the gate edit. */
  author: ApprovalActor
}

/**
 * Verifies that one commit is the human's gate edit: a GitHub-authenticated commit whose verified signature is bound to
 * an allowlisted human, whose author is exactly that account, whose parent is the expected pre-gate revision, and whose
 * diff changes exactly the expected `[ ]` to `[x]` on the expected task line.
 * @throws ApprovalError when any of these checks fails; the message names what is missing.
 */
export function verifyGateCommit(evidence: CommitEvidence, expectations: GateExpectations): VerifiedGateCommit {
  if (!evidence.verification.verified)
    throw new ApprovalError(`The gate commit ${evidence.sha} is not a verified commit`)
  const signer = evidence.verification.signer
  if (!signer)
    throw new ApprovalError(`The gate commit ${evidence.sha} carries a generic verified badge that binds no account`)
  if (!expectations.allowlist.includes(signer.login))
    throw new ApprovalError(`The verified signer ${signer.login} is not on the current allowlist`)
  if (evidence.author.type !== 'User')
    throw new ApprovalError(`The gate commit ${evidence.sha} was authored by a ${evidence.author.type} account, not a human`)
  if (evidence.author.login !== signer.login || evidence.author.id !== signer.id)
    throw new ApprovalError(`The gate commit ${evidence.sha} has a different author than its verified signer`)
  if (evidence.parent !== expectations.parent)
    throw new ApprovalError(`The gate commit ${evidence.sha} has parent ${evidence.parent}, not the expected pre-gate revision ${expectations.parent}`)
  if (expectations.head !== undefined && expectations.head !== evidence.sha)
    throw new ApprovalError(`The gate commit ${evidence.sha} is not the expected branch head ${expectations.head}`)
  if (evidence.head !== undefined && evidence.head !== evidence.sha)
    throw new ApprovalError(`The gate commit ${evidence.sha} is not the branch head ${evidence.head}`)
  const expected = `- [ ] ${expectations.taskLine}`
  const marked = `- [x] ${expectations.taskLine}`
  const files = evidence.changed
  if (files.length !== 1 || files[0]!.path !== expectations.tasksPath)
    throw new ApprovalError(`The gate commit ${evidence.sha} changes files other than the task list`)
  const removed = files[0]!.removed
  const added = files[0]!.added
  if (removed.length !== 1 || added.length !== 1)
    throw new ApprovalError(`The gate commit ${evidence.sha} changes more than the one gate checkbox`)
  if (removed[0] !== expected || added[0] !== marked)
    throw new ApprovalError(`The gate commit ${evidence.sha} does not change exactly the ${expectations.gateId} checkbox`)
  return { sha: evidence.sha, author: { id: evidence.author.id, login: evidence.author.login, type: evidence.author.type } }
}

/** The source seams a gate decision needs: the current allowlist, the current policy, and the decision comment. */
export interface GateDecisionSource {
  /** The GitHub logins that may currently approve work. */
  allowlist(): readonly string[]
  /** The policy version in force now. */
  policyVersion(): string
  /** Re-reads one comment and its actor; undefined when the comment is gone. */
  fetchComment(commentId: string): Promise<ApprovalEvidence | undefined>
}

/** What a human decides about a gate: the gate, the manifest, and the commit they reviewed. */
export interface GateDecisionRequest {
  /** The Ticket the gate belongs to. */
  ticketId: string
  /** The trigger that raised the request the decision answers. */
  triggerId: string
  /** The comment that carries the decision. */
  commentId: string
  /** The gate the decision continues past. */
  gateId: string
  /** The manifest digest the human reviewed. */
  manifestSha256: string
  /** The full SHA of the human's gate commit. */
  commitSha: string
  /** The account that made the gate edit; the decision must come from the same human. */
  editorLogin: string
  /** The policy version in force when the human was asked. */
  policyVersion: string
}

/**
 * Verifies the decision comment of one gate: it must name the gate, the manifest digest, and the full gate commit SHA,
 * and it must come from the same currently allowlisted human who made the gate edit.
 * @throws ApprovalError when any of these checks fails; the message names what is missing.
 */
export async function verifyGateDecision(source: GateDecisionSource, request: GateDecisionRequest): Promise<ApprovalRecord> {
  const evidence = await source.fetchComment(request.commentId)
  if (!evidence) throw new ApprovalError(`The decision comment ${request.commentId} no longer exists`)
  if (evidence.actor.type !== 'User')
    throw new ApprovalError(`The account ${evidence.actor.login} is not a human account and may not decide a gate`)
  if (evidence.actor.login !== request.editorLogin)
    throw new ApprovalError(`The decision must come from the same human who made the gate edit, ${request.editorLogin}`)
  if (!source.allowlist().includes(evidence.actor.login))
    throw new ApprovalError(`The account ${evidence.actor.login} is not on the current allowlist`)
  const command = gateCommand(evidence.commentBody)
  if (!command) throw new ApprovalError(`The comment ${request.commentId} does not carry the exact gate decision`)
  if (command.decision === 'denied') throw new ApprovalError(`The human denied the gate ${request.gateId}`)
  if (command.gateId !== request.gateId)
    throw new ApprovalError(`The decision names gate ${command.gateId}, not the pending gate ${request.gateId}`)
  if (command.manifestSha256 !== request.manifestSha256)
    throw new ApprovalError(`The decision names manifest ${command.manifestSha256}, not the approved manifest ${request.manifestSha256}`)
  if (command.commitSha !== request.commitSha)
    throw new ApprovalError(`The decision names commit ${command.commitSha}, not the gate commit ${request.commitSha}`)
  if (source.policyVersion() !== request.policyVersion)
    throw new ApprovalError(`The policy version changed from ${request.policyVersion} to ${source.policyVersion()}`)
  return {
    approvalId: randomUUID(),
    kind: 'gate',
    manifestId: request.manifestSha256,
    manifestSha256: request.manifestSha256,
    ticketId: request.ticketId,
    triggerId: request.triggerId,
    policyVersion: source.policyVersion(),
    repositoryId: evidence.repoId,
    commentId: evidence.commentId,
    commentSha256: bytesDigest(evidence.commentBody),
    actor: actorOf(evidence),
    at: evidence.at,
    environmentApproved: true,
    decision: 'approved',
    gateId: request.gateId,
    gateCommit: request.commitSha,
  }
}
