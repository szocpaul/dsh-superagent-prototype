
/**
 * The runner report and the operator-facing failure record of the Prime Runner Bridge.
 *
 * The runner report is untrusted data. It is parsed against a strict schema, bound to the segment the controller
 * expects, and never treated as authority: the controller verifies the workspace, creates its own revision, and
 * reruns the checks itself. The failure record names the distinct cause of a blocked run, so the operator sees
 * which prerequisite failed and what to do next. Secrets never reach a report, a notice, or a conversation.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { BridgeReport, FailureCause, FailureRecord, ReportedCheck, RunnerReport, VerificationResult } from './prime-model.ts'

/** The base of every bridge failure that knows its own cause. */
export class BridgeError extends Error {
  constructor(readonly cause: FailureCause, message: string, readonly evidence = '', readonly nextAction = '') {
    super(message)
    this.name = 'BridgeError'
  }
}

/** Raised when a report or a failure record is malformed; the message names the rejected part. */
export class ReportError extends BridgeError {
  constructor(message: string, evidence = '', nextAction = '') {
    super('report', message, evidence, nextAction)
    this.name = 'ReportError'
  }
}

/** A failed prerequisite that blocks the launch. */
export class PreflightError extends BridgeError {
  constructor(message: string, evidence = '', nextAction = '') { super('preflight', message, evidence, nextAction); this.name = 'PreflightError' }
}
/** The model backend refused the run. */
export class ProviderError extends BridgeError {
  constructor(message: string, evidence = '', nextAction = '') { super('provider', message, evidence, nextAction); this.name = 'ProviderError' }
}
/** A required dependency is missing or unusable. */
export class DependencyError extends BridgeError {
  constructor(message: string, evidence = '', nextAction = '') { super('dependency', message, evidence, nextAction); this.name = 'DependencyError' }
}
/** A metered limit stopped the run. */
export class QuotaError extends BridgeError {
  constructor(message: string, evidence = '', nextAction = '') { super('quota', message, evidence, nextAction); this.name = 'QuotaError' }
}
/** A required check failed. */
export class CheckError extends BridgeError {
  constructor(message: string, evidence = '', nextAction = '') { super('check', message, evidence, nextAction); this.name = 'CheckError' }
}
/** The required isolation is unavailable or was broken. */
export class IsolationError extends BridgeError {
  constructor(message: string, evidence = '', nextAction = '') { super('isolation', message, evidence, nextAction); this.name = 'IsolationError' }
}
/** The approval no longer holds. */
export class ApprovalError extends BridgeError {
  constructor(message: string, evidence = '', nextAction = '') { super('approval', message, evidence, nextAction); this.name = 'ApprovalError' }
}
/** The runner did not stop when it had to. */
export class StopError extends BridgeError {
  constructor(message: string, evidence = '', nextAction = '') { super('stop', message, evidence, nextAction); this.name = 'StopError' }
}
/** The delivery could not publish the result. */
export class DeliveryError extends BridgeError {
  constructor(message: string, evidence = '', nextAction = '') { super('delivery', message, evidence, nextAction); this.name = 'DeliveryError' }
}

/** The summary each cause gets when the error carries no message of its own. */
const CAUSE_SUMMARY: Record<FailureCause, string> = {
  preflight: 'a required prerequisite failed before the runner started',
  provider: 'the model backend refused the run',
  dependency: 'a required dependency was missing or unusable',
  quota: 'a metered limit stopped the run',
  check: 'a required check failed',
  report: 'the runner wrote no usable report',
  isolation: 'the required isolation was unavailable or was broken',
  approval: 'the approval no longer holds',
  stop: 'the runner did not stop when it had to',
  delivery: 'the result could not be published',
}

/** The one action an operator takes for each cause. */
const CAUSE_NEXT_ACTION: Record<FailureCause, string> = {
  preflight: 'an operator must fix the failed prerequisite and approve a new launch',
  provider: 'an operator must restore the model backend and approve a new launch',
  dependency: 'an operator must provide the missing dependency and approve a new launch',
  quota: 'an operator must raise the metered limit or wait for the accounting window to reset',
  check: 'an operator must fix the failing check and approve a new launch',
  report: 'an operator must recover the runner report from the run storage',
  isolation: 'an operator must repair the isolation and approve the execution environment again',
  approval: 'an operator must give a new approval for the current manifest',
  stop: 'an operator must confirm the runner stopped before any new segment starts',
  delivery: 'an operator must resolve the delivery state before the result is published',
}

const HEX64 = /^[0-9a-f]{64}$/

/** A path that stays inside the run storage and names no parent directory. */
const EvidencePath = z.string().min(1).refine(path => {
  if (path.startsWith('/')) return false
  if (path.includes('\0')) return false
  return !path.split('/').some(part => part === '..')
}, 'an evidence path must be relative and must not leave the run storage')

const ReportSchema = z.object({
  schemaVersion: z.literal(1),
  ticketId: z.string().min(1),
  assignmentId: z.string().min(1),
  segmentId: z.string().min(1),
  generation: z.number().int().nonnegative(),
  stopEpoch: z.number().int().nonnegative(),
  manifestSha256: z.string().regex(HEX64, 'a manifest digest is 64 lowercase hex characters'),
  baselineRevision: z.string().min(1),
  outcome: z.enum(['gate', 'complete', 'blocked', 'failed']),
  workspaceSnapshotSha256: z.string().regex(HEX64, 'a workspace snapshot digest is 64 lowercase hex characters'),
  completedTaskIds: z.array(z.string().min(1)),
  remainingTaskIds: z.array(z.string().min(1)),
  nextGateId: z.string().min(1).nullable(),
  checks: z.array(z.object({
    name: z.string().min(1),
    exitCode: z.number().int(),
    evidence: EvidencePath,
  }).strict()),
  convergence: z.object({
    rounds: z.number().int().nonnegative(),
    status: z.enum(['converged', 'deferred-at-gate', 'findings']),
  }).strict(),
  summary: z.string(),
  risksAndBlockers: z.array(z.string()),
}).strict()

/** What the controller expects a report to be about. */
export interface ReportExpectation {
  /** The segment the report must claim. */
  segmentId: string
  /** The generation the controller still holds. */
  generation: number
  /** The stop epoch the controller still holds. */
  stopEpoch: number
  /** The manifest digest the report must be bound to. */
  manifestSha256: string
  /** The Ticket the report must belong to, when the controller checks it. */
  ticketId?: string
  /** The assignment the report must belong to, when the controller checks it. */
  assignmentId?: string
}

/** The name of the structured report file in the run storage. */
export const REPORT_FILE = 'runner-report.json'
/** The name of the human-readable report file in the run storage. */
export const REPORT_MARKDOWN_FILE = 'runner-report.md'
/** The name the runner writes first and renames, so a half-written report is never read. */
export const REPORT_TEMP_FILE = 'runner-report.json.tmp'

/**
 * Parses a runner report and binds it to the segment the controller expects.
 * @throws ReportError when the report is malformed, carries an unknown key, names an unknown path, or belongs to a
 *   different segment, generation, stop epoch, or manifest.
 */
export function parseRunnerReport(text: string, expected: ReportExpectation): RunnerReport {
  let value: unknown
  try { value = JSON.parse(text) } catch (error) {
    throw new ReportError(`the runner report is invalid: it is not JSON (${String(error)})`)
  }
  const parsed = ReportSchema.safeParse(value)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const where = issue?.path.join('.') || 'the report'
    throw new ReportError(`the runner report is invalid: ${where} ${issue?.message ?? 'is not valid'}`)
  }
  const report = parsed.data as RunnerReport
  if (report.segmentId !== expected.segmentId) {
    throw new ReportError(`the runner report belongs to the segment ${report.segmentId}, not to ${expected.segmentId}`)
  }
  if (report.generation !== expected.generation) {
    throw new ReportError(`the runner report carries the generation ${report.generation}, not the current generation ${expected.generation}`)
  }
  if (report.stopEpoch !== expected.stopEpoch) {
    throw new ReportError(`the runner report carries the stop epoch ${report.stopEpoch}, not the current stop epoch ${expected.stopEpoch}`)
  }
  if (report.manifestSha256 !== expected.manifestSha256) {
    throw new ReportError(`the runner report is bound to the manifest ${report.manifestSha256}, not to the approved manifest ${expected.manifestSha256}`)
  }
  if (expected.ticketId !== undefined && report.ticketId !== expected.ticketId) {
    throw new ReportError(`the runner report belongs to the ticket ${report.ticketId}, not to ${expected.ticketId}`)
  }
  if (expected.assignmentId !== undefined && report.assignmentId !== expected.assignmentId) {
    throw new ReportError(`the runner report belongs to the assignment ${report.assignmentId}, not to ${expected.assignmentId}`)
  }
  return report
}

/** The report of a run, with the human-readable copy the operator reads. */
export interface IngestedReport {
  /** The validated report. */
  report: RunnerReport
  /** The human-readable report the runner wrote next to the structured one. */
  markdown: string
}

/** The name of the run-specific local wake signal, which is only a hint and never authorizes work. */
export const WAKE_FILE = 'runner-wake'

/**
 * Reads the run-specific local wake signal. The signal only tells the controller that it may look at the run; it
 * carries no authority, and the controller reconciles the run on its own schedule as well.
 */
export function readRunnerWake(storagePath: string): boolean {
  return existsSync(join(storagePath, WAKE_FILE))
}

/**
 * Reads the runner report from the run-owned storage: the structured report and the human-readable copy the runner
 * wrote next to it. The runner wrote the structured report under a temporary name and renamed it, so a leftover
 * temporary file means the write never finished and the report is not read.
 * @throws ReportError when the storage holds no finished report.
 */
export function readRunnerReport(storagePath: string): IngestedReport {
  if (existsSync(join(storagePath, REPORT_TEMP_FILE))) {
    throw new ReportError('the runner report write did not finish; the run storage still holds a temporary report')
  }
  const file = join(storagePath, REPORT_FILE)
  if (!existsSync(file)) throw new ReportError(`the run storage holds no ${REPORT_FILE}`)
  const markdownFile = join(storagePath, REPORT_MARKDOWN_FILE)
  if (!existsSync(markdownFile)) throw new ReportError(`the run storage holds no ${REPORT_MARKDOWN_FILE}`)
  const text = readFileSync(file, 'utf8')
  const value = JSON.parse(text) as unknown
  const parsed = ReportSchema.safeParse(value)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new ReportError(`the runner report is invalid: ${issue?.path.join('.') || 'the report'} ${issue?.message ?? 'is not valid'}`)
  }
  return { report: parsed.data as RunnerReport, markdown: readFileSync(markdownFile, 'utf8') }
}

/**
 * Removes anything that looks like a secret from a text that reaches a report, a notice, or a conversation:
 * an API key, a token, or a bearer value.
 */
export function redact(text: string): string {
  return text
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, '$1-***')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{8,}/g, 'gh*_***')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, 'Bearer ***')
    .replace(/\b(api[_-]?key|apikey|token|secret|password|passwd)\b(\s*[=:]\s*)("?)[^\s",;]+/gi, '$1$2***')
}

/** Redacts the free text of a report, so no secret reaches the durable record. */
function redactReport(report: RunnerReport): RunnerReport {
  return {
    ...report,
    summary: redact(report.summary),
    risksAndBlockers: report.risksAndBlockers.map(redact),
    checks: report.checks.map(check => ({ ...check, evidence: redact(check.evidence) })),
  }
}

/** What the controller needs to ingest a runner report. */
export interface IngestOptions {
  /** The run-owned storage the runner wrote into. */
  storagePath: string
  /** The segment the report must claim. */
  expected: ReportExpectation
  /** The human-readable report, when the storage holds one. */
  markdown?: string
}

/**
 * Ingests the report a runner wrote: it reads the structured report from the run-owned storage, binds it to the
 * segment the controller expects, and rejects a stale or malformed report. The report is data; it never authorizes
 * work and never marks a result ready.
 * @throws ReportError when the storage holds no finished report, or when the report is stale or malformed.
 */
export function ingestRunnerReport(options: IngestOptions): IngestedReport {
  const read = readRunnerReport(options.storagePath)
  const bound = parseRunnerReport(JSON.stringify(read.report), options.expected)
  return { report: bound, markdown: options.markdown ?? read.markdown }
}

/**
 * Builds the failure record of one cause, with the evidence and the one action an operator must take.
 */
export function failureOf(cause: FailureCause, evidence: string, nextAction: string): FailureRecord {
  return {
    cause,
    summary: CAUSE_SUMMARY[cause],
    evidence: redact(evidence),
    nextAction: redact(nextAction || CAUSE_NEXT_ACTION[cause]),
    at: new Date().toISOString(),
  }
}

/** The operator-facing report of one failed run. */
export interface FailureReport {
  /** The distinct cause of the failure. */
  cause: FailureCause
  /** A short human-readable summary of the cause. */
  summary: string
  /** The evidence that proves the failure. */
  evidence: string
  /** The one action an operator must take. */
  nextAction: string
  /** The checks that ran, with the evidence each of them left. */
  checks: ReportedCheck[]
  /** What the quota accounting covered, when the run was monitored. */
  quotaCoverage: string | null
  /** The report the operator reads, with no secret in it. */
  text: string
}

/** What a failure report needs beyond the failure itself. */
export interface FailureReportOptions {
  /** The checks that ran before the failure. */
  checks?: ReportedCheck[]
  /** What the quota accounting covered; the statement of the coverage is enough. */
  quotaCoverage?: { statement: string } | null
}

/**
 * Builds the report of a failed run: the distinct cause, the check evidence, the quota coverage, and the one action
 * an operator must take. No secret reaches the report.
 */
export function failureReport(failure: FailureRecord, options: FailureReportOptions = {}): FailureReport {
  const checks = (options.checks ?? []).map(check => ({ ...check, evidence: redact(check.evidence) }))
  const quotaCoverage = options.quotaCoverage ? redact(options.quotaCoverage.statement) : null
  const summary = redact(failure.summary)
  const evidence = redact(failure.evidence)
  const nextAction = redact(failure.nextAction || CAUSE_NEXT_ACTION[failure.cause])
  const lines = [
    `The run failed: ${summary}`,
    `Cause: ${failure.cause}`,
    `Evidence: ${evidence}`,
  ]
  for (const check of checks) lines.push(`Check ${check.name} exited with ${check.exitCode}; evidence: ${check.evidence}`)
  if (quotaCoverage) lines.push(`Quota coverage: ${quotaCoverage}`)
  lines.push(`Next action: ${nextAction}`)
  return { cause: failure.cause, summary, evidence, nextAction, checks, quotaCoverage, text: lines.join('\n') }
}

/**
 * Builds the text of the operator notice and the conversation message of a failed run. It carries the cause and the
 * next action, and no secret.
 */
export function noticeText(failure: FailureRecord): string {
  const report = failureReport(failure)
  return `${report.text}.`
}

/** The causes of the errors that other modules of the bridge raise, matched by their class name. */
const FOREIGN_CAUSES: Record<string, FailureCause> = {
  IsolationError: 'isolation',
}

/**
 * Maps an error to the failure record the operator sees. A known bridge error keeps its own cause; an unknown
 * error becomes a generic blocked failure, never a success.
 */
export function mapFailure(error: unknown): FailureRecord {
  if (error instanceof BridgeError) {
    return {
      cause: error.cause,
      summary: redact(error.message || CAUSE_SUMMARY[error.cause]),
      evidence: redact(error.evidence),
      nextAction: redact(error.nextAction || CAUSE_NEXT_ACTION[error.cause]),
      at: new Date().toISOString(),
    }
  }
  const message = error instanceof Error ? error.message : String(error)
  const foreign = error instanceof Error ? FOREIGN_CAUSES[error.name] : undefined
  if (foreign) {
    return {
      cause: foreign,
      summary: redact(message || CAUSE_SUMMARY[foreign]),
      evidence: redact(message),
      nextAction: CAUSE_NEXT_ACTION[foreign],
      at: new Date().toISOString(),
    }
  }
  return {
    cause: 'report',
    summary: redact(`the run stopped with an unclassified error, so no prerequisite could be named: ${message}`),
    evidence: redact(message),
    nextAction: 'an operator must read the run logs and decide whether the run may continue',
    at: new Date().toISOString(),
  }
}

/**
 * Builds the durable bridge report. The runner's observed part and the controller's verified part stay separate,
 * so the runner's own report is never presented as the controller's evidence.
 */
export function controllerReport(runner: RunnerReport, verification?: VerificationResult): BridgeReport {
  const report: BridgeReport = { schemaVersion: 1, runner: redactReport(runner) }
  if (verification) {
    report.verification = {
      ...verification,
      reasons: verification.reasons.map(redact),
      enforcedControls: verification.enforcedControls.map(redact),
      instructedConstraints: verification.instructedConstraints.map(redact),
      checks: verification.checks.map((check): ReportedCheck => ({ ...check, evidence: redact(check.evidence) })),
    }
  }
  return report
}
