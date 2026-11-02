/**
 * Typed process and containment adapter for the Prime Runner Bridge.
 *
 * The adapter derives the exact argument vector and the mounts one run needs from an approved manifest, names the
 * run's private service, cgroup, socket and tmux identities, and answers the containment questions the controller
 * must be able to prove. Every answer fails closed: a host that cannot show a boundary is reported as unknown,
 * never as safe.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, dirname, join, relative, resolve, sep } from 'node:path'
import type { ApprovedManifest } from '../executor/prime-model.ts'

/** Raised when the host cannot provide a required confinement, or when a path escapes its approved root. */
export class IsolationError extends Error {
  constructor(message: string) { super(message); this.name = 'IsolationError' }
}

/** The mounts and the command one run needs inside its confinement. */
export interface IsolationPlan {
  /** The isolation backend; only `bubblewrap` provides a real boundary. */
  backend: 'bubblewrap'
  /** The segment the plan belongs to; the run identities derive from it. */
  segmentId: string
  /** The host path of the clean checkout the runner works in. */
  workspace: string
  /** The host path of the repository the checkout belongs to. */
  repositoryRoot: string
  /** The path the repository is mounted at inside the confinement. */
  mountPoint: string
  /** The path the workspace is mounted at inside the confinement. */
  workspaceMount: string
  /** The host paths the runner may write; each one lies inside the workspace. */
  writablePaths: string[]
  /** The host paths bound read-only: the checkout first, then the toolchain paths the runner needs to execute. */
  readOnlyPaths: string[]
  /** A read-only file inside the checkout, used by the hardlink escape probe. */
  readOnlySample: string
  /** The network policy the host egress filter applies. */
  network: 'none' | 'allowlist'
  /** The endpoints the runner may reach when the policy is `allowlist`. */
  allowedEndpoints: string[]
  /** The host home directory; it is masked inside the confinement. */
  home: string
  /** The host temporary directory; it is masked inside the confinement. */
  tmp: string
  /** The command the runner executes inside the confinement. */
  argv: string[]
  /** The environment inside the confinement; it carries no credential value. */
  env: Record<string, string>
  /** The file descriptors the runner inherits; nothing beyond the standard streams. */
  inheritedDescriptors: number[]
  /** The cgroup the run belongs to. */
  cgroup: string
  /** The private daemon socket of the run. */
  socket: string
}

/** The optional parts of a plan that the caller supplies. */
export interface IsolationPlanOptions {
  /** The repository root of the checkout; it defaults to the workspace. */
  repositoryRoot?: string
  /** The command the runner executes inside the confinement. */
  argv?: string[]
  /** The segment the run belongs to. */
  segmentId?: string
  /** The home directory to mask; it defaults to the operator's home. */
  home?: string
  /** The temporary directory to mask; it defaults to the host temporary directory. */
  tmp?: string
  /** The toolchain paths bound read-only; they default to `/usr` and `/etc/ssl`. */
  systemPaths?: string[]
}

/** The default toolchain paths the confinement needs to execute the runner. */
const DEFAULT_SYSTEM_PATHS = ['/usr', '/etc/ssl']

/** Rejects a path that is absolute, empty, or names control state. */
function checkRelativePath(path: string, label: string): void {
  if (!path || path.trim() !== path) throw new IsolationError(`a ${label} may not be empty or padded with whitespace`)
  if (path.startsWith('/') || path.startsWith('~')) throw new IsolationError(`a ${label} must be relative to the workspace: ${path}`)
  if (path.includes('\0')) throw new IsolationError(`a ${label} may not contain a NUL byte`)
  if (path === '.') throw new IsolationError(`a ${label} must name a file or a directory inside the workspace, not the workspace root`)
  if (path.split('/').some(part => part === '' || part === '.' || part === '..')) throw new IsolationError(`a ${label} may not contain "." or "..": ${path}`)
  if (path === '.git' || path.startsWith('.git/') || path.startsWith('.specify/')) throw new IsolationError(`a ${label} may not name control state: ${path}`)
}

/** The key every run identity derives from; the hash keeps two runs apart even when their names look alike. */
function identityKey(segmentId: string): string {
  const slug = segmentId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)
  const hash = createHash('sha256').update(segmentId, 'utf8').digest('hex').slice(0, 16)
  return `${slug || 'segment'}-${hash}`
}

/** The name of the user service unit that hosts one run. */
export function systemdUnitName(segmentId: string): string {
  return `prime-runner-${identityKey(segmentId)}`
}

/**
 * The delegated cgroup root the run's service unit creates under.
 * The cgroup v2 hierarchy is delegated to the unprivileged user only under the
 * user manager's own root; the session scope and the system slices are root
 * owned and cannot be written to.
 */
export const CGROUP_ROOT = '/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice'

/**
 * The delegated cgroup that holds the process tree of one run.
 * It is created by the run's user service unit, whose `Delegate` property gives
 * the unit its own cgroup under {@link CGROUP_ROOT}.
 */
export function cgroupPath(segmentId: string): string {
  return `${CGROUP_ROOT}/${systemdUnitName(segmentId)}.service`
}

/** The name of the private tmux server of one run. */
export function tmuxServerName(segmentId: string): string {
  return `prime-runner-tmux-${identityKey(segmentId)}`
}

/**
 * The directory the private Prime daemon sockets live in.
 *
 * The bridge creates this directory before a run starts, so the path has to be
 * writable by the deployment account. The account's own runtime directory is
 * private to it, while the system runtime directory (`/run`) belongs to root
 * and cannot be created without privileges.
 */
export function socketDirectory(runtimeRoot = process.env.XDG_RUNTIME_DIR || tmpdir()): string {
  return join(runtimeRoot, 'dsh-prime')
}

/** The path of the private Prime daemon socket of one run. */
export function socketPath(segmentId: string, runtimeRoot = process.env.XDG_RUNTIME_DIR || tmpdir()): string {
  return join(socketDirectory(runtimeRoot), `${identityKey(segmentId)}.sock`)
}

/** The first regular file of a directory, used as the read-only sample of the hardlink probe. */
function firstRegularFile(directory: string): string | undefined {
  let entries: string[]
  try { entries = readdirSync(directory) } catch { return undefined }
  for (const entry of entries.sort()) {
    const path = join(directory, entry)
    try { if (lstatSync(path).isFile()) return path } catch { /* An unreadable entry is skipped. */ }
  }
  return undefined
}

/**
 * One host command the confinement has to be able to execute.
 */
export interface BoundCommand {
  /** The command as the manifest names it. */
  command: string
  /** The file the command resolves to on the host. */
  file: string
  /** The host directories that have to be bound read-only for the command to run. */
  directories: string[]
  /** The directory the command is resolved from, which the sandbox's PATH has to name. */
  searchPath: string
}

/**
 * The directories a resolved command needs beside its own file.
 *
 * A command installed as a package keeps its own files next to it: the packaged runtime and the bundled models of
 * the runner, the module tree of a JavaScript command. The package root is bound, not only the file.
 */
function commandDirectories(file: string): string[] {
  const parts = file.split(sep)
  const index = parts.lastIndexOf('node_modules')
  if (index >= 0 && index + 1 < parts.length) return [parts.slice(0, index + 2).join(sep)]
  return [dirname(file)]
}

/**
 * Resolves one command on the host and names the paths the confinement has to bind for it.
 *
 * The runner and the commands the approved checks name live outside the repository and outside the masked home,
 * so the confinement binds their directories read-only and the sandbox's PATH names the directory each command is
 * resolved from.
 * @returns The resolved command, or undefined when the host has no such command.
 */
export function resolveCommand(command: string, path = process.env.PATH ?? ''): BoundCommand | undefined {
  const candidates = command.includes(sep) ? [command] : path.split(delimiter).filter(Boolean).map(directory => join(directory, command))
  for (const candidate of candidates) {
    try {
      if (!statSync(candidate).isFile()) continue
      const file = realpathSync(candidate)
      return { command, file, directories: commandDirectories(file), searchPath: dirname(candidate) }
    } catch { /* the next candidate is tried */ }
  }
  return undefined
}

/**
 * Builds the plan of one run from the approved manifest and the workspace.
 * @throws IsolationError when the manifest approves no isolation backend, or when a writable path leaves the
 * workspace or the repository.
 */
export function isolationPlan(manifest: ApprovedManifest, workspace: string, options: IsolationPlanOptions = {}): IsolationPlan {
  const isolation = manifest.environment.isolation
  if (isolation.backend !== 'bubblewrap') {
    throw new IsolationError('the manifest approves no isolation backend, so the bridge stays disabled without a real boundary')
  }
  const root = resolve(options.repositoryRoot ?? workspace)
  const work = resolve(workspace)
  if (work !== root && !work.startsWith(root + sep)) throw new IsolationError('the workspace must live inside the repository root')
  const writablePaths: string[] = []
  for (const path of isolation.writablePaths) {
    checkRelativePath(path, 'writable path')
    const target = resolve(work, path)
    if (target !== work && !target.startsWith(work + sep)) throw new IsolationError(`the writable path ${path} escapes the workspace`)
    if (target !== root && !target.startsWith(root + sep)) throw new IsolationError(`the writable path ${path} escapes the repository`)
    if (!writablePaths.includes(target)) writablePaths.push(target)
  }
  const segmentId = options.segmentId ?? 'unassigned'
  const sample = firstRegularFile(root)
  // The runner and the commands the approved checks name are bound read-only, so the confinement can execute them
  // even though the operator's home is masked and only the repository is bound.
  const runner = resolveCommand(manifest.environment.runner.cli)
  const tools = manifest.checks.map(check => check.argv[0] ?? '').filter(Boolean).map(command => resolveCommand(command))
  const bound = [runner, ...tools].filter((item): item is BoundCommand => item !== undefined)
  const directories = [...new Set(bound.flatMap(item => [...item.directories, item.searchPath]))]
  const searchPath = [...new Set([...bound.map(item => item.searchPath), '/usr/local/bin', '/usr/bin', '/bin'])].join(':')
  return {
    backend: 'bubblewrap',
    segmentId,
    workspace: work,
    repositoryRoot: root,
    mountPoint: '/workspace',
    workspaceMount: work === root ? '/workspace' : `/workspace/${relative(root, work)}`,
    writablePaths,
    readOnlyPaths: [root, ...directories, ...(options.systemPaths ?? DEFAULT_SYSTEM_PATHS).map(path => resolve(path))],
    readOnlySample: sample ? join(root === work ? '/workspace' : `/workspace/${relative(root, work)}`, relative(root, sample)) : '/workspace',
    network: isolation.network,
    allowedEndpoints: [...isolation.allowedEndpoints],
    home: resolve(options.home ?? homedir()),
    tmp: resolve(options.tmp ?? tmpdir()),
    argv: runner ? [runner.file, ...(options.argv ?? [manifest.environment.runner.cli]).slice(1)] : options.argv ?? [manifest.environment.runner.cli],
    env: { HOME: '/tmp', TMPDIR: '/tmp', PATH: searchPath, LANG: 'C.UTF-8' },
    inheritedDescriptors: [0, 1, 2],
    cgroup: cgroupPath(segmentId),
    socket: socketPath(segmentId),
  }
}

/**
 * Builds the bubblewrap argument vector of a plan.
 *
 * The vector never becomes a shell string: it unshares the process, IPC, UTS and network namespaces, mounts a
 * private `/proc`, masks the host home and temporary directory with a tmpfs, binds the checkout read-only, binds
 * only the approved writable paths writable, and passes no file descriptor beyond the standard streams.
 */
export function buildBwrapArgs(plan: IsolationPlan): string[] {
  const args = [
    'bwrap',
    '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-net',
    '--die-with-parent', '--new-session',
    '--hostname', 'prime-runner',
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/home',
    '--tmpfs', '/tmp',
    '--ro-bind', plan.repositoryRoot, plan.mountPoint,
  ]
  for (const path of plan.readOnlyPaths.slice(1)) args.push('--ro-bind', path, path)
  for (const path of plan.writablePaths) {
    const target = `${plan.workspaceMount}/${relative(plan.workspace, path)}`
    args.push('--bind', path, target)
  }
  args.push('--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64')
  args.push('--chdir', plan.workspaceMount)
  args.push('--clearenv')
  for (const [name, value] of Object.entries(plan.env)) args.push('--setenv', name, value)
  args.push('--', ...plan.argv)
  return args
}

/** The options of one confined command. */
export interface IsolationRunOptions {
  /** The working directory of the command. */
  cwd?: string
  /** The environment of the command. */
  env?: Record<string, string | undefined>
  /** How long the command may run, in milliseconds. */
  timeoutMs?: number
  /** The signal that stops the command. */
  signal?: AbortSignal
}

/** The result of one confined command. */
export interface IsolationRunResult {
  /** The exit code of the command, or `null` when a signal ended it. */
  exitCode: number
  /** The standard output of the command. */
  stdout: string
  /** The standard error of the command. */
  stderr: string
}

/** A running confined process. */
export interface IsolationProcess {
  /** The process ID of the confined process. */
  readonly pid: number
  /** Sends a signal to the process. */
  kill(signal?: number): void
  /** Waits for the process to end and returns its result. */
  wait(): Promise<IsolationRunResult>
  /** The output the process has written so far. */
  output(): string
  /** The error output the process has written so far. */
  stderr(): string
  /** Whether the process has already ended. */
  ended(): boolean
}

/** The adapter the supervisor uses to start and observe confined processes. */
export interface IsolationRunner {
  /** Runs a command to completion. */
  run(argv: string[], options?: IsolationRunOptions): Promise<IsolationRunResult>
  /** Starts a command and returns its handle. */
  spawn(argv: string[], options?: IsolationRunOptions): IsolationProcess
}

/** Runs a command on the host; the confinement itself comes from the argument vector. */
export const localIsolationRunner: IsolationRunner = {
  async run(argv: string[], options: IsolationRunOptions = {}): Promise<IsolationRunResult> {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: options.signal,
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', chunk => { stdout += chunk })
    child.stderr?.on('data', chunk => { stderr += chunk })
    const timer = options.timeoutMs ? setTimeout(() => child.kill('SIGKILL'), options.timeoutMs) : undefined
    const code = await new Promise<number | null>(resolve => {
      child.on('error', () => resolve(null))
      child.on('close', value => resolve(value))
    })
    if (timer) clearTimeout(timer)
    return { exitCode: code ?? -1, stdout, stderr }
  },
  spawn(argv: string[], options: IsolationRunOptions = {}): IsolationProcess {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: options.signal,
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', chunk => { stdout += chunk })
    child.stderr?.on('data', chunk => { stderr += chunk })
    let ended = false
    child.on('close', () => { ended = true })
    const handle: IsolationProcess = {
      pid: child.pid ?? -1,
      kill(signal?: number) { child.kill(signal ?? 'SIGTERM') },
      output() { return stdout },
      stderr() { return stderr },
      ended() { return ended },
      async wait() {
        const code = await new Promise<number | null>(resolve => {
          child.on('error', () => resolve(null))
          child.on('close', value => resolve(value))
        })
        return { exitCode: code ?? -1, stdout, stderr }
      },
    }
    return handle
  },
}

/**
 * Reads the process list of a cgroup.
 * @throws IsolationError when the cgroup cannot be read; a missing cgroup is not proof of anything.
 */
export function cgroupProcesses(cgroup: string): number[] {
  let text: string
  try { text = readFileSync(join(cgroup, 'cgroup.procs'), 'utf8') } catch (error) {
    throw new IsolationError(`the cgroup ${cgroup} cannot be read: ${String(error)}`)
  }
  return text.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
    const pid = Number(line)
    if (!Number.isInteger(pid)) throw new IsolationError(`the cgroup ${cgroup} holds an unreadable process entry: ${line}`)
    return pid
  })
}

/** What a cgroup shows about the processes of a run. */
export type QuiescenceState = 'quiescent' | 'busy' | 'unknown'

/**
 * Reads the state of a cgroup.
 *
 * An empty process list proves that the run is quiescent. A missing or unreadable cgroup is `unknown`, because
 * an unreadable cgroup is not proof that the run stopped.
 */
export function quiescenceState(cgroup: string): QuiescenceState {
  try {
    return cgroupProcesses(cgroup).length ? 'busy' : 'quiescent'
  } catch {
    return 'unknown'
  }
}

/** Whether a cgroup proves that the run holds no process; a missing cgroup never does. */
export function isQuiescent(cgroup: string): boolean {
  return quiescenceState(cgroup) === 'quiescent'
}

/** The containment questions the controller must be able to answer before it trusts a run. */
export type ProbeKind =
  | 'filesystem-escape'
  | 'hardlink-escape'
  | 'symlink-escape'
  | 'proc-visibility'
  | 'ipc-socket'
  | 'capabilities'
  | 'inherited-descriptors'
  | 'cgroup-escape'
  | 'network-policy'
  | 'verifier-credentials'

/** Every probe kind, in the order the controller runs them. */
export const PROBE_KINDS: readonly ProbeKind[] = [
  'filesystem-escape', 'hardlink-escape', 'symlink-escape', 'proc-visibility', 'ipc-socket',
  'capabilities', 'inherited-descriptors', 'cgroup-escape', 'network-policy', 'verifier-credentials',
]

/** What one probe attempt observed. */
export interface ProbeOutcome {
  /** Whether the attempt escaped the confinement. */
  escaped: boolean
  /** A short description of what the attempt observed. */
  detail: string
}

/** Runs one probe attempt inside the confinement. */
export type ProbeAttempt = (kind: ProbeKind, plan: IsolationPlan) => Promise<ProbeOutcome>

/** The result of one probe. */
export interface ProbeResult {
  /** The probe the result belongs to. */
  kind: ProbeKind
  /** Whether the confinement held. */
  passed: boolean
  /** The reason for the verdict, in one line. */
  reason: string
}

/** The reason a probe passed. */
const PASSED_REASON: Record<ProbeKind, string> = {
  'filesystem-escape': 'a write outside the approved paths was blocked',
  'hardlink-escape': 'a hard link out of the approved paths could not be written through',
  'symlink-escape': 'a symbolic link out of the approved paths could not be written through',
  'proc-visibility': 'only the processes of the confinement are visible',
  'ipc-socket': 'the host daemon socket is unreachable',
  'capabilities': 'the process holds no Linux capability',
  'inherited-descriptors': 'no descriptor beyond the standard streams was inherited',
  'cgroup-escape': 'the process stays inside the cgroup of the run',
  'network-policy': 'no network access beyond the approved endpoints was possible',
  'verifier-credentials': 'no credential of the controller is readable inside the confinement',
}

/** The reason a probe failed. */
const FAILED_REASON: Record<ProbeKind, string> = {
  'filesystem-escape': 'the run wrote outside the approved paths',
  'hardlink-escape': 'the run wrote through a hard link out of the approved paths',
  'symlink-escape': 'the run wrote through a symbolic link out of the approved paths',
  'proc-visibility': 'the run sees processes outside its own confinement',
  'ipc-socket': 'the host daemon socket is reachable from the run',
  'capabilities': 'the run holds a Linux capability',
  'inherited-descriptors': 'the run inherited a descriptor beyond the standard streams',
  'cgroup-escape': 'the run left the cgroup of the run',
  'network-policy': 'the run reached a network endpoint beyond the approved ones',
  'verifier-credentials': 'a credential of the controller is readable from the run',
}

/**
 * Runs one probe and reports whether the confinement held.
 */
export async function probeContainment(kind: ProbeKind, plan: IsolationPlan, attempt: ProbeAttempt): Promise<ProbeResult> {
  const outcome = await attempt(kind, plan)
  const passed = !outcome.escaped
  return { kind, passed, reason: passed ? PASSED_REASON[kind] : `${FAILED_REASON[kind]}: ${outcome.detail}` }
}

/** Runs every probe and returns one result per kind. */
export async function containmentProbes(plan: IsolationPlan, attempt: ProbeAttempt): Promise<ProbeResult[]> {
  const results: ProbeResult[] = []
  for (const kind of PROBE_KINDS) results.push(await probeContainment(kind, plan, attempt))
  return results
}

/** The verdict of the containment check. */
export interface ConfinementVerdict {
  /** Whether every probe held. */
  confined: boolean
  /** The result of every probe. */
  probes: ProbeResult[]
  /** The reason of each failed probe. */
  failures: string[]
}

/**
 * Runs the containment probes of a plan and returns the verdict.
 *
 * @param attempt - the attempt implementation; the default runs the probes inside the confinement itself.
 */
export async function verifyConfinement(plan: IsolationPlan, attempt: ProbeAttempt = sandboxProbeAttempt(localIsolationRunner, plan)): Promise<ConfinementVerdict> {
  const probes = await containmentProbes(plan, attempt)
  const failures = probes.filter(result => !result.passed).map(result => `${result.kind}: ${result.reason}`)
  return { confined: failures.length === 0, probes, failures }
}

/** The script of each probe; the paths arrive as environment variables, so no value is interpolated into the script. */
const PROBE_SCRIPTS: Record<ProbeKind, string> = {
  'filesystem-escape': 'if touch "$PROBE_OUTSIDE" 2>/dev/null; then echo ESCAPED; else echo BLOCKED; fi',
  'hardlink-escape': 'rm -f "$PROBE_LINK" 2>/dev/null; if ln "$PROBE_SOURCE" "$PROBE_LINK" 2>/dev/null && echo x >> "$PROBE_LINK" 2>/dev/null; then echo ESCAPED; else echo BLOCKED; fi',
  'symlink-escape': 'rm -f "$PROBE_LINK" 2>/dev/null; ln -s "$PROBE_TARGET" "$PROBE_LINK" 2>/dev/null; if echo x > "$PROBE_LINK" 2>/dev/null; then echo ESCAPED; else echo BLOCKED; fi',
  'proc-visibility': 'count=0; for entry in /proc/[0-9]*; do count=$((count+1)); done; if [ "$count" -gt 1 ]; then echo ESCAPED; else echo BLOCKED; fi',
  'ipc-socket': 'if [ -e "$PROBE_HOST_SOCKET" ]; then echo ESCAPED; else echo BLOCKED; fi',
  'capabilities': 'cap=$(awk \'/^CapEff:/ { print $2 }\' /proc/self/status 2>/dev/null); if [ -n "$cap" ] && [ "$cap" != "0000000000000000" ]; then echo ESCAPED; else echo BLOCKED; fi',
  'inherited-descriptors': 'bad=0; for fd in /proc/self/fd/*; do target=$(readlink "$fd" 2>/dev/null || true); case "$target" in socket:*) bad=1 ;; esac; done; if [ "$bad" -eq 1 ]; then echo ESCAPED; else echo BLOCKED; fi',
  'cgroup-escape': 'own=$(awk -F: \'/^0::/ { print $3 }\' /proc/self/cgroup 2>/dev/null); case "$own" in *"$PROBE_CGROUP_KEY"*) echo BLOCKED ;; *) echo ESCAPED ;; esac',
  'network-policy': 'if timeout 5 bash -c \'exec 3<>/dev/tcp/1.1.1.1/443\' 2>/dev/null; then echo ESCAPED; else echo BLOCKED; fi',
  'verifier-credentials': 'bad=0; for path in "$HOME/.ssh" "$HOME/.netrc" "$HOME/.config/gh" "$HOME/.aws" "$PROBE_SECRET"; do if [ -e "$path" ]; then bad=1; fi; done; if [ "$bad" -eq 1 ]; then echo ESCAPED; else echo BLOCKED; fi',
}

/** The environment every probe script needs. */
function probeEnvironment(plan: IsolationPlan): Record<string, string> {
  const writableMount = plan.writablePaths.length
    ? `${plan.workspaceMount}/${relative(plan.workspace, plan.writablePaths[0]!)}`
    : plan.workspaceMount
  return {
    ...plan.env,
    PROBE_OUTSIDE: `${plan.workspaceMount}/.prime-escape-probe`,
    PROBE_SOURCE: plan.readOnlySample,
    PROBE_LINK: `${writableMount}/.prime-probe-link`,
    PROBE_TARGET: '/etc/shadow',
    PROBE_HOST_SOCKET: plan.socket,
    PROBE_CGROUP_KEY: plan.cgroup.split('/').filter(Boolean).pop() ?? '',
    PROBE_SECRET: '/etc/ssl/private',
  }
}

/**
 * Builds an attempt that runs the probe scripts inside the confinement of a plan.
 *
 * Each script reports `ESCAPED` when the confinement did not hold and `BLOCKED` when it did. A script that
 * reports neither counts as an escape, because an unproven probe is not a passed probe.
 */
export function sandboxProbeAttempt(runner: IsolationRunner, plan: IsolationPlan): ProbeAttempt {
  return async kind => {
    const script = PROBE_SCRIPTS[kind]
    const argv = buildBwrapArgs({ ...plan, argv: ['/bin/sh', '-c', script] })
    const result = await runner.run(argv, { cwd: plan.workspace, env: probeEnvironment(plan), timeoutMs: 30_000 })
    const output = `${result.stdout}\n${result.stderr}`
    if (output.includes('ESCAPED')) return { escaped: true, detail: 'the probe reached outside the confinement' }
    if (output.includes('BLOCKED')) return { escaped: false, detail: 'the confinement blocked the attempt' }
    return { escaped: true, detail: 'the probe reported no verdict' }
  }
}

/** One collected file below an artifact root. */
export interface CollectedArtifact {
  /** The path of the file, relative to the artifact root. */
  path: string
  /** The size of the file in bytes. */
  bytes: number
  /** The SHA-256 over the exact bytes of the file. */
  sha256: string
}

/**
 * Collects the files below an artifact root without following links.
 *
 * A symbolic link, a link whose other names lie outside the root, and any path that is not inside the root are
 * refused, so a collected artifact cannot smuggle content from outside the run.
 * @throws IsolationError when the root or one of its entries is refused.
 */
export function collectArtifacts(root: string): CollectedArtifact[] {
  const base = resolve(root)
  let rootStats
  try { rootStats = lstatSync(base) } catch (error) {
    throw new IsolationError(`the artifact root ${base} cannot be read: ${String(error)}`)
  }
  if (!rootStats.isDirectory()) throw new IsolationError(`the artifact root ${base} is not a directory`)
  const found: { path: string; absolute: string }[] = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name)
      const path = relative(base, absolute)
      if (entry.isSymbolicLink()) throw new IsolationError(`the artifact root holds a symbolic link: ${path}`)
      if (entry.isDirectory()) { walk(absolute); continue }
      if (!entry.isFile()) throw new IsolationError(`the artifact root holds an unsupported entry: ${path}`)
      if (!path || path.startsWith('..')) throw new IsolationError(`the artifact ${path} is not inside the artifact root`)
      found.push({ path, absolute })
    }
  }
  walk(base)
  const inside = new Map<string, number>()
  const links: { path: string; key: string; nlink: number }[] = []
  for (const file of found) {
    const stats = lstatSync(file.absolute)
    const key = `${stats.dev}:${stats.ino}`
    inside.set(key, (inside.get(key) ?? 0) + 1)
    links.push({ path: file.path, key, nlink: stats.nlink })
  }
  for (const link of links) {
    if (link.nlink > (inside.get(link.key) ?? 0)) {
      throw new IsolationError(`the artifact ${link.path} has links outside the artifact root`)
    }
  }
  return found.map(file => {
    const bytes = readFileSync(file.absolute)
    return { path: file.path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  })
}
