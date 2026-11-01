/**
 * The human-gate protocol of the Prime Runner Bridge: the bounded segment that stops before a gate, the one question
 * the operator receives, the durable evidence of the gate, and the separately bounded segment that may follow an
 * approved gate.
 *
 * Everything here is pure. The gate is completed by a person only: the runner may not mark it, and no wake, report,
 * bot comment, or pull request review acts as the human decision.
 */
import type { ApprovalRecord, ApprovedManifest, ReportedCheck } from './prime-model.ts'
import { manifestDigest } from './prime-manifest.ts'
import { nextGate, segmentTasks, type TaskLine } from './prime-tasks.ts'

/** The bounded segment around one human gate. */
export interface GateSegment {
  /** The automated tasks the segment covers, in approved order. */
  segment: TaskLine[]
  /** The human gate the segment stops at, when the approved list has one. */
  gate?: TaskLine
  /** The tasks behind the gate; none of them is started before the gate is approved. */
  later: TaskLine[]
}

/**
 * Bounds the segment that ends before the first human gate.
 * @param tasks The approved task list.
 * @param from The index the segment starts at.
 * @returns The automated tasks of the segment, the gate it stops at, and the tasks behind the gate.
 */
export function gateSegment(tasks: readonly TaskLine[], from = 0): GateSegment {
  const gate = nextGate(tasks, from)
  const segment = segmentTasks(tasks, from)
  const later = gate ? tasks.slice(tasks.indexOf(gate) + 1) : []
  return { segment, gate, later }
}

/**
 * Builds the one question the operator receives at a gate.
 * The question names the gate, the approved manifest digest, and the two steps the reviewer has to take: a
 * GitHub-authenticated edit of exactly the one gate checkbox, bound to the reviewer's own identity, and the approval
 * comment in the original conversation.
 * @param gate The gate the run stopped at.
 * @param manifest The approved manifest the run is bound to.
 */
export function gateQuestion(gate: TaskLine, manifest: ApprovedManifest, agentLogin = ''): string {
  const digest = manifestDigest(manifest)
  const mention = agentLogin ? `@${agentLogin}` : '@<agent>' 
  return `The run stopped at the human gate ${gate.id}: ${gate.text}. `
    + `The approved manifest is ${digest}. `
    + `To continue, make exactly one change in the approved task list: set the checkbox of ${gate.id} from [ ] to [x], `
    + `with a GitHub-authenticated web edit whose verified signer is bound to your own identity. `
    + `Then reply in this conversation with \`${mention} APPROVE GATE ${gate.id} ${digest} <full-gate-commit-sha>\`. `
    + `Nothing behind the gate starts before that decision is recorded.`
}

/** The request the coordinator sends to the Ticket's original conversation. */
export interface GateDecisionRequest {
  /** The conversation the request goes to; the gate decision is only valid there. */
  channel: 'original-conversation'
  /** The gate the request is about. */
  gateId: string
  /** The manifest digest the decision has to name. */
  manifestSha256: string
  /** The text of the request. */
  text: string
}

/**
 * Builds the decision request of one gate.
 * @param gate The gate the run stopped at.
 * @param manifest The approved manifest the run is bound to.
 */
export function gateDecisionRequest(gate: TaskLine, manifest: ApprovedManifest): GateDecisionRequest {
  return {
    channel: 'original-conversation',
    gateId: gate.id,
    manifestSha256: manifestDigest(manifest),
    text: gateQuestion(gate, manifest),
  }
}

/** The evidence of the result the reviewer looks at. */
export interface GateResultEvidence {
  /** The controller-created revision that holds the result, when there is one. */
  resultRevision?: string
  /** The tasks the segment completed. */
  completedTaskIds: string[]
  /** The tasks that are not done, including the gate. */
  remainingTaskIds: string[]
  /** The checks the controller reran, with their actual results. */
  checks: ReportedCheck[]
  /** A short summary of the completed work. */
  summary: string
}

/** The proof that the runner stopped before the gate. */
export interface GateStopConfirmation {
  /** Whether the stop was proven. */
  confirmed: boolean
  /** The verdict the supervisor gave. */
  verdict: 'stopped' | 'unconfirmed' | 'unknown'
}

/** The draft pull request that presents the gate evidence. */
export interface GateDraftPullRequest {
  /** The pull request number. */
  number: number
  /** The pull request URL. */
  url?: string
  /** A gate pull request is always a draft; it never claims readiness. */
  draft: true
  /** The body of the draft, which presents the evidence. */
  body: string
}

/** The durable record of one gate. */
export interface GateEvidence {
  /** The gate the run stopped at. */
  gateId: string
  /** The manifest digest the gate belongs to. */
  manifestSha256: string
  /** The exact question the operator received. */
  question: string
  /** The evidence of the result under review. */
  result: GateResultEvidence
  /** The confirmation that the runner stopped. */
  stop: GateStopConfirmation
  /** The draft pull request that presents the evidence, when one was opened. */
  draftPr?: GateDraftPullRequest
  /** The Ticket state while it waits; a gate is never `ready`. */
  ticketState: 'waiting'
}

/** The input of the gate evidence. */
export interface GateEvidenceInput {
  /** The gate the run stopped at. */
  gate: TaskLine
  /** The approved manifest the run is bound to. */
  manifest: ApprovedManifest
  /** The exact question the operator received. */
  question: string
  /** The evidence of the result under review. */
  result: GateResultEvidence
  /** The confirmation that the runner stopped. */
  stop: GateStopConfirmation
  /** The draft pull request that presents the evidence. */
  draftPr?: { number: number; url?: string }
  /** The branch the draft is bound to. */
  branch?: string
}

/**
 * Renders the body of the draft pull request that presents the gate evidence. The body states that the pull request is
 * a draft for gate review and that neither the Ticket nor the feature is ready.
 */
export function gateDraftBody(evidence: GateEvidence, branch?: string): string {
  const checks = evidence.result.checks.length
    ? evidence.result.checks.map(check => `- \`${check.name}\` — exit code ${check.exitCode} (evidence: \`${check.evidence}\`)`).join('\n')
    : 'No checks were rerun for this segment.'
  const sections = [
    `## Human gate ${evidence.gateId}`,
    '',
    evidence.question,
    '',
    '## Evidence',
    '',
    `- Approved manifest: ${evidence.manifestSha256}`,
    `- Completed tasks: ${evidence.result.completedTaskIds.join(', ') || 'none'}`,
    `- Remaining tasks: ${evidence.result.remainingTaskIds.join(', ') || 'none'}`,
    `- Runner stop: ${evidence.stop.verdict}${evidence.stop.confirmed ? ' (confirmed)' : ' (not confirmed)'}`,
    '',
    '## Checks',
    '',
    checks,
  ]
  if (branch) sections.push('', `Bound to the branch \`${branch}\`.`)
  sections.push('', 'This pull request is a draft for gate review. The ticket and the feature are not ready.')
  return sections.join('\n')
}

/**
 * Builds the durable evidence of one gate: the gate identity, the question, the result evidence, the stop
 * confirmation, and the optional draft pull request that presents it.
 */
export function gateEvidence(input: GateEvidenceInput): GateEvidence {
  const evidence: GateEvidence = {
    gateId: input.gate.id,
    manifestSha256: manifestDigest(input.manifest),
    question: input.question,
    result: input.result,
    stop: input.stop,
    ticketState: 'waiting',
  }
  if (input.draftPr) {
    evidence.draftPr = {
      number: input.draftPr.number,
      url: input.draftPr.url,
      draft: true,
      body: gateDraftBody(evidence, input.branch),
    }
  }
  return evidence
}

/** Raised when a gate record does not match the request it belongs to; the message names the mismatch. */
export class GateError extends Error {
  constructor(message: string) { super(message); this.name = 'GateError' }
}

/** The state of a Ticket that waits at a gate. */
export interface GateWait {
  /** `waiting` when the operator was reached, `attention` when the conversation could not be reached. */
  status: 'waiting' | 'attention'
  /** The evidence of the gate; it stays available whatever happened to the request. */
  evidence: GateEvidence
  /** The continuation is blocked until an approved, verified, bound decision exists. */
  continuationBlocked: true
  /** Why the operator could not be reached, when the request did not arrive. */
  reason?: string
}

/**
 * Records that a run waits at a gate.
 * @param request The request the coordinator tried to deliver.
 * @param evidence The durable evidence of the gate.
 * @param delivery Whether the request reached the original conversation, and why not when it did not.
 */
export function gateWait(
  request: GateDecisionRequest,
  evidence: GateEvidence,
  delivery: { delivered: boolean; reason?: string },
): GateWait {
  if (evidence.gateId !== request.gateId)
    throw new GateError(`The request is about the gate ${request.gateId}, but the evidence belongs to ${evidence.gateId}`)
  const wait: GateWait = {
    status: delivery.delivered ? 'waiting' : 'attention',
    evidence,
    continuationBlocked: true,
  }
  if (!delivery.delivered && delivery.reason) wait.reason = delivery.reason
  return wait
}

/** The kind of event the coordinator may receive while a run waits at a gate. */
export type GateEventKind = 'wake' | 'comment' | 'report' | 'pull-request-review'

/** One event that could be mistaken for a gate approval. */
export interface GateEvent {
  /** What the event is. */
  kind: GateEventKind
  /** The account that caused the event, when it has one. */
  actor?: { id: number; login: string; type: 'User' | 'Bot' | 'App' | 'Unknown' }
  /** The text of a comment or a report. */
  text?: string
  /** The review state of a pull request review. */
  reviewState?: string
}

/** The verdict about an event. */
export interface GateEventVerdict {
  /** Whether the event may be read as a gate decision at all. */
  candidate: boolean
  /** Why the event is not a gate decision. */
  reason?: string
}

/**
 * Decides whether an event may be read as a gate decision. Only a comment of a human account in the original
 * conversation may; a generic wake, a bot comment, a runner report, and a pull request review never are, whatever
 * their text says.
 */
export function gateDecisionCandidate(event: GateEvent): GateEventVerdict {
  if (event.kind === 'wake') return { candidate: false, reason: 'a generic wake is not a gate decision' }
  if (event.kind === 'report') return { candidate: false, reason: 'a runner report is not a gate decision' }
  if (event.kind === 'pull-request-review')
    return { candidate: false, reason: 'a pull request review is not a gate decision' }
  if (event.actor?.type !== 'User')
    return { candidate: false, reason: `the account ${event.actor?.login ?? 'unknown'} is not a human and may not decide a gate` }
  return { candidate: true }
}

/** The separately bounded segment that follows an approved gate. */
export interface NextSegment {
  /** Whether the continuation may start. */
  ok: boolean
  /** The tasks of the next segment, when it may start. */
  segment: TaskLine[]
  /** The next human gate the new segment stops at, when there is one. */
  gate?: TaskLine
  /** Why the continuation is refused. */
  reason?: string
}

/**
 * Bounds the segment that follows an approved gate. The continuation needs an approved decision of a human, bound to
 * the gate and to the manifest, that names the human's verified gate commit, and the gate itself has to be marked
 * complete by that human in the task list.
 * @param tasks The current task list, after the human's gate edit.
 * @param gateId The gate the decision continues past.
 * @param approval The recorded gate decision, when there is one.
 */
export function nextSegment(tasks: readonly TaskLine[], gateId: string, approval?: ApprovalRecord): NextSegment {
  const refuse = (reason: string): NextSegment => ({ ok: false, segment: [], reason })
  if (!approval) return refuse('there is no gate decision')
  if (approval.kind !== 'gate') return refuse('the recorded decision is not a gate decision')
  if (approval.decision !== 'approved') return refuse('the gate decision was denied')
  if (approval.gateId !== gateId) return refuse(`the recorded decision is about the gate ${approval.gateId ?? 'none'}, not ${gateId}`)
  if (!approval.gateCommit) return refuse('the recorded decision names no gate commit')
  if (approval.actor.type !== 'User') return refuse(`the account ${approval.actor.login} is not a human and may not decide a gate`)
  if (!/^[0-9a-f]{64}$/.test(approval.manifestSha256)) return refuse('the recorded decision names no approved manifest')
  const index = tasks.findIndex(task => task.id === gateId)
  if (index < 0) return refuse(`the task list has no gate ${gateId}`)
  if (tasks[index]!.kind !== 'human') return refuse(`the task ${gateId} is not a human gate`)
  if (!tasks[index]!.checked) return refuse(`the human has not marked the gate ${gateId} complete`)
  const bounded = gateSegment(tasks, index + 1)
  return { ok: true, segment: bounded.segment, gate: bounded.gate }
}

/** The scope of the convergence assessment of a run that stops at a gate. */
export interface GateAssessmentScope {
  /** `segment` before a gate, `full` after the last segment. */
  scope: 'segment' | 'full'
  /** The tasks the assessment covers. */
  assessedTaskIds: string[]
  /** The tasks the assessment does not cover, because a person has to act first. */
  notAssessedTaskIds: string[]
  /** The findings stay proposals; new work needs a new approved manifest. */
  findingsAreProposals: true
}

/**
 * Bounds the convergence assessment of a run that waits at a gate: the assessment covers the approved segment only, and
 * the gate and the tasks behind it are recorded as not assessed. A finding never changes the approved scope, so new
 * work needs a new approved manifest.
 * @param tasks The approved task list.
 * @param from The index the segment starts at.
 */
export function gateAssessmentScope(tasks: readonly TaskLine[], from = 0): GateAssessmentScope {
  const bounded = gateSegment(tasks, from)
  const assessedTaskIds = bounded.segment.map(task => task.id)
  const behind = bounded.gate ? [bounded.gate, ...bounded.later] : []
  const notAssessedTaskIds = behind.map(task => task.id)
  return {
    scope: bounded.gate ? 'segment' : 'full',
    assessedTaskIds,
    notAssessedTaskIds,
    findingsAreProposals: true,
  }
}
