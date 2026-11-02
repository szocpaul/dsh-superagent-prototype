/**
 * Pull request delivery for the Prime Runner Bridge: the controller owns the publication of a run segment.
 * The delivery never merges, never enables auto-merge, and pushes the result under an expected-old-SHA lease so a
 * changed branch head is never overwritten.
 */

import type { ReportedCheck } from './prime-model.ts'

/** A pull request the controller created or updated. */
export interface PullRef {
  /** The pull request number. */
  number: number
  /** The pull request URL. */
  url: string
}

/** The observed state of one pull request. */
export interface PullState {
  /** `open` or `closed`. */
  state: string
  /** Whether the pull request is still a draft. */
  draft: boolean
  /** Whether auto-merge is enabled on the pull request. */
  autoMerge: boolean
  /** The head branch of the pull request. */
  head: string
  /** The base branch of the pull request. */
  base: string
  /** The pull request URL. */
  url: string
}

/** The server-enforced protection of a branch. */
export interface BranchProtection {
  /** Whether a protection rule is enforced on the branch. */
  required: boolean
  /** Whether the rule forbids the controller's merge and bypass privileges. */
  forbidsMerge: boolean
}

/** The fields the controller sets when it creates a pull request. */
export interface CreatePullInput {
  title: string
  body: string
  head: string
  base: string
  draft: boolean
}

/** The fields the controller sets when it updates a pull request. */
export interface UpdatePullInput {
  title: string
  body: string
  draft: boolean
}

/** The remote operations the delivery needs. Tests replace them with fakes. */
export interface PullPort {
  /** The current commit of a branch, or undefined when the branch does not exist. */
  branchHead(branch: string): Promise<string | undefined>
  /** Creates a pull request. */
  createPull(input: CreatePullInput): Promise<PullRef>
  /** Updates an existing pull request. */
  updatePull(number: number, input: UpdatePullInput): Promise<PullRef>
  /** Pushes a commit to a branch under an expected-old-SHA lease. */
  pushRef(branch: string, commit: string, expectedOldSha: string): Promise<{ ok: boolean; reason?: string }>
  /** Reads the current state of a pull request. */
  pull(number: number): Promise<PullState>
  /** The open pull request that publishes a branch, when there is one. */
  pullForBranch(branch: string): Promise<number | undefined>
  /** The tree of a revision, so a branch that already carries a result can be recognized. */
  treeOf(revision: string): Promise<string | undefined>
  /** Reads the server-enforced protection of a branch. */
  branchProtection(branch: string): Promise<BranchProtection>
}

/** One piece of evidence a gate draft presents to the reviewer. */
export interface DeliveryEvidence {
  /** What the evidence is, such as `Completed tasks`. */
  label: string
  /** The evidence itself. */
  detail: string
}

/** What one delivery publishes. */
export interface DeliveryRequest {
  /** The Ticket the delivery belongs to. */
  ticketId: string
  /** The segment the delivery belongs to. */
  segmentId: string
  /** The branch the segment worked on. */
  branch: string
  /** The branch the pull request targets. */
  base: string
  /** The controller-created commit that holds the result. */
  commit: string
  /** The branch head the segment started from; the push lease uses it. */
  expectedOldSha: string
  /** The pull request title. */
  title: string
  /** The summary of changes. */
  summary: string
  /** The checks the controller reran, with their actual results. */
  checks: ReportedCheck[]
  /** The material limitations of the result. */
  limitations: string[]
  /** Whether the pull request is a draft that presents gate evidence. */
  draft?: boolean
  /** The pull request this delivery updates, when the segment already has one. */
  pullNumber?: number
  /** The evidence a gate draft presents. */
  evidence?: DeliveryEvidence[]
}

/** The delivery published the pull request. */
export interface DeliveredResult {
  status: 'delivered'
  /** The pull request number. */
  pullNumber: number
  /** The pull request URL. */
  url: string
  /** Whether the pull request is a draft. */
  draft: boolean
  /** The body that was published. */
  body: string
  /** Whether the pull request was created instead of updated. */
  created: boolean
}

/** The delivery stopped and needs one operator action. */
export interface BlockedResult {
  status: 'blocked'
  /** Why the delivery stopped. */
  reason: string
  /** The one action an operator must take. */
  nextAction: string
}

/** The remote outcome of the delivery is unknown and stays with the operator. */
export interface UnknownResult {
  status: 'unknown'
  /** The remote operation whose result was lost. */
  operation: string
  /** What is known about the outcome. */
  reason: string
  /** The one action an operator must take. */
  nextAction: string
  /** The delivery never retried the operation on its own. */
  retried: false
  /** The delivery never claims that it rolled the remote action back. */
  rolledBack: false
}

/** The result of one delivery attempt. */
export type DeliveryResult = DeliveredResult | BlockedResult | UnknownResult

/** The record of which pull request a segment owns, so a second delivery updates it. */
export interface DeliveryLedger {
  /** The pull request number of a segment, when it has one. */
  find(segmentId: string): number | undefined
  /** Records the pull request number of a segment. */
  record(segmentId: string, pullNumber: number): void
  /** Retains an unknown remote outcome, so an operator can resolve it. */
  unknown(segmentId: string, result: UnknownResult): void
  /** The unknown remote outcomes the ledger retains. */
  unknowns(): { segmentId: string; result: UnknownResult }[]
}

/** Creates an in-memory delivery ledger. A durable one stores the same records in the Store. */
export const createDeliveryLedger = (): DeliveryLedger => {
  const records = new Map<string, number>()
  const unknowns: { segmentId: string; result: UnknownResult }[] = []
  return {
    find: segmentId => records.get(segmentId),
    record: (segmentId, pullNumber) => { records.set(segmentId, pullNumber) },
    unknown: (segmentId, result) => { unknowns.push({ segmentId, result }) },
    unknowns: () => [...unknowns],
  }
}

/** Checks the server-enforced protection; a repository write permission alone is not enough. */
export const assertNoMergeRights = (protection: BranchProtection): { ok: boolean; reason?: string } => {
  if (protection.required && protection.forbidsMerge) return { ok: true }
  return {
    ok: false,
    reason: 'the target branch has no server-enforced branch protection that forbids the controller merge and bypass privileges',
  }
}

/** Checks that the pull request has no auto-merge; an enabled auto-merge needs a human, never a silent change. */
export const noAutoMerge = (pull: PullState): { ok: boolean; reason?: string; nextAction?: string } => {
  if (!pull.autoMerge) return { ok: true }
  return {
    ok: false,
    reason: `auto-merge is enabled on the pull request; the controller never merges and never changes the auto-merge state`,
    nextAction: 'a human must disable auto-merge on the pull request before the delivery continues',
  }
}

/** Keeps a lost remote result as an unknown state; it is never retried blindly and never reported as a rollback. */
export const reconcileUnknown = (outcome: { operation: string; error: string }): UnknownResult => ({
  status: 'unknown',
  operation: outcome.operation,
  reason: `the result of the remote operation ${outcome.operation} was lost: ${outcome.error}`,
  nextAction: 'an operator must read the remote state and decide whether the operation already happened before anything is repeated',
  retried: false,
  rolledBack: false,
})

/** Renders the check results the controller actually observed. */
const renderChecks = (checks: ReportedCheck[]): string => {
  if (checks.length === 0) return 'No checks were rerun for this result.'
  const lines = checks.map(check => `- \`${check.name}\` — exit code ${check.exitCode} (evidence: \`${check.evidence}\`)`)
  const passed = checks.filter(check => check.exitCode === 0).length
  lines.push('')
  lines.push(`Checks reported: ${checks.length} total, ${passed} passed, ${checks.length - passed} failed.`)
  return lines.join('\n')
}

/** Renders the body of the pull request: summary, actual checks, and material limitations. */
export const renderDeliveryBody = (request: DeliveryRequest): string => {
  const sections = ['## Summary', '', request.summary, '', '## Checks', '', renderChecks(request.checks)]
  if (request.limitations.length > 0) {
    sections.push('', '## Limitations', '', ...request.limitations.map(item => `- ${item}`))
  }
  if (request.evidence && request.evidence.length > 0) {
    sections.push('', '## Evidence', '', ...request.evidence.map(item => `- ${item.label}: ${item.detail}`))
  }
  if (request.draft) {
    sections.push('', 'This pull request is a draft for gate review. The ticket and the feature are not ready.')
  }
  return sections.join('\n')
}

/** Builds the draft pull request that presents gate-review evidence; it never marks the ticket or feature ready. */
export const draftForGate = (request: DeliveryRequest): { input: CreatePullInput; ready: false } => ({
  input: {
    title: request.title,
    body: renderDeliveryBody({ ...request, draft: true }),
    head: request.branch,
    base: request.base,
    draft: true,
  },
  ready: false,
})

/**
 * Publishes the result of one segment: it pushes the controller-created commit under an expected-old-SHA lease and then
 * creates or updates the pull request with the summary of changes, the actual checks, and the material limitations.
 * A second delivery for the same segment updates the same pull request and never creates a second one.
 */
export const deliver = async (
  request: DeliveryRequest,
  port: PullPort,
  ledger?: DeliveryLedger,
): Promise<DeliveryResult> => {
  const unknown = (operation: string, error: unknown): UnknownResult => {
    const result = reconcileUnknown({ operation, error: String(error) })
    ledger?.unknown(request.segmentId, result)
    return result
  }
  let protection: BranchProtection
  try {
    // The protection that matters is the one of the branch the pull request lands on: the branch the result is
    // published from does not exist yet, and the merge rights are the ones of the target.
    protection = await port.branchProtection(request.base)
  } catch (error) {
    return unknown('branchProtection', error)
  }
  const rights = assertNoMergeRights(protection)
  if (!rights.ok) {
    return {
      status: 'blocked',
      reason: rights.reason!,
      nextAction: 'an operator must enable a server-enforced branch protection rule that forbids the controller merge and bypass privileges',
    }
  }

  const known = request.pullNumber ?? ledger?.find(request.segmentId) ?? await port.pullForBranch(request.branch)
  let state: PullState | undefined
  if (known !== undefined) {
    try {
      state = await port.pull(known)
    } catch (error) {
      return unknown('pull', error)
    }
    if (state.state !== 'open') {
      return {
        status: 'blocked',
        reason: `the existing pull request #${known} is ${state.state} and cannot be updated`,
        nextAction: 'an operator must decide whether a new pull request may be opened',
      }
    }
    const merge = noAutoMerge(state)
    if (!merge.ok) {
      return { status: 'blocked', reason: merge.reason!, nextAction: merge.nextAction! }
    }
    if (state.head !== request.branch || state.base !== request.base) {
      return {
        status: 'blocked',
        reason: `the existing pull request #${known} points at ${state.base}...${state.head} instead of ${request.base}...${request.branch}`,
        nextAction: 'an operator must decide which branch the delivery may publish to',
      }
    }
  }

  let head: string | undefined
  try {
    head = await port.branchHead(request.branch)
  } catch (error) {
    return unknown('branchHead', error)
  }
  // The branch may already carry this result: a delivery that ran before published it and read its outcome back.
  // Such a head is the delivery's own publication, not a change somebody else made.
  const headTree = head === undefined ? undefined : await port.treeOf(head)
  const commitTree = await port.treeOf(request.commit)
  const published = head === undefined || head === request.commit || head === request.expectedOldSha
    || (headTree !== undefined && commitTree !== undefined && headTree === commitTree)
  if (head !== undefined && !published) {
    return {
      status: 'blocked',
      reason: `the branch head ${head} changed since the segment started; the delivery never overwrites it`,
      nextAction: 'an operator must reconcile the changed branch head before the result is published again',
    }
  }
  if (head !== request.commit) {
    let pushed: { ok: boolean; reason?: string }
    try {
      // The lease names the head the delivery verified, so a change between the check and the push is still refused.
      pushed = await port.pushRef(request.branch, request.commit, head ?? request.expectedOldSha)
    } catch (error) {
      return unknown('pushRef', error)
    }
    if (!pushed.ok) {
      return {
        status: 'blocked',
        reason: `the push was refused under the expected-old-SHA lease: ${pushed.reason ?? 'the branch head changed'}`,
        nextAction: 'an operator must reconcile the branch head before the result is published again',
      }
    }
  }

  const draft = request.draft ?? state?.draft ?? false
  const body = renderDeliveryBody({ ...request, draft })
  const input = { title: request.title, body, draft }
  try {
    if (known !== undefined) {
      const updated = await port.updatePull(known, input)
      return { status: 'delivered', pullNumber: updated.number, url: updated.url, draft, body, created: false }
    }
    const created = await port.createPull({ ...input, head: request.branch, base: request.base })
    ledger?.record(request.segmentId, created.number)
    return { status: 'delivered', pullNumber: created.number, url: created.url, draft, body, created: true }
  } catch (error) {
    return unknown(known === undefined ? 'createPull' : 'updatePull', error)
  }
}
