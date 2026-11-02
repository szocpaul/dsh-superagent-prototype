/**
 * The bounded autonomous runner invocation of one segment, and the bootstrap barrier that holds it until the
 * controller has proven the run's own identity.
 *
 * The invocation is built from the approved manifest, never from free text: the runner's CLI and version, the
 * model, the goal, and the checks come from the manifest the operator approved. The barrier is a file the
 * runner waits for, so the runner cannot begin work before the controller has recorded the reservation, the
 * quota guard and the session identity.
 */
import type { ApprovedCheck, ApprovedManifest } from './prime-model.ts'

/** The runner's options the CLI supports; the preflight verifies each of them before the launch. */
export const AUTONOMOUS_FLAGS = [
  '--autonomous',
  '--autonomous-gate',
  '--autonomous-gate-retries',
  '--autonomous-max-turns',
  '--autonomous-max-continuations',
  '--autonomous-max-tokens',
  '--autonomous-timeout-ms',
  '--goal',
  '--provider',
  '--model',
] as const

/** The limits one segment runs under. They come from the approved environment, not from the code. */
export interface LaunchLimits {
  /** How many assistant turns the segment may take. */
  maxTurns: number
  /** How many follow-up turns the segment may take after a turn ends. */
  maxContinuations: number
  /** The fresh-token limit of the segment. It does not bound the billed cache reads. */
  maxTokens: number
  /** The wall-clock limit of the segment, in milliseconds. */
  maxWallMs: number
  /** How often a failing gate is retried. */
  gateRetries: number
}

/** The default limits of a segment, used when the manifest approves none. */
export const DEFAULT_LIMITS: LaunchLimits = {
  maxTurns: 40,
  maxContinuations: 8,
  maxTokens: 2_000_000,
  maxWallMs: 3 * 60 * 60 * 1000,
  gateRetries: 3,
}

/** The barrier the runner waits on before it begins any work. */
export interface BootstrapBarrier {
  /** The file the runner waits for. */
  path: string
  /** The contents that release the runner: the segment id and the durable session identity. */
  release: string
}

/** The arguments of one bounded autonomous run. */
export interface LaunchInvocation {
  /** The argument vector, ready to hand to the runner's CLI. */
  argv: string[]
  /** The barrier the runner waits on. */
  barrier: BootstrapBarrier
  /** The goal the segment is bounded to. */
  goal: string
  /** The prompt the runner reads; it names the specification, the report and the barrier. */
  prompt: string
}

/** The goal of a segment: every automatable task of the approved range, ending at the human gate. */
export function segmentGoal(manifest: ApprovedManifest, taskIds: readonly string[], nextGateId: string | undefined): string {
  const range = taskIds.length ? `tasks ${taskIds[0]} through ${taskIds[taskIds.length - 1]}` : 'the approved tasks'
  const stop = nextGateId
    ? `and stop at the human gate ${nextGateId}`
    : 'and stop at the end of the approved segment'
  return `Complete ${range} of the approved specification, ticking only the automatable tasks, ${stop}.`
}

/** The gate command of one approved check. */
function gateArgument(check: ApprovedCheck): string {
  return `cd ${check.cwd || '.'} && ${check.argv.map(part => JSON.stringify(part)).join(' ')}`
}

/**
 * Builds the argument vector of one bounded autonomous run.
 *
 * The vector holds only the flags the installed CLI documents, the approved goal, and the approved checks as
 * gates. The gate command is the check's argument vector, quoted for the shell the runner uses; it is never a
 * string the controller invented.
 */
export function buildLaunchInvocation(
  manifest: ApprovedManifest,
  options: { taskIds: readonly string[]; nextGateId?: string; barrier: BootstrapBarrier; reportPath: string; limits?: Partial<LaunchLimits> },
): LaunchInvocation {
  const limits = { ...DEFAULT_LIMITS, ...options.limits }
  const goal = segmentGoal(manifest, options.taskIds, options.nextGateId)
  const prompt = segmentPrompt({
    featureDir: manifest.featureDir,
    taskIds: options.taskIds,
    nextGateId: options.nextGateId,
    reportPath: options.reportPath,
    barrierPath: options.barrier.path,
  })
  const argv = [
    manifest.environment.runner.cli,
    // The model comes from the approved manifest, so the run uses the model the operator approved.
    '--provider', manifest.environment.model.provider,
    '--model', manifest.environment.model.id,
    '--autonomous',
    '--autonomous-gate-retries', String(limits.gateRetries),
    '--autonomous-max-turns', String(limits.maxTurns),
    '--autonomous-max-continuations', String(limits.maxContinuations),
    '--autonomous-max-tokens', String(limits.maxTokens),
    '--autonomous-timeout-ms', String(limits.maxWallMs),
    '--goal', goal,
  ]
  for (const check of manifest.checks) argv.push('--autonomous-gate', gateArgument(check))
  // The prompt tells the runner which specification to read, where its report belongs, and that it waits for the
  // barrier, so it cannot begin before the controller has recorded the run's identity.
  argv.push(prompt)
  return { argv, barrier: options.barrier, goal, prompt }
}

/**
 * The task prompt of one segment.
 *
 * The durable state lives in the approved files, so the prompt only names them and states the constraints that
 * the runner must not break. It never repeats the specification's content.
 */
export function segmentPrompt(options: {
  featureDir: string
  taskIds: readonly string[]
  nextGateId?: string
  reportPath: string
  barrierPath: string
}): string {
  const range = options.taskIds.length
    ? `Execute the tasks ${options.taskIds[0]} through ${options.taskIds[options.taskIds.length - 1]} of ${options.featureDir}/tasks.md`
    : `Execute the approved tasks of ${options.featureDir}/tasks.md`
  const stop = options.nextGateId
    ? `Stop at the human gate ${options.nextGateId} and do not perform it.`
    : 'Stop at the end of the approved segment.'
  return [
    range + ', in the listed dependency order.',
    'Read the approved specification, plan, task list, and the project constitution before you start; they are the authority.',
    'MANDATORY CONSTRAINTS:',
    '- "DO NOT touch files outside the active spec\'s approved scope."',
    '- "DO NOT tick checkboxes marked MANUAL GATE / HUMAN GATE / MANUÁLIS KAPU."',
    '- "If an external dependency is unreachable, STOP AND REPORT; never improvise a substitute."',
    '- "When waiting on a slow process, await its handle/completion follow-up; never poll in consecutive turns, and if an explicit check is unavoidable, check at most once per 10 minutes."',
    `- Wait for the barrier file ${options.barrierPath} before you begin any work. It appears when the controller has recorded the run's identity and its quota guard.`,
    stop,
    `Write your durable report to ${options.reportPath} before you send any message.`,
  ].join('\n')
}
