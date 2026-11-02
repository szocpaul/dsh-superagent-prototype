
/**
 * The controller's own verification of a run: the workspace snapshot, the scope audit, the controller-created
 * result revision, the independently rerun checks, the bounded convergence assessment, and the final verdict.
 *
 * The runner's report is never the proof. The controller collects the workspace itself, creates its own revision of
 * the approved snapshot, reruns the approved checks against that exact revision in a verifier that holds no GitHub,
 * controller, or model credentials, and only then decides whether the result may be presented as ready.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { ApprovedCheck, ApprovedManifest, BridgeSegment, ReportedCheck, RunnerReport, VerificationResult } from './prime-model.ts'
import { bytesDigest, canonicalize, manifestDigest } from './prime-manifest.ts'
import type { Commands } from '../infra/commands.ts'

/** Raised when the controller cannot verify the workspace, the revision, or the checks. */
export class VerifyError extends Error {
  constructor(message: string) { super(message); this.name = 'VerifyError' }
}

/** One file of the collected workspace state. */
export interface SnapshotFile {
  /** The path relative to the workspace root. */
  path: string
  /** SHA-256 over the exact bytes of the file. */
  sha256: string
  /** The exact bytes of the file, so the controller can commit the approved snapshot itself. */
  content: Buffer
}

/** The workspace state the runner produced, as the controller collected it. */
export interface WorkspaceSnapshot {
  /** The workspace the snapshot was collected from. */
  workspace: string
  /** Every path the runner changed, in path order. */
  paths: string[]
  /** The changed files that still exist, in path order. */
  files: SnapshotFile[]
  /** SHA-256 over the canonical list of the files and their digests. */
  digest: string
}

/** The result of the scope audit: which writes stayed inside the approved paths. */
export interface ScopeAudit {
  /** Whether every write stayed inside the approved paths. */
  approved: boolean
  /** The paths that lie outside the approved paths. */
  outOfScopePaths: string[]
}

/** The controller's commit of the approved snapshot. */
export interface RevisionPort {
  /** Creates the controller's commit of the given files and returns its revision. */
  commit(input: { files: { path: string; content: Buffer }[]; message: string }): Promise<string>
}

/** The verifier that reruns one approved check against the exact revision. */
export interface VerifierPort {
  /** Runs one check against the given revision in a verifier that holds no GitHub, controller, or model credentials. */
  run(check: ApprovedCheck, revision: string, environment: Record<string, string | undefined>): Promise<{ exitCode: number; evidence: string }>
}

/** The names an environment may not carry into the verifier: they would give the check a GitHub, controller, or model credential. */
const CREDENTIAL_NAME = /(^|_)(TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|API_KEY|CREDENTIAL|CREDENTIALS)$/

/**
 * Refuses an environment that would hand a GitHub, controller, or model credential to the verifier.
 * @throws VerifyError when the environment names a credential.
 */
export function assertCredentialFree(environment: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined) continue
    if (CREDENTIAL_NAME.test(name) || name.startsWith('GH_')) {
      throw new VerifyError(`the verifier must hold no credential, but the environment names ${name}`)
    }
  }
}

/** The scope of one convergence round. */
export interface AssessRequest {
  /** `segment` before a gate, `full` after the last segment. */
  scope: 'segment' | 'full'
  /** The round number, starting at 1. */
  round: number
  /** The manifest the assessment compares the implementation against. */
  manifestSha256: string
  /** The tasks the assessment covers. */
  taskIds: string[]
  /** The tasks the assessment does not cover, because a person has to act first. */
  notAssessedTaskIds: string[]
  /** The workspace the controller copies onto the isolated scratch copy. */
  workspace: string
}

/** What the assessment found; every finding is a proposal, never a change to the approved scope. */
export interface AssessFinding {
  /** The finding's own ID. */
  id: string
  /** What the assessment found. */
  summary: string
  /** Always true: a finding never changes the approved scope and never adds a task. */
  proposal: true
}

/** The host that runs the assessment on an isolated scratch copy. */
export interface AssessHost {
  /** Runs the assessment on a scratch copy of the workspace and returns its findings. */
  assessOnScratch(request: AssessRequest): Promise<{ findings: { id: string; summary: string }[] }>
}

/** The outcome of one convergence assessment. */
export interface Assessment {
  /** The round the assessment ran. */
  rounds: number
  /** The scope the assessment covered. */
  status: 'converged' | 'deferred-at-gate' | 'findings'
  /** Whether the assessment covered only the segment or the whole approved scope. */
  scope: 'segment' | 'full'
  /** The tasks the assessment covered. */
  assessedTaskIds: string[]
  /** The tasks the assessment did not cover. */
  notAssessedTaskIds: string[]
  /** The findings, which stay proposals. */
  findings: AssessFinding[]
}

/** The paths that hold control state and are never part of the runner's output. */
const CONTROL_SEGMENTS = ['.git', '.specify']

/** The control artifacts that are excluded even inside a permitted parent directory. */
function controlPrefixes(approvedPaths: string[]): string[] {
  const prefixes = CONTROL_SEGMENTS.map(segment => `${segment}/`)
  for (const path of approvedPaths) prefixes.push(`${path}/.git/`)
  return prefixes
}

/** Whether a relative path is control state and therefore never part of the snapshot. */
function isControlPath(relativePath: string, prefixes: string[]): boolean {
  if (CONTROL_SEGMENTS.some(segment => relativePath === segment || relativePath.startsWith(`${segment}/`))) return true
  return prefixes.some(prefix => relativePath.startsWith(prefix))
}

/** Whether a path lies inside one of the approved paths. */
function inScope(relativePath: string, approvedPaths: string[]): boolean {
  return approvedPaths.some(path => relativePath === path || relativePath.startsWith(`${path}/`))
}

/**
 * Collects the workspace state the runner produced. Symlinks are never followed out of the workspace, and control
 * state is left out of the snapshot.
 * @throws VerifyError when a symlink points out of the workspace.
 */
export async function collectSnapshot(commands: Commands, workspace: string, approvedPaths: string[]): Promise<WorkspaceSnapshot> {
  const root = resolve(workspace)
  const prefixes = controlPrefixes(approvedPaths)
  const paths = await changedPaths(commands, root)
  const files: SnapshotFile[] = []
  for (const relativePath of paths) {
    if (isControlPath(relativePath, prefixes)) continue
    const full = join(root, relativePath)
    if (!existsSync(full)) continue
    const target = realpathSync(full)
    if (target !== root && !target.startsWith(root + sep)) {
      throw new VerifyError(`the workspace holds a symlink that points out of the workspace: ${relativePath}`)
    }
    const content = readFileSync(full)
    files.push({ path: relativePath, sha256: bytesDigest(content), content })
  }
  const listing = files.map(file => ({ path: file.path, sha256: file.sha256 }))
  return { workspace: root, paths, files, digest: bytesDigest(canonicalize(listing as never)) }
}

/**
 * The paths the runner changed, read from the workspace's own version control.
 *
 * The controller does not walk the whole tree: the workspace holds the project's dependencies, and the scope of a
 * run is about what the run changed, not about what was already there.
 */
export async function changedPaths(commands: Commands, workspace: string): Promise<string[]> {
  let output: string
  try {
    output = await commands.git(['status', '--porcelain', '-uall', '-z'], workspace)
  } catch (error) {
    throw new VerifyError(`the workspace has no version control to read the changed files from: ${String(error)}`)
  }
  const entries = output.split('\0').filter(entry => entry.length > 0)
  const paths: string[] = []
  for (const entry of entries) {
    // The porcelain format is "XY path"; a rename carries its old path in the next entry.
    const path = entry.slice(3).replace(/^"|"$/g, '')
    if (!path || path === entry) continue
    paths.push(path.split(sep).join('/'))
  }
  return [...new Set(paths)].sort()
}

/**
 * Audits the collected snapshot against the approved paths. A write outside them blocks readiness.
 */
export function scopeAudit(snapshot: WorkspaceSnapshot, approvedPaths: string[]): ScopeAudit {
  const outOfScopePaths = snapshot.paths.filter(path => !inScope(path, approvedPaths))
  return { approved: outOfScopePaths.length === 0, outOfScopePaths }
}

/**
 * The controller's own commit of the approved snapshot. Without a repository adapter the revision is the controller's
 * content attestation of the approved files; it is never the digest the runner reported.
 */
export const contentAttestation: RevisionPort = {
  commit: async input => createHash('sha1').update(canonicalize(
    input.files.map(file => ({ path: file.path, sha256: bytesDigest(file.content) })) as never,
  ), 'utf8').digest('hex'),
}

/**
 * Creates the controller's commit of the approved part of the snapshot and returns its revision.
 */
export async function createResultRevision(
  snapshot: WorkspaceSnapshot,
  approvedPaths: string[],
  committer: RevisionPort = contentAttestation,
): Promise<string> {
  const files = snapshot.files
    .filter(file => inScope(file.path, approvedPaths))
    .map(file => ({ path: file.path, content: file.content }))
  return committer.commit({ files, message: 'controller: the verified result of a Prime Runner Bridge segment' })
}

/**
 * Reruns the approved checks against the exact revision, in a separately confined verifier that holds no GitHub,
 * controller, or model credentials. A check that does not run counts as a failed check.
 */
export async function rerunChecks(
  checks: ApprovedCheck[],
  revision: string,
  verifier: VerifierPort,
  environment: Record<string, string | undefined> = {},
): Promise<ReportedCheck[]> {
  assertCredentialFree(environment)
  const results: ReportedCheck[] = []
  for (const check of checks) {
    try {
      const outcome = await verifier.run(check, revision, environment)
      results.push({ name: check.name, exitCode: outcome.exitCode, evidence: outcome.evidence })
    } catch (error) {
      results.push({
        name: check.name,
        exitCode: 1,
        evidence: `the check did not run in the verifier: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }
  return results
}

/**
 * Runs the convergence assessment on an isolated scratch copy, at most two rounds. Before a gate it covers only the
 * authorized segment and records the later tasks as not assessed; after the last segment it covers the whole approved
 * scope. The findings stay proposals: they never change the approved scope and never add a task.
 * @throws VerifyError when a third round is requested.
 */
export async function assess(
  manifest: ApprovedManifest,
  segment: BridgeSegment,
  round: number,
  host: AssessHost,
): Promise<Assessment> {
  if (round > 2) throw new VerifyError('the convergence assessment runs at most two rounds')
  const atGate = segment.nextGateId !== null
  const approvedTaskIds = manifest.tasks.map(task => task.id)
  const assessedTaskIds = atGate ? segment.taskIds.filter(id => approvedTaskIds.includes(id)) : approvedTaskIds
  const notAssessedTaskIds = approvedTaskIds.filter(id => !assessedTaskIds.includes(id))
  const request: AssessRequest = {
    scope: atGate ? 'segment' : 'full',
    round,
    manifestSha256: manifestDigest(manifest),
    taskIds: assessedTaskIds,
    notAssessedTaskIds,
    workspace: segment.runner.workspace,
  }
  const outcome = await host.assessOnScratch(request)
  const findings: AssessFinding[] = outcome.findings.map(finding => ({ ...finding, proposal: true }))
  const status: Assessment['status'] = findings.length > 0 ? 'findings' : atGate ? 'deferred-at-gate' : 'converged'
  return { rounds: round, status, scope: request.scope, assessedTaskIds, notAssessedTaskIds, findings }
}

/** What the controller needs to verify one segment. */
export interface VerifyOptions {
  /** The approved manifest the run was bound to. */
  manifest: ApprovedManifest
  /** The segment the report claims. */
  segment: BridgeSegment
  /** The runner's report, which is data and never authority. */
  report: RunnerReport
  /** The repository the runner worked in; its changed files are the state the runner produced. */
  workspace: string
  /** The repository adapter the controller reads the changed files with. */
  commands: Commands
  /** The verifier that reruns the approved checks. */
  verifier: VerifierPort
  /** The environment the verifier runs in; it may name no credential. */
  environment?: Record<string, string | undefined>
  /** The controller's own convergence assessment; without it the convergence is not confirmed. */
  assessment?: Assessment
  /** The repository adapter that creates the controller's commit. */
  committer?: RevisionPort
  /** The clock, so a test can fix the timestamp. */
  now?: () => string
}

/** The controls the system actually enforces, as opposed to the constraints it only instructs. */
const ENFORCED_CONTROLS = [
  'writable paths: the runner could write only inside the approved paths',
  'process boundary: the runner ran in its own service and cgroup',
  'network: the host applied the approved network policy',
  'credentials: the verifier held no GitHub, controller, or model credential',
  'stop behaviour: the stop epoch fenced every later action of the segment',
]

/** The constraints the system only instructs, because a task boundary inside an allowed path cannot be enforced. */
const INSTRUCTED_CONSTRAINTS = [
  'task order: the order of the tasks inside an allowed path is instructed, not enforced',
]

/**
 * The whole verdict: the report is valid, the scope audit passed, the checks passed against the exact revision, the
 * convergence is valid, and the result is ready or blocked with its reasons.
 */
export async function verify(options: VerifyOptions): Promise<VerificationResult> {
  const { manifest, segment, report, workspace, verifier } = options
  const now = options.now ?? (() => new Date().toISOString())
  const reasons: string[] = []
  if (report.segmentId !== segment.segmentId) reasons.push(`the report belongs to the segment ${report.segmentId}, not to ${segment.segmentId}`)
  if (report.generation !== segment.generation) reasons.push(`the report carries the generation ${report.generation}, not the current generation ${segment.generation}`)
  if (report.stopEpoch !== segment.stopEpoch) reasons.push(`the report carries the stop epoch ${report.stopEpoch}, not the current stop epoch ${segment.stopEpoch}`)
  const digest = manifestDigest(manifest)
  if (report.manifestSha256 !== digest) reasons.push(`the report is bound to another manifest than ${digest}`)
  // A segment that stops at a human gate ends with the outcome `gate`; the gate is a boundary the run reached, not
  // a failure of the run, and the decision about it belongs to a person.
  const atGate = segment.nextGateId !== null
  if (report.outcome !== 'complete' && !(atGate && report.outcome === 'gate')) {
    reasons.push(`the run stopped with the outcome ${report.outcome}`)
  }
  if (report.outcome === 'gate' && report.nextGateId !== segment.nextGateId) {
    reasons.push(`the report names the gate ${report.nextGateId}, not the segment's gate ${segment.nextGateId}`)
  }
  if (!options.assessment) {
    reasons.push('the controller ran no convergence assessment, so the convergence is not confirmed')
  } else if (options.assessment.status !== 'converged' && !(atGate && options.assessment.status === 'deferred-at-gate')) {
    reasons.push(`the controller's convergence assessment ended with ${options.assessment.status}`)
  }
  const snapshot = await collectSnapshot(options.commands, workspace, manifest.allowedPaths)
  // The report names the files the runner changed and the digest of each of them; the controller compares every
  // path and every digest with the workspace it sees, so a report of another workspace never passes.
  const reported = new Map(report.files.map(file => [file.path, file.sha256]))
  const actual = new Map(snapshot.files.map(file => [file.path, file.sha256]))
  if (reported.size !== actual.size) {
    reasons.push(`the report names ${reported.size} file(s) and the workspace holds ${actual.size} changed file(s), so the report is stale`)
  }
  for (const [path, sha256] of actual) {
    if (!reported.has(path)) reasons.push(`the report does not name the changed file ${path}`)
    else if (reported.get(path) !== sha256) reasons.push(`the report does not describe the current content of ${path}`)
  }
  const audit = scopeAudit(snapshot, manifest.allowedPaths)
  if (!audit.approved) reasons.push(`the run wrote outside the approved paths: ${audit.outOfScopePaths.join(', ')}`)
  const revision = await createResultRevision(snapshot, manifest.allowedPaths, options.committer)
  const checks = await rerunChecks(manifest.checks, revision, verifier, options.environment ?? {})
  for (const check of checks) {
    if (check.exitCode !== 0) reasons.push(`the check ${check.name} failed against the result revision with exit code ${check.exitCode}`)
  }
  const approvedCheckNames = manifest.checks.map(check => check.name)
  for (const name of approvedCheckNames) {
    if (!checks.some(check => check.name === name)) reasons.push(`the check ${name} was not rerun against the result revision`)
  }
  return {
    reportSha256: bytesDigest(canonicalize(report as never)),
    resultRevision: revision,
    checks,
    scopeAudit: audit,
    enforcedControls: [...ENFORCED_CONTROLS],
    instructedConstraints: [...INSTRUCTED_CONSTRAINTS],
    decision: reasons.length === 0 ? 'ready' : 'blocked',
    reasons,
    at: now(),
  }
}
