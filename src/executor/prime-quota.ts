/**
 * The bounded, non-LLM quota watcher of one Prime runner bridge run: an external guard script, a per-run cron
 * entry, a durable alert record, and a narrowly scoped emergency stop. The watcher never polls a model and never
 * reads a claim the agent made about its own usage; it reads the accounting source it was given and reports the
 * scope that source covers.
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The accounting scope a usage reading covers. */
export type QuotaScope = 'session' | 'log' | 'account'

/** The decision the watcher made about a usage reading. */
export type QuotaStatus = 'ok' | 'warn' | 'stop'

/** Raised when an accounting output cannot be read as a usage reading. */
export class QuotaError extends Error {
  constructor(message: string) { super(message); this.name = 'QuotaError' }
}

/** One usage reading: a token count and the scope it was measured over. */
export interface QuotaUsage {
  /** The measured token count. */
  tokens: number
  /** The accounting scope the reading covers. */
  scope: QuotaScope
}

/** The token counts at which the guard warns and at which it stops the run. */
export interface QuotaThresholds {
  /** The token count at which the guard writes a warning alert. */
  warnTokens: number
  /** The token count at which the guard stops the run's cgroup. */
  stopTokens: number
}

/** The identity of one run's quota guard: what the guard owns and what it may stop. */
export interface GuardIdentity {
  /** The cron entry name of this run's guard. */
  entryName: string
  /** The Prime session file of this run; the guard is given it explicitly. */
  sessionFile: string
  /** The log path the guard appends its readings to. */
  logPath: string
  /** The file the guard writes durable alerts to. */
  alertFile: string
  /** The cgroup of this run, the only one the guard may stop. */
  cgroup: string
  /** The warning and stop thresholds of this run. */
  thresholds: QuotaThresholds
  /** The command that produces the accounting output the guard reads. */
  accounting: string[]
}

/** The decision the watcher made, with the numbers it used. */
export interface QuotaVerdict {
  /** The decision. */
  status: QuotaStatus
  /** The token count the decision was made on. */
  tokens: number
  /** The scope the token count was measured over. */
  scope: QuotaScope
  /** The warning threshold in use. */
  warnTokens: number
  /** The stop threshold in use. */
  stopTokens: number
}

/** What the accounting covers, and what it does not. */
export interface QuotaCoverage {
  /** The scope the accounting measured. */
  scope: QuotaScope
  /** What the reading covers. */
  measured: string
  /** What the reading does not cover. */
  notMeasured: string[]
  /** Always false: an accounting reading never establishes an account-wide billed quota. */
  accountWideGuarantee: false
  /** Always true: the guard measures at intervals, so the run can pass a threshold before the next reading. */
  possibleOvershoot: boolean
  /** The sentence a report may quote. */
  statement: string
}

/** One durable alert record. */
export interface AlertRecord {
  /** The file the alert belongs to. */
  path: string
  /** The record's content, one JSON object per line. */
  content: string
}

/** The result of one guard run. */
export interface GuardRun {
  /** The decision the guard made. */
  status: QuotaStatus
  /** The exit code of the guard script. */
  exitCode: number
  /** The token count the guard read, when it read one. */
  tokens: number | null
  /** The scope the guard measured, when it measured one. */
  scope: QuotaScope | null
  /** Why the guard decided as it did. */
  reason: string
  /** What the reading covers, when a reading was made. */
  coverage: QuotaCoverage | null
}

/** The host operations the guard needs; tests supply fakes, so no real cron or cgroup is touched. */
export interface GuardHost {
  /** Installs this run's cron entry, leaving every other entry alone. */
  installCron(entryName: string, command: string, schedule: string): void
  /** Removes this run's cron entry, leaving every other entry alone. */
  removeCron(entryName: string): void
  /** The cron entry names the host currently holds. */
  listCron(): string[]
  /** Runs a program and returns its exit code and output. */
  exec(argv: string[]): { exitCode: number; stdout: string; stderr: string }
  /** Appends a durable alert record to a file. */
  appendAlert(path: string, content: string): void
  /** Stops the given cgroup and everything in it. */
  stopCgroup(cgroup: string): void
}

/** The schedule the guard runs on. */
export const GUARD_SCHEDULE = '*/5 * * * *'

/** The name of the cron entry a run owns. */
export function entryNameFor(runId: string): string {
  return `prime-quota-${runId}`
}

/**
 * Parses an accounting output into a usage reading.
 * The output must carry a `tokens=<count>` line and a `scope=session|log|account` line.
 * @throws QuotaError when either value is missing or malformed.
 */
export function usageOf(accounting: string): QuotaUsage {
  const tokens = /^tokens=(\d+)$/m.exec(accounting)?.[1]
  const scope = /^scope=(session|log|account)$/m.exec(accounting)?.[1]
  if (tokens === undefined) throw new QuotaError('the accounting output carries no tokens line')
  if (scope === undefined) throw new QuotaError('the accounting output carries no known scope line')
  return { tokens: Number(tokens), scope: scope as QuotaScope }
}

/**
 * Decides what a usage reading means for the run: below the warning threshold, at or above it, or at or above the
 * stop threshold.
 */
export function verdict(usage: QuotaUsage, thresholds: QuotaThresholds): QuotaVerdict {
  const status: QuotaStatus = usage.tokens >= thresholds.stopTokens
    ? 'stop'
    : usage.tokens >= thresholds.warnTokens ? 'warn' : 'ok'
  return {
    status,
    tokens: usage.tokens,
    scope: usage.scope,
    warnTokens: thresholds.warnTokens,
    stopTokens: thresholds.stopTokens,
  }
}

/**
 * States what an accounting reading covers and what it does not. The statement names the measured scope and
 * never claims an account-wide billed quota.
 */
export function coverage(usage: QuotaUsage): QuotaCoverage {
  const measured = {
    session: 'the token count of this run\'s Prime session file',
    log: 'the token count recorded in this run\'s guard log file',
    account: 'the token count the provider\'s accounting source reports for the configured account',
  }[usage.scope]
  const notMeasured = [
    'the token usage of other runs on the same host',
    'provider-side billing adjustments, such as cache reads or tiered pricing',
    'the token usage of child processes the accounting source does not attribute to this session',
    'the credentials the runner uses, which the accounting source does not see',
    'any guarantee that a billed account-wide quota is respected',
  ]
  return {
    scope: usage.scope,
    measured,
    notMeasured,
    accountWideGuarantee: false,
    possibleOvershoot: true,
    statement: `The guard measured ${measured}. It does not cover other runs, unattributed child processes, `
      + `the runner's credentials, or `
      + 'provider-side billing adjustments, and it does not establish an account-wide billed quota guarantee. '
      + 'The guard measures at intervals, so the run can pass a threshold before the next reading.',
  }
}

/**
 * Builds the durable alert record of a decision, with the run identity and the numbers the decision used.
 */
export function alert(
  identity: GuardIdentity,
  usage: QuotaUsage,
  status: QuotaStatus,
  reason: string,
  now: Date = new Date(),
): AlertRecord {
  const record = {
    schemaVersion: 1,
    at: now.toISOString(),
    entryName: identity.entryName,
    sessionFile: identity.sessionFile,
    status,
    reason,
    tokens: usage.tokens,
    scope: usage.scope,
    warnTokens: identity.thresholds.warnTokens,
    stopTokens: identity.thresholds.stopTokens,
    coverage: coverage(usage).statement,
  }
  return { path: identity.alertFile, content: `${JSON.stringify(record)}\n` }
}

/** Quotes one argument for a POSIX shell command line. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * The quota guard of one run: it installs and removes this run's cron entry, runs the guard script as an external
 * process, and checks that the entry is still there. It owns one entry name and one alert file and touches nothing
 * else on the host.
 */
export class QuotaGuard {
  /**
   * @param identity - what this run's guard owns.
   * @param host - the host operations; the default one uses cron and the local filesystem.
   * @param scriptPath - the guard script the entry and the direct run use.
   */
  constructor(
    readonly identity: GuardIdentity,
    private readonly host: GuardHost = defaultHost(),
    private readonly scriptPath: string = defaultScriptPath(),
  ) {}

  /** The argument vector of the guard script for this run; it names the run explicitly. */
  command(): string[] {
    const { identity } = this
    return [
      this.scriptPath,
      '--session', identity.sessionFile,
      '--log', identity.logPath,
      '--warn', String(identity.thresholds.warnTokens),
      '--stop', String(identity.thresholds.stopTokens),
      '--alert', identity.alertFile,
      '--cgroup', identity.cgroup,
      '--', ...identity.accounting,
    ]
  }

  /** The cron command line of this run's guard entry. */
  cronCommand(): string {
    return ['sh', this.scriptPath, '--session', this.identity.sessionFile, '--log', this.identity.logPath,
      '--warn', String(this.identity.thresholds.warnTokens), '--stop', String(this.identity.thresholds.stopTokens),
      '--alert', this.identity.alertFile, '--cgroup', this.identity.cgroup, '--', ...this.identity.accounting]
      .map(shellQuote).join(' ')
  }

  /** Installs this run's cron entry. */
  install(): void {
    this.host.installCron(this.identity.entryName, this.cronCommand(), GUARD_SCHEDULE)
  }

  /**
   * Runs the guard script once as an external process, so the guard also works when the controller's own loop is
   * gone. An unreadable accounting source fails closed and is reported as a stop.
   */
  runOnce(): GuardRun {
    const result = this.host.exec(this.command())
    const fields = new Map<string, string>()
    for (const line of result.stdout.split('\n')) {
      const match = /^([a-z-]+)=(.*)$/.exec(line.trim())
      if (match) fields.set(match[1]!, match[2]!)
    }
    const tokens = fields.get('tokens')
    const scope = fields.get('scope')
    const usage: QuotaUsage | null = tokens !== undefined && scope !== undefined
      && (scope === 'session' || scope === 'log' || scope === 'account')
      ? { tokens: Number(tokens), scope }
      : null
    const status: QuotaStatus = fields.get('verdict') === 'ok' ? 'ok'
      : fields.get('verdict') === 'warn' ? 'warn' : 'stop'
    return {
      status,
      exitCode: result.exitCode,
      tokens: usage?.tokens ?? null,
      scope: usage?.scope ?? null,
      reason: fields.get('reason') ?? (status === 'ok' ? 'below-thresholds' : status === 'warn' ? 'warn-threshold' : 'stop-threshold'),
      coverage: usage ? coverage(usage) : null,
    }
  }

  /** Whether this run's cron entry is still installed. */
  alive(): boolean {
    return this.host.listCron().includes(this.identity.entryName)
  }

  /**
   * Removes this run's cron entry. The guard stays installed while the run's stop is uncertain and is removed only
   * after a confirmed stop.
   */
  release(stopConfirmed: boolean): boolean {
    if (!stopConfirmed) return false
    this.host.removeCron(this.identity.entryName)
    return true
  }

  /** Writes a durable alert record for this run. */
  recordAlert(record: AlertRecord): void {
    this.host.appendAlert(record.path, record.content)
  }
}

/**
 * Stops the given run's own cgroup. It never touches another cgroup and never removes the guard entry, so the
 * alert and the run's identity survive the stop.
 */
export function emergencyStop(identity: GuardIdentity, host: GuardHost = defaultHost()): void {
  host.stopCgroup(identity.cgroup)
}

/** The path of the guard script in this repository. */
export function defaultScriptPath(): string {
  return fileURLToPath(new URL('../../scripts/prime-quota-guard.sh', import.meta.url))
}

/** The default host operations: the user's crontab, the local filesystem, and child processes. */
export function defaultHost(): GuardHost {
  const readCrontab = (): string[] => {
    const current = spawnSync('crontab', ['-l'], { encoding: 'utf8' })
    return current.status === 0 ? current.stdout.split('\n').filter(Boolean) : []
  }
  const writeCrontab = (lines: string[]): void => {
    spawnSync('crontab', ['-'], { input: lines.length ? `${lines.join('\n')}\n` : '', encoding: 'utf8' })
  }
  return {
    installCron(entryName, command, schedule) {
      const marker = `# ${entryName}`
      const kept = readCrontab().filter(line => !line.includes(marker))
      writeCrontab([...kept, `${schedule} ${command} ${marker}`])
    },
    removeCron(entryName) {
      const marker = `# ${entryName}`
      writeCrontab(readCrontab().filter(line => !line.includes(marker)))
    },
    listCron() {
      return readCrontab()
        .filter(line => /^# prime-quota-/.test(line.trim()))
        .map(line => line.trim().split('# ')[1]!)
    },
    exec(argv) {
      const result = spawnSync(argv[0]!, argv.slice(1), { encoding: 'utf8' })
      return { exitCode: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
    },
    appendAlert(path, content) {
      mkdirSync(dirname(path), { recursive: true })
      appendFileSync(path, content)
    },
    stopCgroup(cgroup) {
      writeFileSync(join(cgroup, 'cgroup.kill'), '1')
    },
  }
}

/** The fault one monitoring round found. */
export type GuardFault =
  | 'none'
  | 'silent-green'
  | 'unreadable-metrics'
  | 'guard-lost'
  | 'threshold'
  | 'warning'

/** What the controller must do after a monitoring round. */
export type GuardAction = 'continue' | 'warn' | 'stop' | 'emergency-stop'

/** The result of one monitoring round: what the guard said, what the accounting said, and what follows. */
export interface GuardObservation {
  /** The status the guard script reported. */
  status: QuotaStatus
  /** The fault the round found; `none` when the guard and the accounting agree and stay below the thresholds. */
  fault: GuardFault
  /** The token count the independent accounting read gave. */
  tokens: number | null
  /** The scope the independent accounting read measured. */
  scope: QuotaScope | null
  /** What the accounting covers, when a reading was made. */
  coverage: QuotaCoverage | null
  /** Why the controller decided as it did. */
  reason: string
  /** What the controller must do. */
  action: GuardAction
  /** Whether the controller's stop path must run. */
  requiresStop: boolean
  /** The warning threshold in use. */
  warnTokens: number
  /** The stop threshold in use. */
  stopTokens: number
}

/** The state of the run that a cleanup needs before it may remove anything. */
export interface CleanupState {
  /** The independently confirmed quiescence of the run. */
  quiescence: 'quiescent' | 'busy' | 'unknown'
  /** Whether the stop of the run was confirmed. */
  stopConfirmed: boolean
}

/** The resources one run owns and that a cleanup may remove. */
export interface RunResources {
  /** The cron entry name of this run's quota guard. */
  guardEntryName: string
  /** The private service unit of this run. */
  serviceUnit: string
  /** The private daemon socket of this run. */
  socketPath: string
  /** The private tmux server of this run. */
  tmuxServer: string
  /** The workspace scratch directory of this run. */
  workspaceScratch: string
}

/** The host operations a cleanup needs; every one of them names a resource of the run. */
export interface CleanupHost {
  /** Removes one cron entry, leaving every other entry alone. */
  removeCron(entryName: string): void
  /** Stops one private service unit. */
  stopService(unit: string): void
  /** Removes one private daemon socket. */
  removeSocket(path: string): void
  /** Stops one private tmux server. */
  stopTmuxServer(name: string): void
  /** Removes one workspace scratch directory. */
  removeScratch(path: string): void
}

/** What a cleanup did, or why it refused. */
export interface CleanupOutcome {
  /** The resources the cleanup removed; every one of them belongs to the run. */
  removed: string[]
  /** The reason the cleanup refused, or null when it ran. */
  refused: string | null
}

/**
 * Reads the accounting source directly, without the guard script, so the controller can compare the guard's own
 * reading with the source.
 * @throws QuotaError when the accounting output carries no usable reading.
 */
export function readAccounting(identity: GuardIdentity, host: GuardHost = defaultHost()): QuotaUsage {
  const result = host.exec(identity.accounting)
  if (result.exitCode !== 0) throw new QuotaError(`the accounting source exited with code ${result.exitCode}`)
  return usageOf(result.stdout)
}

/**
 * The quota monitoring of one run: it installs the guard before the work starts, reads the accounting source
 * independently of the guard, checks the guard's own liveness, and turns what it finds into one decision for the
 * controller. It never removes the guard and never stops a run by itself.
 */
export class QuotaMonitor {
  private readonly guard: QuotaGuard

  /**
   * @param identity - what this run's guard owns.
   * @param host - the host operations; the default one uses cron and the local filesystem.
   * @param scriptPath - the guard script the entry and the direct run use.
   */
  constructor(
    readonly identity: GuardIdentity,
    private readonly host: GuardHost = defaultHost(),
    scriptPath: string = defaultScriptPath(),
  ) {
    this.guard = new QuotaGuard(identity, host, scriptPath)
  }

  /** Installs this run's guard; it is installed before the work starts and stays installed while the run may run. */
  install(): void {
    this.guard.install()
  }

  /**
   * Checks the guard's liveness, independently of the controller's own state: the entry must still be on the host,
   * because a run that may still run must keep its monitoring.
   */
  liveness(): { alive: boolean; reason: string } {
    const alive = this.guard.alive()
    return {
      alive,
      reason: alive
        ? `the guard entry ${this.identity.entryName} is installed`
        : `the guard entry ${this.identity.entryName} is gone, so the run is no longer monitored`,
    }
  }

  /**
   * Runs one monitoring round: the guard script, the accounting source read on its own, and the liveness of the
   * guard. A guard that reports ok while the accounting says otherwise is a fault, and every fault that hides the
   * usage fails closed and asks for the stop path.
   */
  round(): GuardObservation {
    const run = this.guard.runOnce()
    const thresholds = this.identity.thresholds
    const base = {
      status: run.status,
      warnTokens: thresholds.warnTokens,
      stopTokens: thresholds.stopTokens,
    }
    const live = this.liveness()
    if (!live.alive) {
      return { ...base, fault: 'guard-lost', tokens: null, scope: null, coverage: null, reason: live.reason, action: 'stop', requiresStop: true }
    }
    let usage: QuotaUsage
    try {
      usage = readAccounting(this.identity, this.host)
    } catch (error) {
      return {
        ...base,
        fault: 'unreadable-metrics',
        tokens: null,
        scope: null,
        coverage: null,
        reason: `the accounting source could not be read, so the usage is unknown: ${String(error)}`,
        action: 'stop',
        requiresStop: true,
      }
    }
    const covered = coverage(usage)
    if (run.status === 'ok' && (usage.tokens !== run.tokens || usage.scope !== run.scope)) {
      return {
        ...base,
        fault: 'silent-green',
        tokens: usage.tokens,
        scope: usage.scope,
        coverage: covered,
        reason: `the guard reported ok with ${run.tokens ?? 'no'} tokens, but the accounting source reports ${usage.tokens} tokens, so the guard is not reporting the usage`,
        action: 'stop',
        requiresStop: true,
      }
    }
    if (run.status === 'stop' || usage.tokens >= thresholds.stopTokens) {
      return {
        ...base,
        fault: 'threshold',
        tokens: usage.tokens,
        scope: usage.scope,
        coverage: covered,
        reason: `the usage of ${usage.tokens} tokens reached the stop threshold of ${thresholds.stopTokens} tokens`,
        action: 'stop',
        requiresStop: true,
      }
    }
    if (run.status === 'warn' || usage.tokens >= thresholds.warnTokens) {
      return {
        ...base,
        fault: 'warning',
        tokens: usage.tokens,
        scope: usage.scope,
        coverage: covered,
        reason: `the usage of ${usage.tokens} tokens reached the warning threshold of ${thresholds.warnTokens} tokens`,
        action: 'warn',
        requiresStop: false,
      }
    }
    return {
      ...base,
      fault: 'none',
      tokens: usage.tokens,
      scope: usage.scope,
      coverage: covered,
      reason: `the usage of ${usage.tokens} tokens is below the warning threshold of ${thresholds.warnTokens} tokens`,
      action: 'continue',
      requiresStop: false,
    }
  }

  /** Writes the durable alert of one observation; a warning and every fault leave a record. */
  record(observation: GuardObservation, now: Date = new Date()): void {
    const record = {
      schemaVersion: 1,
      at: now.toISOString(),
      entryName: this.identity.entryName,
      sessionFile: this.identity.sessionFile,
      status: observation.status,
      fault: observation.fault,
      reason: observation.reason,
      tokens: observation.tokens,
      scope: observation.scope,
      warnTokens: observation.warnTokens,
      stopTokens: observation.stopTokens,
      coverage: observation.coverage?.statement ?? 'the accounting source could not be read',
    }
    this.host.appendAlert(this.identity.alertFile, `${JSON.stringify(record)}\n`)
  }

  /**
   * Removes this run's guard. The guard stays installed while the run may still run, so it is removed only after a
   * confirmed stop.
   */
  release(stopConfirmed: boolean): boolean {
    return this.guard.release(stopConfirmed)
  }

  /**
   * Stops this run's own cgroup through the guard script, without the controller: the script is the last line when
   * the controller is gone. It touches only the cgroup of this run.
   */
  emergencyStop(): { exitCode: number; stdout: string } {
    const result = this.host.exec([...this.guard.command().slice(0, this.guard.command().indexOf('--')), '--emergency'])
    return { exitCode: result.exitCode, stdout: result.stdout }
  }
}

/**
 * Removes the bridge-owned resources of one run: its quota guard entry, its private service, its daemon socket, its
 * tmux server and its workspace scratch. Nothing is removed while the stop is unconfirmed or the state of the run is
 * unknown, and no resource of another run is touched.
 */
export function cleanupRun(resources: RunResources, state: CleanupState, host: CleanupHost): CleanupOutcome {
  if (!state.stopConfirmed) {
    return { removed: [], refused: 'the stop of the run is not confirmed, so the resources of the run stay in place' }
  }
  if (state.quiescence !== 'quiescent') {
    return { removed: [], refused: `the state of the run is ${state.quiescence}, so the quiescence is not confirmed` }
  }
  const removed: string[] = []
  host.removeCron(resources.guardEntryName)
  removed.push(`cron:${resources.guardEntryName}`)
  host.stopService(resources.serviceUnit)
  removed.push(`service:${resources.serviceUnit}`)
  host.removeSocket(resources.socketPath)
  removed.push(`socket:${resources.socketPath}`)
  host.stopTmuxServer(resources.tmuxServer)
  removed.push(`tmux:${resources.tmuxServer}`)
  host.removeScratch(resources.workspaceScratch)
  removed.push(`scratch:${resources.workspaceScratch}`)
  return { removed, refused: null }
}
