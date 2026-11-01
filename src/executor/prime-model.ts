/**
 * Shared record types for the Prime Runner Bridge: the approved manifest, its approval evidence, run segments,
 * the runner's report, and the controller's verification of it. Every record here is durable data, never authority:
 * the controller revalidates source evidence, the current policy, and the manifest before acting on it.
 */

/** One task of the approved task list, in approved order. */
export interface ApprovedTask {
  /** The task's unique ID, such as `T012`. */
  id: string
  /** `automated` tasks the runner may complete; `human` tasks are gates that only a person may complete. */
  kind: 'automated' | 'human'
  /** Position in the approved order, starting at 0. */
  order: number
  /** The task's original text, without its marker. */
  text: string
}

/** An operator-approved check the controller reruns against the exact result revision. */
export interface ApprovedCheck {
  /** The check's stable name, such as `typecheck`. */
  name: string
  /** The command as an argument vector; it is never a shell string. */
  argv: string[]
  /** The working directory, relative to the repository root. */
  cwd: string
  /** How long the check may run, in milliseconds. */
  timeoutMs: number
}

/** The execution environment a manifest approves, including the isolation and credential categories. */
export interface ApprovedEnvironment {
  /** The deployment this run belongs to. */
  deploymentId: string
  /** The runner CLI and the version preflight verified. */
  runner: { cli: string; version: string }
  /** The model backend the runner uses. */
  model: { provider: string; id: string }
  /** The isolation backend and the paths the runner may write. */
  isolation: { backend: 'bubblewrap' | 'none'; writablePaths: string[]; network: 'none' | 'allowlist'; allowedEndpoints: string[] }
  /** Credential categories the runner may use; never values. */
  credentials: string[]
  /** The quota thresholds and the accounting scope they apply to. */
  quota: { warnTokens: number; stopTokens: number; maxWallMs: number; meteringScope: string }
  /** SHA-256 over the canonical encoding of this environment without its own digest. */
  digest: string
}

/** The approved manifest: the exact specification, plan, tasks, scope, checks, and environment one run may use. */
export interface ApprovedManifest {
  schemaVersion: 1
  /** The GitHub repository the run touches. */
  repository: { id: number; fullName: string }
  /** The repository-relative feature directory, such as `specs/001-prime-runner-bridge`. */
  featureDir: string
  /** The full immutable commit the approved artifacts come from. */
  baselineCommit: string
  /** SHA-256 over the exact baseline bytes of every authority-bearing artifact. */
  artifacts: { specSha256: string; planSha256: string; tasksSha256: string; constitutionSha256: string | null; guidanceSha256: string | null; hooksSha256: string | null; treeSha256: string }
  /** The unique repository-relative paths the runner may write. */
  allowedPaths: string[]
  /** The approved tasks, in approved order. */
  tasks: ApprovedTask[]
  /** The approved checks. */
  checks: ApprovedCheck[]
  /** The approved environment. */
  environment: ApprovedEnvironment
}

/** The GitHub account that approved a manifest or a gate, bound to an immutable account ID. */
export interface ApprovalActor {
  /** The immutable GitHub account ID. */
  id: number
  /** The account login at approval time. */
  login: string
  /** The account type; only `User` counts as a human here. */
  type: 'User' | 'Bot' | 'App' | 'Unknown'
}

/** The durable evidence of one approval decision, taken from an original-conversation comment. */
export interface ApprovalRecord {
  approvalId: string
  /** `run` approves a manifest; `gate` approves the continuation past one human gate. */
  kind: 'run' | 'gate'
  manifestId: string
  /** The manifest digest the human approved. */
  manifestSha256: string
  ticketId: string
  /** The trigger that raised the request the approval answers. */
  triggerId: string
  /** The policy version in force when the approval was recorded. */
  policyVersion: string
  /** The GitHub repository ID. */
  repositoryId: number
  /** The comment that carried the decision. */
  commentId: string
  /** SHA-256 over the comment body, so an edited comment no longer matches. */
  commentSha256: string
  actor: ApprovalActor
  at: string
  /** Whether the human acknowledged the environment and credential summary in the same decision. */
  environmentApproved: boolean
  decision: 'approved' | 'denied'
  /** The gate this approval continues past, for `kind: 'gate'`. */
  gateId?: string
  /** The full commit SHA of the human's gate-only edit, for `kind: 'gate'`. */
  gateCommit?: string
}

/** The phase a run segment is in; `unknown` keeps the reservation and the quota guard. */
export type SegmentPhase =
  | 'reserved' | 'preflight' | 'launching' | 'running' | 'stopping' | 'stopped' | 'gate_wait'
  | 'verifying' | 'ready' | 'blocked' | 'failed' | 'unknown'

/** The deterministic identities one run segment owns, all known before launch. */
export interface SegmentRunnerIdentity {
  /** The user service unit that hosts the runner. */
  serviceUnit: string
  /** The delegated cgroup that holds the runner's process tree. */
  cgroup: string
  /** The private tmux server. */
  tmux: string
  /** The private Prime daemon socket. */
  socket: string
  /** The workspace the runner may write. */
  workspace: string
  /** The branch the run works on. */
  branch: string
  /** The durable Prime session ID, known after launch. */
  sessionId?: string
  /** The durable Prime session file, known after launch. */
  sessionFile?: string
}

/** One bounded run segment: the reservation that owns the single runner slot. */
export interface BridgeSegment {
  segmentId: string
  ticketId: string
  assignmentId: string
  /** The monotonic generation of this ticket's bridge work; a stale effect names an older one. */
  generation: number
  manifestId: string
  phase: SegmentPhase
  /** The stop epoch; a callback from an older epoch is stale. */
  stopEpoch: number
  /** Whether a stop was requested; it fences every later external action. */
  stopRequested: boolean
  /** The task IDs this segment covers, in order. */
  taskIds: string[]
  /** The first human gate the segment stops at, when it stops before one. */
  nextGateId: string | null
  runner: SegmentRunnerIdentity
  /** The quota guard this run owns, removed only after confirmed quiescence. */
  quotaGuardId: string
  /** The branch head the segment started from; the push lease uses it. */
  baseRevision?: string
  createdAt: string
  updatedAt: string
}

/** One check the runner reported, with the evidence it left behind. */
export interface ReportedCheck {
  name: string
  exitCode: number
  /** A repository-relative path to the check's output, never an absolute path. */
  evidence: string
}

/** The runner's report: what the runner observed in the workspace it produced. */
export interface RunnerReport {
  schemaVersion: 1
  ticketId: string
  assignmentId: string
  segmentId: string
  generation: number
  stopEpoch: number
  manifestSha256: string
  baselineRevision: string
  outcome: 'gate' | 'complete' | 'blocked' | 'failed'
  workspaceSnapshotSha256: string
  completedTaskIds: string[]
  remainingTaskIds: string[]
  nextGateId: string | null
  checks: ReportedCheck[]
  convergence: { rounds: number; status: 'converged' | 'deferred-at-gate' | 'findings' }
  summary: string
  risksAndBlockers: string[]
}

/** The controller's verification of the runner's report: what the system verified, kept separate from what the runner observed. */
export interface VerificationResult {
  /** SHA-256 over the runner report this verification answers. */
  reportSha256: string
  /** The controller-created commit that holds the result. */
  resultRevision: string
  /** The checks the controller reran against `resultRevision`. */
  checks: ReportedCheck[]
  /** Whether every write stayed inside the approved paths. */
  scopeAudit: { approved: boolean; outOfScopePaths: string[] }
  /** The controls the system actually enforced. */
  enforcedControls: string[]
  /** The constraints the system only instructed, such as the task order inside an allowed path. */
  instructedConstraints: string[]
  /** Whether the result may be presented as ready for review. */
  decision: 'ready' | 'blocked'
  /** Why the result is blocked, with the action an operator must take. */
  reasons: string[]
  at: string
}

/** The durable report file: the runner's observed part and the controller's verified part, kept distinguishable. */
export interface BridgeReport {
  schemaVersion: 1
  runner: RunnerReport
  verification?: VerificationResult
}

/** Why a run could not deliver a result; each cause needs its own operator action. */
export type FailureCause =
  | 'preflight' | 'provider' | 'dependency' | 'quota' | 'check' | 'report' | 'isolation' | 'approval' | 'stop' | 'delivery'

/** The distinct failure the operator sees, with the evidence and the next action. */
export interface FailureRecord {
  /** The record's own ID; the Store generates one when it is missing. */
  id?: string
  /** The Ticket the failure belongs to, so the operator sees it on that Ticket. */
  ticketId?: string
  cause: FailureCause
  /** A short human-readable summary. */
  summary: string
  /** The evidence that proves the failure, as a repository-relative path or a short quoted value. */
  evidence: string
  /** The one action an operator must take. */
  nextAction: string
  at: string
}
