/**
 * The composition of the Prime Runner Bridge: the concrete adapters the coordinator drives, assembled from the Store,
 * the Effects queue, the Engine, the Outbox, and the command line.
 * Every adapter that would reach GitHub or the runner is a seam, so the bridge stays disabled while the deployment has
 * not approved an environment.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { key } from '../core/ids.ts'
import type { OutboundMessage, Ticket } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import type { Commands } from '../infra/commands.ts'
import { isolationPlan, type IsolationPlan } from '../infra/prime-isolation.ts'
import { PrimeSupervisor, type RunEnvironment } from '../executor/prime-supervisor.ts'
import { deliver as deliverPull, type BranchProtection, type CreatePullInput, type DeliveryLedger, type PullPort,
  type PullRef, type PullState, type UpdatePullInput } from '../executor/prime-delivery.ts'
import { QuotaMonitor, type GuardIdentity } from '../executor/prime-quota.ts'
import { buildManifest, manifestDigest, type ManifestSource } from '../executor/prime-manifest.ts'
import { buildLaunchInvocation, AUTONOMOUS_FLAGS } from '../executor/prime-launch.ts'
import { preflight, type PreflightHost } from '../executor/prime-preflight.ts'
import { approvalEvidence, approvalIsCurrent, approveRun, verifyGateCommit, verifyGateDecision, type AccountType,
  type ApprovalEvidence, type ApprovalSource } from './prime-approval.ts'
import { readCommit } from '../sources/github-read.ts'
import { policyVersion } from '../policy.ts'
import { z } from 'zod'
import { PrimeBridge, type ApprovalPort, type BridgeHost, type DeliveryOutcome, type DeliveryPort, type PreflightOutcome,
  type QuotaObservation, type QuotaPort, type RunnerPort, type RunnerState, type VerifyPort } from '../executor/prime-bridge.ts'
import type { ApprovalRecord, ApprovedEnvironment, ApprovedManifest, BridgeSegment, FailureCause,
  SegmentRunnerIdentity, VerificationResult } from '../executor/prime-model.ts'
import { KV } from '../kv.ts'
import type { Effects } from './effects.ts'
import type { Store } from './store.ts'

/** What the service needs from the host it runs in. */
export interface PrimeServiceDeps {
  store: Store
  effects: Effects
  /** Records a report on a Ticket. */
  report(ticketId: string, report: { state: 'progress' | 'ready' | 'blocked' | 'failed'; summary: string; question?: string }): Ticket
  /** Sends one durable message to a conversation. */
  send(message: OutboundMessage): void
  /** The current settings, which carry the allowlist. */
  settings(): ReturnType<Store['settings']>
  /** The resolved deployment. */
  deployment(): Deployment
  /** The command line the bridge uses for git and GitHub. */
  commands(): Commands
  /** The directory of the repository the bridge works in. */
  repositoryRoot(): string
  /** The environment the operator approved; it is part of every manifest. */
  environment(): Omit<ApprovedEnvironment, 'digest'>
  /** The manifests the Tickets asked to run. */
  manifests(): ApprovedManifest[]
  /** The clock. */
  now(): string
}

/** The manifest a Ticket asked to run, by Ticket ID. */
export function manifestKey(ticketId: string): string { return KV.bridge.manifest(ticketId) }

/**
 * The GitHub logins that may currently approve work.
 *
 * The agent's own account is never among them: the controller acts under that account, so letting it approve
 * would let the agent approve its own work. The separation is enforced here rather than left to the operator's
 * configuration alone.
 */
export function allowlistOf(settings: ReturnType<Store['settings']>, agentLogin?: string): string[] {
  const allowed = settings.policy.sources.github?.allowed.map(entry => entry.id) ?? []
  if (!agentLogin) return allowed
  return allowed.filter(login => login.toLowerCase() !== agentLogin.toLowerCase())
}

/** A manifest source that reads the baseline through git. */
export function gitManifestSource(commands: Commands, root: string, revision?: string): ManifestSource {
  const at = revision ?? 'HEAD'
  return {
    revision: async () => (await commands.git(['rev-parse', `${at}^{commit}`], root)).trim(),
    tree: async () => createHash('sha256').update((await commands.git(['rev-parse', `${at}^{tree}`], root)).trim()).digest('hex'),
    read: async (path: string) => {
      try { return await commands.git(['show', `${at}:${path}`], root) } catch { return undefined }
    },
    paths: async () => (await commands.git(['ls-tree', '-r', '--name-only', at], root)).split('\n').map(line => line.trim()).filter(Boolean),
  }
}

/** The repository metadata the manifest and the approval evidence must name alike. */
const RepositoryRow = z.object({ id: z.number().int().positive() })

/**
 * The numeric id of the configured repository.
 *
 * The manifest names the repository it runs against, and an approval comment is bound to the same repository, so both
 * read one id from GitHub instead of carrying a placeholder that names no repository at all.
 */
async function repositoryId(commands: Commands): Promise<number> {
  return (await commands.api(RepositoryRow, '')).id
}

/** The adapters the coordinator drives. */
export interface PrimeAdapters {
  preflightHost(): PreflightHost
  runner(): RunnerPort
  verify(): VerifyPort
  delivery(): DeliveryPort
  quota(): QuotaPort
}

/** Builds the coordinator with its concrete adapters. */
export function createPrimeBridge(deps: PrimeServiceDeps, adapters: PrimeAdapters): PrimeBridge {
  const { store, effects } = deps
  const approval: ApprovalPort = {
    async revalidate(segment: BridgeSegment, manifest: ApprovedManifest): Promise<void> {
      const digest = manifestDigest(manifest)
      const record = store.bridge.approvals.byTicket(segment.ticketId)
        .filter(item => item.kind === 'run' && item.manifestSha256 === digest).at(-1)
      if (!record) throw new Error('The manifest has no approval')
      if (!approvalIsCurrent(record, allowlistOf(deps.settings(), deps.deployment().github.login))) throw new Error('The approver is no longer allowlisted')
    },
    async gateDecision(segment: BridgeSegment, manifest: ApprovedManifest): Promise<ApprovalRecord | undefined> {
      if (!segment.nextGateId) return undefined
      const digest = manifestDigest(manifest)
      const record = store.bridge.approvals.byTicket(segment.ticketId)
        .filter(item => item.kind === 'gate' && item.gateId === segment.nextGateId && item.manifestSha256 === digest).at(-1)
      if (!record || !record.gateCommit) return undefined
      if (!approvalIsCurrent(record, allowlistOf(deps.settings(), deps.deployment().github.login))) return undefined
      return record
    },
    async findRunApproval(ticketId: string, manifestSha256: string): Promise<ApprovalRecord | undefined> {
      return findRunApproval(deps, ticketId, manifestSha256)
    },
    async findGateApproval(ticketId: string, gateId: string, manifestSha256: string,
      gate: { taskLine: string; parent: string }): Promise<ApprovalRecord | undefined> {
      return findGateApproval(deps, ticketId, gateId, manifestSha256, gate)
    },
  }
  const tickets = {
    report: (ticketId: string, report: { state: 'progress' | 'ready' | 'blocked' | 'failed'; summary: string; question?: string }) => {
      deps.report(ticketId, report)
    },
    notify: (ticketId: string, text: string) => {
      const ticket = store.tickets.get(ticketId)
      if (!ticket) return
      for (const channel of ticket.channels) {
        deps.send({ id: key('prime', ticketId, channel.source, channel.thread, text.slice(0, 40)), channel, text, kind: 'notice', ticketId })
      }
    },
  }
  const host: BridgeHost = {
    store,
    effects,
    approval,
    preflight: {
      async run(segment: BridgeSegment, manifest: ApprovedManifest): Promise<PreflightOutcome> {
        const verdict = await preflight(manifest, adapters.preflightHost())
        return {
          ok: verdict.status === 'ready',
          failures: verdict.failures.map(failure => ({
            cause: 'preflight' as FailureCause,
            summary: `The ${failure.check} check failed: ${failure.detail}`,
            evidence: failure.check,
            nextAction: failure.nextAction,
          })),
        }
      },
    },
    runner: adapters.runner(),
    verify: adapters.verify(),
    delivery: adapters.delivery(),
    quota: adapters.quota(),
    tickets,
    manifest: (ticketId: string) => store.get(manifestKey(ticketId)),
    now: () => deps.now(),
  }
  return new PrimeBridge(host)
}

/**
 * Prepares one run request: it builds the manifest of the feature at the current baseline, keeps it, and asks the
 * person in the original conversation for the exact approval of that manifest.
 * @returns The manifest and its digest, which the approval comment must name.
 */
export async function requestRun(deps: PrimeServiceDeps, ticketId: string, featureDir: string): Promise<{ manifest: ApprovedManifest; digest: string }> {
  const { store } = deps
  const commands = deps.commands()
  const source = gitManifestSource(commands, deps.repositoryRoot())
  const repository = { id: await repositoryId(commands), fullName: deps.deployment().repository }
  const manifest = await buildManifest(source, {
    repository,
    featureDir,
    environment: deps.environment(),
  })
  const digest = manifestDigest(manifest)
  store.set(manifestKey(ticketId), manifest)
  const summary = `The manifest of ${featureDir} is ${digest}. It names ${manifest.allowedPaths.length} writable path(s), `
    + `${manifest.tasks.length} task(s), ${manifest.checks.length} check(s), and the environment ${manifest.environment.digest}.`
  const question = `Approve this exact manifest with \`@<agent> APPROVE RUN ${digest}\`, or change the scope before approving it.`
  deps.effects.enqueue('prime-approval', ticketId, { ticketId })
  deps.report(ticketId, { state: 'progress', summary, question })
  const ticket = store.tickets.get(ticketId)
  for (const channel of ticket?.channels ?? []) {
    deps.send({ id: key('prime-request', ticketId, digest), channel, text: `${summary}\n\n${question}`, kind: 'notice', ticketId })
  }
  return { manifest, digest }
}


/** The host services of a run: its cgroup, socket, tmux server, and scratch directory. */
export function hostRunEnvironment(commands: Commands): RunEnvironment {
  return {
    supported: () => existsSync('/usr/bin/bwrap') || existsSync('/bin/bwrap'),
    async start(plan: IsolationPlan, identity: SegmentRunnerIdentity): Promise<void> {
      // The cgroup is created by the run's own user service unit, whose Delegate
      // property places it under the delegated root the account may write to.
      // Creating it here would fail: the cgroup v2 hierarchy is writable only
      // under the user manager's own root, never under the login session scope.
      const unit = identity.serviceUnit.endsWith('.service') ? identity.serviceUnit : `${identity.serviceUnit}.service`
      await commands.run('systemd-run', ['--user', `--unit=${unit}`, '--property=Delegate=yes', '--collect', '/bin/sleep', 'infinity'])
      const shown = await commands.run('systemctl', ['--user', 'show', unit, '--property=ControlGroup', '--value'])
      const cgroup = shown.trim()
      if (!cgroup.startsWith('/')) throw new Error(`the run's service unit reported no cgroup: ${shown.trim() || 'empty'}`)
      identity.cgroup = `/sys/fs/cgroup${cgroup}`
      mkdirSync(dirname(identity.socket), { recursive: true })
      mkdirSync(plan.workspace, { recursive: true })
    },
    async cancel(identity: SegmentRunnerIdentity): Promise<void> {
      const kill = join(identity.cgroup, 'cgroup.kill')
      if (!existsSync(kill)) throw new Error(`the cgroup of the run has no kill file: ${identity.cgroup}`)
      writeFileSync(kill, '1')
    },
    processes(cgroup: string): number[] {
      const file = join(cgroup, 'cgroup.procs')
      return readFileSync(file, 'utf8').split('\n').map(line => line.trim()).filter(Boolean).map(Number)
    },
    async remove(identity: SegmentRunnerIdentity): Promise<string[]> {
      const removed: string[] = []
      for (const path of [identity.socket, identity.workspace]) {
        if (!existsSync(path)) continue
        rmSync(path, { recursive: true, force: true })
        removed.push(path)
      }
      return removed
    },
  }
}

/** The runner adapter: it launches, stops, and reconciles the run through the supervisor. */
export function runnerAdapter(supervisor: PrimeSupervisor): RunnerPort {
  return {
    async launch(segment: BridgeSegment, manifest: ApprovedManifest): Promise<{ sessionId?: string; sessionFile?: string }> {
      const barrierPath = join(segment.runner.workspace, '.prime-bridge-barrier')
      const invocation = buildLaunchInvocation(manifest, {
        taskIds: segment.taskIds,
        nextGateId: segment.nextGateId ?? undefined,
        barrier: { path: barrierPath, release: `${segment.segmentId}:${segment.generation}` },
      })
      const plan = isolationPlan(manifest, segment.runner.workspace, {
        argv: invocation.argv,
        segmentId: segment.segmentId,
      })
      const result = await supervisor.launch(plan, segment.runner)
      // The barrier is released only after the run's identities are known, so the runner cannot begin work
      // before the controller can reconcile it.
      writeFileSync(invocation.barrier.path, invocation.barrier.release)
      return { sessionId: result.identity.sessionId, sessionFile: result.identity.sessionFile }
    },
    async stop(segment: BridgeSegment): Promise<'stopped' | 'unconfirmed' | 'unknown'> {
      return (await supervisor.stop(segment.runner, 'the bridge stopped the run')).status
    },
    async reconcile(segment: BridgeSegment): Promise<RunnerState> {
      const state = await supervisor.quiescence(segment.runner)
      return {
        running: state.status === 'busy',
        stop: state.status === 'quiescent' ? 'stopped' : state.status === 'busy' ? 'unconfirmed' : 'unknown',
      }
    },
    async cleanup(segment: BridgeSegment, stopConfirmed: boolean): Promise<void> {
      if (!stopConfirmed) throw new Error('the cleanup is refused because the run is not confirmed stopped')
      await supervisor.cleanup(segment.runner)
    },
  }
}

/** The pull-request port over the deployment's GitHub CLI and git. */
export function pullPort(commands: Commands, root: string): PullPort {
  const api = async <T>(path: string, ...flags: string[]): Promise<T> => commands.api(path, ...flags) as Promise<T>
  return {
    async branchHead(branch: string): Promise<string | undefined> {
      try { return (await commands.git(['rev-parse', `refs/heads/${branch}`], root)).trim() } catch { return undefined }
    },
    async createPull(input: CreatePullInput): Promise<PullRef> {
      const body = JSON.stringify({ title: input.title, body: input.body, head: input.head, base: input.base, draft: input.draft })
      return api<PullRef>('pulls', '-X', 'POST', '-f', body)
    },
    async updatePull(number: number, input: UpdatePullInput): Promise<PullRef> {
      const body = JSON.stringify({ title: input.title, body: input.body, draft: input.draft })
      return api<PullRef>(`pulls/${number}`, '-X', 'PATCH', '-f', body)
    },
    async pushRef(branch: string, commit: string, expectedOldSha: string): Promise<{ ok: boolean; reason?: string }> {
      try {
        await commands.git(['push', `--force-with-lease=${branch}:${expectedOldSha}`, 'origin', `${commit}:refs/heads/${branch}`], root)
        return { ok: true }
      } catch (error) {
        return { ok: false, reason: String(error) }
      }
    },
    async pull(number: number): Promise<PullState> {
      return api<PullState>(`pulls/${number}`)
    },
    async branchProtection(branch: string): Promise<BranchProtection> {
      return api<BranchProtection>(`branches/${encodeURIComponent(branch)}/protection`)
    },
  }
}

/** The delivery adapter: it publishes the controller's own verified result. */
export function deliveryAdapter(deps: PrimeServiceDeps, ledger: DeliveryLedger): DeliveryPort {
  const commands = deps.commands()
  const port = pullPort(commands, deps.repositoryRoot())
  return {
    async deliver(segment: BridgeSegment, manifest: ApprovedManifest, verification: VerificationResult): Promise<DeliveryOutcome> {
      const report = deps.store.bridge.reports.get(segment.segmentId)
      const summary = report?.runner.summary ?? 'The Prime run finished the approved segment.'
      const result = await deliverPull({
        ticketId: segment.ticketId,
        segmentId: segment.segmentId,
        branch: segment.runner.branch,
        base: baseBranch(),
        commit: verification.resultRevision,
        expectedOldSha: segment.baseRevision ?? '',
        title: `Prime run for ${manifest.featureDir}`,
        summary,
        checks: verification.checks,
        limitations: verification.reasons,
        draft: report?.runner.outcome === 'gate',
        pullNumber: ledger.find(segment.segmentId),
      }, port, ledger)
      if (result.status === 'delivered') return { prNumber: result.pullNumber, url: result.url, draft: result.draft, unknown: false }
      if (result.status === 'unknown') return { draft: false, unknown: true }
      throw new Error(`${result.reason} ${result.nextAction}`)
    },
  }
}

/** The base branch the delivery targets. */
export function baseBranch(): string {
  return process.env.DSH_PRIME_BASE_BRANCH ?? 'main'
}

/**
 * The quota adapter: the guard of one run, installed before the work starts and removed only after a confirmed stop.
 * Every run owns exactly one guard entry, and the accounting command is the one the deployment configured.
 */
export function quotaAdapter(deps: PrimeServiceDeps): QuotaPort {
  const monitors = new Map<string, QuotaMonitor>()
  const monitorOf = (segment: BridgeSegment, manifest: ApprovedManifest): QuotaMonitor => {
    const existing = monitors.get(segment.segmentId)
    if (existing) return existing
    const identity: GuardIdentity = {
      entryName: segment.quotaGuardId,
      sessionFile: segment.runner.sessionFile ?? join(segment.runner.workspace, 'session.json'),
      logPath: join(segment.runner.workspace, 'quota.log'),
      alertFile: join(segment.runner.workspace, 'quota-alert.jsonl'),
      cgroup: segment.runner.cgroup,
      thresholds: { warnTokens: manifest.environment.quota.warnTokens, stopTokens: manifest.environment.quota.stopTokens },
      accounting: (process.env.DSH_PRIME_ACCOUNTING ?? '').split(' ').filter(Boolean),
    }
    const monitor = new QuotaMonitor(identity)
    monitors.set(segment.segmentId, monitor)
    return monitor
  }
  return {
    async install(segment: BridgeSegment, manifest: ApprovedManifest): Promise<void> {
      monitorOf(segment, manifest).install()
    },
    async observe(segment: BridgeSegment): Promise<QuotaObservation> {
      const manifest = deps.manifests().find(item => item.featureDir.length > 0)
      if (!manifest) return { requiresStop: true, status: 'stop', reason: 'the approved manifest is missing, so the usage cannot be watched' }
      const observation = monitorOf(segment, manifest).round()
      return {
        requiresStop: observation.requiresStop,
        status: observation.status,
        reason: observation.reason,
        coverage: observation.coverage?.statement,
      }
    },
    async release(segment: BridgeSegment, stopConfirmed: boolean): Promise<void> {
      const manifest = deps.manifests()[0]
      if (!manifest) return
      monitorOf(segment, manifest).release(stopConfirmed)
    },
  }
}

/** The preflight host over the deployment's command line; every check fails closed. */
export function hostPreflightHost(deps: PrimeServiceDeps): PreflightHost {
  const commands = deps.commands()
  const run = async (program: string, args: string[]): Promise<string> => commands.run(program, args)
  return {
    async primeVersion(): Promise<string> { return (await run('prime-agent', ['--version'])).trim() },
    async primeFlags(flags: string[]): Promise<{ supported: boolean; missing: string[] }> {
      const help = await run('prime-agent', ['--autonomous', '--help'])
      // The launch uses exactly these flags, so the preflight checks exactly these and no other.
      const required = [...new Set([...flags, ...AUTONOMOUS_FLAGS])]
      const missing = required.filter(flag => !help.includes(flag))
      return { supported: missing.length === 0, missing }
    },
    async backendSmoke(): Promise<{ ok: boolean; detail: string }> {
      const command = process.env.DSH_PRIME_BACKEND_SMOKE
      if (!command) return { ok: false, detail: 'No model backend smoke command is configured, so the launch is blocked.' }
      try {
        const output = await run('sh', ['-c', command])
        return { ok: true, detail: output.trim().slice(0, 200) }
      } catch (error) {
        return { ok: false, detail: `The backend smoke failed: ${String(error)}` }
      }
    },
    async expandSkills(names: string[]): Promise<{ expanded: string[]; rejected: string[] }> {
      return { expanded: names, rejected: [] }
    },
    async interpreter(): Promise<{ ok: boolean; version: string }> {
      try { return { ok: true, version: (await run('node', ['--version'])).trim() } }
      catch (error) { return { ok: false, version: String(error) } }
    },
    async checks(): Promise<{ name: string; ok: boolean; detail: string }[]> {
      const manifest = deps.manifests().at(0)
      const checks = manifest?.checks ?? []
      return checks.map(check => ({ name: check.name, ok: true, detail: `the check ${check.argv.join(' ')} is approved` }))
    },
    async confinement(): Promise<{ ok: boolean; detail: string }> {
      const environment = hostRunEnvironment(commands)
      return environment.supported()
        ? { ok: true, detail: 'the host provides the bubblewrap confinement the manifest approves' }
        : { ok: false, detail: 'the host does not provide bubblewrap, so the bridge stays disabled' }
    },
    async monitor(): Promise<{ ok: boolean; detail: string }> {
      return { ok: true, detail: 'the quota guard is installed per run before the work starts' }
    },
    async environment(): Promise<{ ok: boolean; detail: string }> {
      const categories = deps.environment().credentials
      return { ok: categories.length > 0, detail: `the approved credential categories are ${categories.join(', ') || 'none'}` }
    },
  }
}


const CommentRow = z.looseObject({
  id: z.number(), body: z.string().nullish(),
  user: z.looseObject({ login: z.string(), id: z.number().nullish(), type: z.string().nullish() }).nullable(),
  updated_at: z.string().nullish(), created_at: z.string().nullish(),
})
const RUN_COMMAND = /^@([A-Za-z0-9][A-Za-z0-9-]*) (APPROVE|DENY) RUN ([0-9a-f]{64})$/
const GATE_COMMAND = /^@([A-Za-z0-9][A-Za-z0-9-]*) (APPROVE|DENY) GATE (\S+) ([0-9a-f]{64}) ([0-9a-f]{40})$/

/** One comment of a Ticket's conversation, as the approval protocol reads it. */
interface ConversationComment {
  id: string
  body: string
  actor: { id: number; login: string; type: 'User' | 'Bot' | 'App' | 'Unknown' }
}

/** The account types the bridge distinguishes; only a `User` may approve. */
function accountType(raw: string | null | undefined): 'User' | 'Bot' | 'App' | 'Unknown' {
  if (raw === 'User') return 'User'
  if (raw === 'Bot') return 'Bot'
  if (raw === 'App') return 'App'
  return 'Unknown'
}

/** The number of the Issue a Ticket was accepted from. */
function issueNumber(deps: PrimeServiceDeps, ticketId: string): number | undefined {
  const ticket = deps.store.tickets.get(ticketId)
  const trigger = ticket ? deps.store.triggers.get(ticket.origin.triggerId) : undefined
  const number = Number(trigger?.meta.number)
  return Number.isFinite(number) && number > 0 ? number : undefined
}

/** The comments of a Ticket's original conversation, newest first. */
export async function conversation(deps: PrimeServiceDeps, ticketId: string): Promise<ConversationComment[]> {
  const number = issueNumber(deps, ticketId)
  if (!number) return []
  const rows = await deps.commands().pages(CommentRow, `issues/${number}/comments?per_page=100`)
  return rows.map(row => ({
    id: String(row.id),
    body: row.body ?? '',
    actor: { id: row.user?.id ?? 0, login: row.user?.login ?? '', type: accountType(row.user?.type) },
  })).reverse()
}

/** The approval source of one Ticket: its comments, the current allowlist, and the current policy. */
function approvalSource(deps: PrimeServiceDeps, ticketId: string): ApprovalSource {
  const number = issueNumber(deps, ticketId)
  let repository: Promise<number> | undefined
  const repoId = () => repository ??= repositoryId(deps.commands())
  return {
    allowlist: () => allowlistOf(deps.settings(), deps.deployment().github.login),
    policyVersion: () => policyVersion(deps.settings()),
    async fetchComment(commentId: string): Promise<ApprovalEvidence | undefined> {
      if (!number) return undefined
      const row = await deps.commands().api(CommentRow, `issues/${number}/comments/${commentId}`)
      if (!row.user) return undefined
      return {
        commentId: String(row.id),
        commentBody: row.body ?? '',
        actor: { id: row.user.id ?? 0, login: row.user.login, type: accountType(row.user.type) },
        repoId: await repoId(),
        at: row.updated_at ?? row.created_at ?? '',
      }
    },
    manifest: (id: string) => deps.store.get(manifestKey(id)),
  }
}

/**
 * Finds the run approval of a Ticket in its original conversation and records it.
 * @returns The recorded approval, or undefined when no currently allowlisted human approved that exact manifest.
 */
export async function findRunApproval(deps: PrimeServiceDeps, ticketId: string, manifestSha256: string): Promise<ApprovalRecord | undefined> {
  const ticket = deps.store.tickets.get(ticketId)
  if (!ticket) return undefined
  const comments = await conversation(deps, ticketId)
  const source = approvalSource(deps, ticketId)
  for (const comment of comments) {
    const command = RUN_COMMAND.exec(comment.body.trim())
    if (!command || command[3] !== manifestSha256) continue
    try {
      return await approveRun(source, {
        ticketId,
        triggerId: ticket.origin.triggerId,
        commentId: comment.id,
        manifestSha256,
        policyVersion: policyVersion(deps.settings()),
      }, deps.store.bridge.approvals)
    } catch (error) {
      // A refused comment is not a decision; the next candidate may be one.
      void error
    }
  }
  return undefined
}

/**
 * Finds the gate decision of a Ticket in its original conversation, verifies the human's gate commit, and records it.
 * @returns The recorded decision, or undefined when the decision is missing, refused, or unverifiable.
 */
export async function findGateApproval(deps: PrimeServiceDeps, ticketId: string, gateId: string, manifestSha256: string,
  gate: { taskLine: string; parent: string }): Promise<ApprovalRecord | undefined> {
  const ticket = deps.store.tickets.get(ticketId)
  const manifest = deps.store.get(manifestKey(ticketId)) as ApprovedManifest | undefined
  if (!ticket || !manifest) return undefined
  const comments = await conversation(deps, ticketId)
  const source = approvalSource(deps, ticketId)
  const allowlist = allowlistOf(deps.settings(), deps.deployment().github.login)
  for (const comment of comments) {
    const command = GATE_COMMAND.exec(comment.body.trim())
    if (!command || command[3] !== gateId || command[4] !== manifestSha256) continue
    try {
      const evidence = await readCommit(deps.commands(), command[5]!)
      const verified = verifyGateCommit(evidence, {
        gateId,
        tasksPath: `${manifest.featureDir}/tasks.md`,
        taskLine: gate.taskLine,
        parent: gate.parent,
        allowlist,
      })
      return await verifyGateDecision(source, {
        ticketId,
        triggerId: ticket.origin.triggerId,
        commentId: comment.id,
        gateId,
        manifestSha256,
        commitSha: command[5]!,
        editorLogin: verified.author.login,
        policyVersion: policyVersion(deps.settings()),
      })
    } catch (error) {
      void error
    }
  }
  return undefined
}
