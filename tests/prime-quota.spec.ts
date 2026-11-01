import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  alert, cleanupRun, coverage, emergencyStop, entryNameFor, QuotaGuard, QuotaMonitor, usageOf, verdict,
  type CleanupHost, type GuardHost, type GuardIdentity, type QuotaScope, type RunResources,
} from '../src/executor/prime-quota.ts'

const scriptPath = fileURLToPath(new URL('../scripts/prime-quota-guard.sh', import.meta.url))

/** A host that records what it was asked to do, so no real cron, cgroup or filesystem entry is touched. */
class FakeHost implements GuardHost {
  cron = new Map<string, string>()
  execs: string[][] = []
  alerts = new Map<string, string>()
  stopped: string[] = []
  execResult = { exitCode: 0, stdout: '', stderr: '' }
  execHandler?: (argv: string[]) => { exitCode: number; stdout: string; stderr: string }

  installCron(entryName: string, command: string): void { this.cron.set(entryName, command) }
  removeCron(entryName: string): void { this.cron.delete(entryName) }
  listCron(): string[] { return [...this.cron.keys()] }
  exec(argv: string[]): { exitCode: number; stdout: string; stderr: string } {
    this.execs.push(argv)
    return this.execHandler ? this.execHandler(argv) : this.execResult
  }
  appendAlert(path: string, content: string): void {
    this.alerts.set(path, (this.alerts.get(path) ?? '') + content)
  }
  stopCgroup(cgroup: string): void { this.stopped.push(cgroup) }
}

const identity = (overrides: Partial<GuardIdentity> = {}): GuardIdentity => ({
  entryName: entryNameFor('run-42'),
  sessionFile: '/var/lib/prime/sessions/run-42.jsonl',
  logPath: '/var/lib/prime/runs/run-42/guard.log',
  alertFile: '/var/lib/prime/runs/run-42/quota-alert.jsonl',
  cgroup: '/sys/fs/cgroup/prime/run-42',
  thresholds: { warnTokens: 100, stopTokens: 200 },
  accounting: ['/usr/local/bin/accounting', '--session', '/var/lib/prime/sessions/run-42.jsonl'],
  ...overrides,
})

/** A run-owned temporary directory for one script invocation. */
const workspace = (): string => mkdtempSync(join(tmpdir(), 'prime-quota-'))

/** A fake accounting command that prints a reading. */
const accounting = (dir: string, output: string, exitCode = 0): string[] => {
  const path = join(dir, 'accounting.sh')
  writeFileSync(path, `#!/bin/sh\ncat <<'EOF'\n${output}\nEOF\nexit ${exitCode}\n`)
  chmodSync(path, 0o755)
  return [path]
}

/** The alert records the guard script wrote. */
const readAlert = (path: string): Record<string, unknown>[] => {
  const content = readFileSync(path, 'utf8')
  return content.split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
}

/** Runs the guard script against a fake accounting command and returns its result. */
const runScript = (dir: string, command: string[], warn = 100, stop = 200) => {
  const alertPath = join(dir, 'alert.jsonl')
  const result = spawnSync('sh', [
    scriptPath,
    '--session', join(dir, 'session.jsonl'),
    '--log', join(dir, 'guard.log'),
    '--warn', String(warn),
    '--stop', String(stop),
    '--alert', alertPath,
    '--cgroup', join(dir, 'cgroup'),
    '--', ...command,
  ], { encoding: 'utf8' })
  const alerts = statSync(alertPath, { throwIfNoEntry: false }) ? readAlert(alertPath) : []
  return { ...result, alerts }
}

describe('guard identity', () => {
  it('invokes the guard script with the run\'s explicit identity and no hardcoded session name', () => {
    const host = new FakeHost()
    const guard = new QuotaGuard(identity(), host, scriptPath)
    const command = guard.command()
    const value = (flag: string): string => command[command.indexOf(flag) + 1]!
    expect(value('--session')).toBe('/var/lib/prime/sessions/run-42.jsonl')
    expect(value('--log')).toBe('/var/lib/prime/runs/run-42/guard.log')
    expect(value('--alert')).toBe('/var/lib/prime/runs/run-42/quota-alert.jsonl')
    expect(value('--cgroup')).toBe('/sys/fs/cgroup/prime/run-42')
    expect(value('--warn')).toBe('100')
    expect(value('--stop')).toBe('200')
    expect(command.slice(command.indexOf('--') + 1)).toEqual([
      '/usr/local/bin/accounting', '--session', '/var/lib/prime/sessions/run-42.jsonl',
    ])
  })

  it('names the session file in the cron command and owns only its own entry', () => {
    const host = new FakeHost()
    const guard = new QuotaGuard(identity(), host, scriptPath)
    guard.install()
    expect(host.cron.size).toBe(1)
    expect(host.cron.get('prime-quota-run-42')).toContain('/var/lib/prime/sessions/run-42.jsonl')
    expect(guard.alive()).toBe(true)
  })

  it('never names a hardcoded session in the guard script', () => {
    const source = readFileSync(scriptPath, 'utf8')
    expect(source).toContain('--session')
    expect(source).not.toMatch(/spec-launcher|spec00\d/)
    expect(source).not.toContain('/home/ubuntu/.prime/agent/session-artifacts')
  })
})

describe('accounting readings', () => {
  it('reads a token count and the scope it covers', () => {
    expect(usageOf('tokens=42\nscope=session\n')).toEqual({ tokens: 42, scope: 'session' })
    expect(usageOf('scope=account\ntokens=7\n')).toEqual({ tokens: 7, scope: 'account' })
  })

  it('fails closed when the accounting output carries no reading', () => {
    expect(() => usageOf('nothing here\n')).toThrow()
    expect(() => usageOf('tokens=42\n')).toThrow()
  })

  it('decides warn and stop from the thresholds it was given', () => {
    const thresholds = { warnTokens: 100, stopTokens: 200 }
    expect(verdict({ tokens: 99, scope: 'session' }, thresholds).status).toBe('ok')
    expect(verdict({ tokens: 100, scope: 'session' }, thresholds).status).toBe('warn')
    expect(verdict({ tokens: 200, scope: 'session' }, thresholds).status).toBe('stop')
    expect(verdict({ tokens: 250, scope: 'session' }, thresholds)).toEqual({
      status: 'stop', tokens: 250, scope: 'session', warnTokens: 100, stopTokens: 200,
    })
  })
})

describe('the guard script', () => {
  it('fails closed on an unreadable accounting source and does not report ok', () => {
    const dir = workspace()
    const cgroup = join(dir, 'cgroup')
    mkdirSync(cgroup)
    writeFileSync(join(cgroup, 'cgroup.kill'), '')
    const result = runScript(dir, accounting(dir, 'tokens=1', 1))
    expect(result.status).not.toBe(0)
    expect(result.stdout).toContain('verdict=stop')
    expect(result.stdout).not.toContain('verdict=ok')
    expect(result.alerts[0]!.reason).toBe('accounting-unreadable')
    expect(readFileSync(join(cgroup, 'cgroup.kill'), 'utf8')).toBe('1')
  })

  it('writes a durable alert and reports warn at the warning threshold', () => {
    const dir = workspace()
    const result = runScript(dir, accounting(dir, 'tokens=150\nscope=session'))
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('verdict=warn')
    expect(result.alerts[0]).toMatchObject({ status: 'warn', tokens: 150, scope: 'session', reason: 'warn-threshold' })
    expect(result.alerts[0]!.sessionFile).toBe(join(dir, 'session.jsonl'))
  })

  it('stops the run\'s own cgroup and reports stop at the stop threshold', () => {
    const dir = workspace()
    const cgroup = join(dir, 'cgroup')
    mkdirSync(cgroup)
    writeFileSync(join(cgroup, 'cgroup.kill'), '')
    const result = runScript(dir, accounting(dir, 'tokens=500\nscope=session'))
    expect(result.status).toBe(2)
    expect(result.stdout).toContain('verdict=stop')
    expect(readFileSync(join(cgroup, 'cgroup.kill'), 'utf8')).toBe('1')
    expect(result.alerts[0]).toMatchObject({ status: 'stop', tokens: 500, reason: 'stop-threshold' })
  })

  it('reports the accounting scope it measured and claims no billed account quota', () => {
    const dir = workspace()
    const result = runScript(dir, accounting(dir, 'tokens=10\nscope=account'))
    expect(result.stdout).toContain('scope=account')
    expect(result.stdout).toContain('not-a-billed-account-quota')
    expect(result.stdout).not.toContain('guarantee')
  })

  it('is a POSIX shell script that passes sh -n', () => {
    expect(statSync(scriptPath).mode & 0o111).not.toBe(0)
    const result = spawnSync('sh', ['-n', scriptPath], { encoding: 'utf8' })
    expect(result.status).toBe(0)
  })
})

describe('the watcher', () => {
  it('reports the guard script result and its coverage', () => {
    const host = new FakeHost()
    host.execResult = { exitCode: 1, stdout: 'verdict=warn\ntokens=150\nscope=session\ncoverage=session-tokens\n', stderr: '' }
    const guard = new QuotaGuard(identity(), host, scriptPath)
    const run = guard.runOnce()
    expect(run.status).toBe('warn')
    expect(run.tokens).toBe(150)
    expect(run.scope).toBe('session')
    expect(run.coverage?.scope).toBe('session')
    expect(host.execs[0]).toEqual(guard.command())
  })

  it('treats an unreadable accounting source as a stop', () => {
    const host = new FakeHost()
    host.execResult = { exitCode: 3, stdout: 'verdict=stop\nreason=accounting-unreadable\ncoverage=unreadable-accounting\n', stderr: '' }
    const run = new QuotaGuard(identity(), host, scriptPath).runOnce()
    expect(run.status).toBe('stop')
    expect(run.tokens).toBeNull()
    expect(run.reason).toBe('accounting-unreadable')
  })

  it('writes a durable alert record with the run identity and the numbers', () => {
    const host = new FakeHost()
    const guard = new QuotaGuard(identity(), host, scriptPath)
    const record = alert(guard.identity, { tokens: 150, scope: 'session' }, 'warn', 'warn-threshold', new Date('2026-11-01T00:00:00Z'))
    guard.recordAlert(record)
    expect(record.path).toBe('/var/lib/prime/runs/run-42/quota-alert.jsonl')
    const written = JSON.parse(host.alerts.get(record.path)!)
    expect(written).toMatchObject({
      status: 'warn', tokens: 150, scope: 'session', warnTokens: 100, stopTokens: 200,
      entryName: 'prime-quota-run-42', sessionFile: '/var/lib/prime/sessions/run-42.jsonl',
    })
    expect(written.coverage).toContain('does not establish an account-wide billed quota guarantee')
  })
})

describe('coverage statements', () => {
  it('states the measured scope and does not claim an account-wide guarantee', () => {
    for (const scope of ['session', 'log', 'account'] as QuotaScope[]) {
      const statement = coverage({ tokens: 10, scope })
      expect(statement.scope).toBe(scope)
      expect(statement.accountWideGuarantee).toBe(false)
      expect(statement.statement).toContain('does not establish an account-wide billed quota guarantee')
      expect(statement.notMeasured.length).toBeGreaterThan(0)
      expect(statement.possibleOvershoot).toBe(true)
      expect(statement.statement).toContain('pass a threshold before the next reading')
      expect(statement.statement).toContain('unattributed child processes')
      expect(statement.statement).toContain("the runner's credentials")
    }
  })
})

describe('the emergency stop', () => {
  it('targets only the run\'s own cgroup', () => {
    const host = new FakeHost()
    emergencyStop(identity(), host)
    expect(host.stopped).toEqual(['/sys/fs/cgroup/prime/run-42'])
  })

  it('does not remove the guard entry, so the alert and the identity survive', () => {
    const host = new FakeHost()
    const guard = new QuotaGuard(identity(), host, scriptPath)
    guard.install()
    emergencyStop(guard.identity, host)
    expect(guard.alive()).toBe(true)
  })
})

describe('the guard lifecycle', () => {
  it('keeps the guard installed while the stop is uncertain and removes it after a confirmed stop', () => {
    const host = new FakeHost()
    const guard = new QuotaGuard(identity(), host, scriptPath)
    guard.install()
    expect(guard.release(false)).toBe(false)
    expect(guard.alive()).toBe(true)
    expect(guard.release(true)).toBe(true)
    expect(guard.alive()).toBe(false)
  })

  it('keeps the guard installed when the controller stops watching', () => {
    const host = new FakeHost()
    const guard = new QuotaGuard(identity(), host, scriptPath)
    guard.install()
    const afterCrash = new QuotaGuard(identity(), host, scriptPath)
    expect(afterCrash.alive()).toBe(true)
    expect(host.cron.has('prime-quota-run-42')).toBe(true)
  })

  it('never removes another run\'s entry', () => {
    const host = new FakeHost()
    host.installCron('prime-quota-other-run', '*/5 * * * * other')
    const guard = new QuotaGuard(identity(), host, scriptPath)
    guard.install()
    guard.release(true)
    expect(host.cron.has('prime-quota-other-run')).toBe(true)
  })
})

/** A host that records the resources a cleanup removed. */
class FakeCleanupHost implements CleanupHost {
  cron = new Map<string, string>()
  removed: string[] = []

  removeCron(entryName: string): void {
    if (this.cron.has(entryName)) this.removed.push(`cron:${entryName}`)
    this.cron.delete(entryName)
  }

  stopService(unit: string): void { this.removed.push(`service:${unit}`) }
  removeSocket(path: string): void { this.removed.push(`socket:${path}`) }
  stopTmuxServer(name: string): void { this.removed.push(`tmux:${name}`) }
  removeScratch(path: string): void { this.removed.push(`scratch:${path}`) }
}

const resources = (): RunResources => ({
  guardEntryName: 'prime-quota-run-42',
  serviceUnit: 'dsh-prime-ab12cd34',
  socketPath: '/run/dsh-prime/ab12cd34.sock',
  tmuxServer: 'dsh-prime-ab12cd34',
  workspaceScratch: '/var/lib/dsh-prime/runs/run-42/scratch',
})

/** A host whose guard script and accounting source report different readings. */
const splitHost = (script: string, accounting: string, exitCode = 0): FakeHost => {
  const host = new FakeHost()
  host.execHandler = (argv) => argv[0]!.includes('accounting')
    ? { exitCode, stdout: accounting, stderr: '' }
    : { exitCode: 0, stdout: script, stderr: '' }
  return host
}

describe('the monitoring round', () => {
  it('detects a silent green guard: the guard reports ok while the accounting says otherwise', () => {
    const host = splitHost('verdict=ok\ntokens=10\nscope=session\n', 'tokens=500\nscope=session\n')
    const monitor = new QuotaMonitor(identity(), host, scriptPath)
    monitor.install()
    const observation = monitor.round()
    expect(observation.fault).toBe('silent-green')
    expect(observation.action).toBe('stop')
    expect(observation.requiresStop).toBe(true)
  })

  it('states the billing coverage and the thresholds it used', () => {
    const host = splitHost('verdict=ok\ntokens=10\nscope=session\n', 'tokens=10\nscope=session\n')
    const monitor = new QuotaMonitor(identity(), host, scriptPath)
    monitor.install()
    const observation = monitor.round()
    expect(observation.coverage?.accountWideGuarantee).toBe(false)
    expect(observation.coverage?.statement).toContain('does not establish an account-wide billed quota guarantee')
    expect(observation.warnTokens).toBe(100)
    expect(observation.stopTokens).toBe(200)
  })

  it('fails closed when the metrics cannot be read', () => {
    const host = splitHost('verdict=ok\ntokens=10\nscope=session\n', '', 1)
    const monitor = new QuotaMonitor(identity(), host, scriptPath)
    monitor.install()
    const observation = monitor.round()
    expect(observation.fault).toBe('unreadable-metrics')
    expect(observation.action).toBe('stop')
    expect(observation.requiresStop).toBe(true)
  })

  it('records a durable alert at the warning threshold', () => {
    const host = splitHost('verdict=warn\ntokens=150\nscope=session\n', 'tokens=150\nscope=session\n')
    const monitor = new QuotaMonitor(identity(), host, scriptPath)
    monitor.install()
    const observation = monitor.round()
    expect(observation.fault).toBe('warning')
    expect(observation.action).toBe('warn')
    expect(observation.requiresStop).toBe(false)
    monitor.record(observation)
    const written = JSON.parse(host.alerts.get('/var/lib/prime/runs/run-42/quota-alert.jsonl')!)
    expect(written).toMatchObject({ status: 'warn', fault: 'warning', tokens: 150, scope: 'session' })
  })

  it('requires the stop path at the stop threshold', () => {
    const host = splitHost('verdict=stop\ntokens=500\nscope=session\n', 'tokens=500\nscope=session\n')
    const monitor = new QuotaMonitor(identity(), host, scriptPath)
    monitor.install()
    const observation = monitor.round()
    expect(observation.fault).toBe('threshold')
    expect(observation.action).toBe('stop')
    expect(observation.requiresStop).toBe(true)
  })

  it('detects a lost guard liveness', () => {
    const host = splitHost('verdict=ok\ntokens=10\nscope=session\n', 'tokens=10\nscope=session\n')
    const monitor = new QuotaMonitor(identity(), host, scriptPath)
    monitor.install()
    host.cron.delete('prime-quota-run-42')
    const observation = monitor.round()
    expect(observation.fault).toBe('guard-lost')
    expect(observation.action).toBe('stop')
    expect(observation.requiresStop).toBe(true)
  })

  it('keeps the guard installed when the controller crashes', () => {
    const host = splitHost('verdict=ok\ntokens=10\nscope=session\n', 'tokens=10\nscope=session\n')
    new QuotaMonitor(identity(), host, scriptPath).install()
    const afterCrash = new QuotaMonitor(identity(), host, scriptPath)
    expect(afterCrash.liveness().alive).toBe(true)
    expect(host.cron.has('prime-quota-run-42')).toBe(true)
  })

  it('removes the guard only after a confirmed stop', () => {
    const host = splitHost('verdict=ok\ntokens=10\nscope=session\n', 'tokens=10\nscope=session\n')
    const monitor = new QuotaMonitor(identity(), host, scriptPath)
    monitor.install()
    expect(monitor.release(false)).toBe(false)
    expect(host.cron.has('prime-quota-run-42')).toBe(true)
    expect(monitor.release(true)).toBe(true)
    expect(host.cron.has('prime-quota-run-42')).toBe(false)
  })
})

describe('the independent emergency stop', () => {
  it('stops the run\'s own cgroup without a controller', () => {
    const dir = workspace()
    const cgroup = join(dir, 'cgroup')
    mkdirSync(cgroup)
    writeFileSync(join(cgroup, 'cgroup.kill'), '')
    const result = spawnSync('sh', [
      scriptPath,
      '--session', join(dir, 'session.jsonl'),
      '--log', join(dir, 'guard.log'),
      '--warn', '100',
      '--stop', '200',
      '--alert', join(dir, 'alert.jsonl'),
      '--cgroup', cgroup,
      '--emergency',
    ], { encoding: 'utf8' })
    expect(result.status).toBe(2)
    expect(result.stdout).toContain('reason=emergency-stop')
    expect(readFileSync(join(cgroup, 'cgroup.kill'), 'utf8')).toBe('1')
  })

  it('never touches another cgroup', () => {
    const dir = workspace()
    const cgroup = join(dir, 'cgroup')
    const other = join(dir, 'other-cgroup')
    mkdirSync(cgroup)
    mkdirSync(other)
    writeFileSync(join(cgroup, 'cgroup.kill'), '')
    writeFileSync(join(other, 'cgroup.kill'), '')
    spawnSync('sh', [
      scriptPath,
      '--session', join(dir, 'session.jsonl'),
      '--log', join(dir, 'guard.log'),
      '--warn', '100',
      '--stop', '200',
      '--alert', join(dir, 'alert.jsonl'),
      '--cgroup', cgroup,
      '--emergency',
    ], { encoding: 'utf8' })
    expect(readFileSync(join(other, 'cgroup.kill'), 'utf8')).toBe('')
  })
})

describe('the emergency stop through the guard', () => {
  it('stops the run\'s own cgroup without the controller', () => {
    const host = new FakeHost()
    const monitor = new QuotaMonitor(identity(), host, scriptPath)
    monitor.emergencyStop()
    const argv = host.execs[0]!
    expect(argv).toContain('--emergency')
    expect(argv[argv.indexOf('--cgroup') + 1]).toBe('/sys/fs/cgroup/prime/run-42')
    expect(argv).not.toContain('/usr/local/bin/accounting')
  })
})

describe('the cleanup of a finished run', () => {
  it('removes only the bridge-owned resources after a confirmed quiescence', () => {
    const host = new FakeCleanupHost()
    host.cron.set('prime-quota-run-42', 'entry')
    host.cron.set('prime-quota-other-run', 'entry')
    const outcome = cleanupRun(resources(), { quiescence: 'quiescent', stopConfirmed: true }, host)
    expect(outcome.refused).toBeNull()
    expect(outcome.removed).toEqual([
      'cron:prime-quota-run-42',
      'service:dsh-prime-ab12cd34',
      'socket:/run/dsh-prime/ab12cd34.sock',
      'tmux:dsh-prime-ab12cd34',
      'scratch:/var/lib/dsh-prime/runs/run-42/scratch',
    ])
    expect(host.cron.has('prime-quota-other-run')).toBe(true)
  })

  it('removes nothing while the stop is unconfirmed', () => {
    const host = new FakeCleanupHost()
    host.cron.set('prime-quota-run-42', 'entry')
    const outcome = cleanupRun(resources(), { quiescence: 'busy', stopConfirmed: false }, host)
    expect(outcome.removed).toEqual([])
    expect(outcome.refused).toContain('not confirmed')
    expect(host.cron.has('prime-quota-run-42')).toBe(true)
  })

  it('refuses the cleanup when the state of the run is unknown', () => {
    const host = new FakeCleanupHost()
    const outcome = cleanupRun(resources(), { quiescence: 'unknown', stopConfirmed: true }, host)
    expect(outcome.removed).toEqual([])
    expect(outcome.refused).toContain('unknown')
  })
})
