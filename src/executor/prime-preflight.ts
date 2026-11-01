/**
 * The preflight of one Prime Runner Bridge run: every check that must succeed before a runner may start.
 * The checks live behind the PreflightHost port, so the tests need no real CLI, backend, or network, and the
 * preflight fails closed: a failed check blocks the launch and a check the manifest does not approve blocks it too.
 */
import type { ApprovedManifest } from './prime-model.ts'

/** The host operations the preflight needs; every check has its own seam, so no real CLI or backend is required in tests. */
export interface PreflightHost {
  /** The version the installed CLI reports. */
  primeVersion(): Promise<string>
  /** Whether the installed CLI supports the given flags, read from its real `--help` output. */
  primeFlags(flags: string[]): Promise<{ supported: boolean; missing: string[] }>
  /** A minimal real call that proves the backend and the credential work. */
  backendSmoke(): Promise<{ ok: boolean; detail: string }>
  /** The skill expansion, run in an isolated cheap test. */
  expandSkills(names: string[]): Promise<{ expanded: string[]; rejected: string[] }>
  /** The interpreter the runner uses, with its version. */
  interpreter(): Promise<{ ok: boolean; version: string }>
  /** The availability of every approved check. */
  checks(): Promise<{ name: string; ok: boolean; detail: string }[]>
  /** The isolation probe that proves the runner cannot write outside the approved paths. */
  confinement(): Promise<{ ok: boolean; detail: string }>
  /** The registration of the quota monitor. */
  monitor(): Promise<{ ok: boolean; detail: string }>
  /** The credential categories the manifest approves. */
  environment(): Promise<{ ok: boolean; detail: string }>
}

/** One failed prerequisite, with the action an operator must take. */
export interface PreflightFailure {
  /** The name of the failed check. */
  check: string
  /** What the check reported. */
  detail: string
  /** The one action that clears the failure. */
  nextAction: string
}

/** What the preflight observed, before the evidence record is built. */
export interface PreflightCollected {
  /** The version the installed CLI reported. */
  cliVersion: string
  /** The flags the installed CLI confirmed and the ones it lacks. */
  flags: FlagSupport
  /** The skills the approved tasks name and what happened to them. */
  skills: { required: string[]; expanded: string[]; rejected: string[]; unapprovedWrites: string[] }
  /** The interpreter the runner would use. */
  interpreter: { ok: boolean; version: string }
  /** The checks the host reported. */
  checks: { name: string; ok: boolean; detail: string }[]
  /** The isolation probe result. */
  confinement: { ok: boolean; detail: string }
  /** The quota monitor result. */
  monitor: { ok: boolean; detail: string }
  /** The credential check result. */
  environment: { ok: boolean; detail: string }
  /** The credential categories the manifest approves; never a credential value. */
  credentialCategories: string[]
}

/** The verdict of a preflight: ready to launch, or blocked with the ordered failures. */
export interface PreflightVerdict {
  /** `ready` when no check failed, `blocked` otherwise. */
  status: 'ready' | 'blocked'
  /** The failures in the order the checks ran. */
  failures: PreflightFailure[]
  /** What the preflight observed. */
  collected: PreflightCollected
}

/** The durable evidence record of one preflight; it holds no secret value. */
export interface PreflightEvidence {
  schemaVersion: 1
  /** The version of the installed CLI. */
  cliVersion: string
  /** The flags the installed CLI confirmed, and the ones it lacks. */
  flags: { supported: boolean; confirmed: string[]; missing: string[] }
  /** The skill expansion result. */
  skills: { required: string[]; expanded: string[]; rejected: string[]; unapprovedWrites: string[] }
  /** The interpreter version. */
  interpreter: { ok: boolean; version: string }
  /** The check results. */
  checks: { name: string; ok: boolean; detail: string }[]
  /** The confinement result. */
  confinement: { ok: boolean; detail: string }
  /** The quota monitor result. */
  monitor: { ok: boolean; detail: string }
  /** The credential categories the manifest approves, never a value. */
  environment: { ok: boolean; credentialCategories: string[] }
  /** The failures, empty when the preflight was ready. */
  failures: { check: string; detail: string; nextAction: string }[]
}

/** One item of the plan the coordinator shows the operator. */
export interface CheckPlanItem {
  /** The name of the check. */
  name: string
  /** What the check verifies. */
  requirement: string
  /** What a failure means for the run. */
  failureMeans: string
  /** The action that clears the failure. */
  nextAction: string
  /** What the check covers, such as the approved check names. */
  subjects: string[]
}

/** Which flags the installed CLI supports. */
export interface FlagSupport {
  /** Whether every required flag is supported. */
  supported: boolean
  /** The required flags the CLI confirmed. */
  confirmed: string[]
  /** The flags the CLI does not support. */
  missing: string[]
}

/** The files and hooks an installed Spec Kit skill creates or runs. */
export interface SkillSideEffects {
  /** Repository-relative paths the skill creates or changes; `{featureDir}` is the approved feature directory. */
  writes: string[]
  /** The scripts the skill runs. */
  hooks: string[]
}

/** The side effects of the installed skills the bridge knows; a skill outside this set is not approved. */
export const SKILL_SIDE_EFFECTS: Record<string, SkillSideEffects> = {
  'speckit-implement': {
    writes: ['{featureDir}/tasks.md', '.gitignore', '.npmignore', '.dockerignore'],
    hooks: ['.specify/scripts/bash/check-prerequisites.sh', '.specify/scripts/bash/setup-plan.sh', '.specify/scripts/bash/setup-tasks.sh'],
  },
  'speckit-converge': { writes: ['{featureDir}/tasks.md'], hooks: [] },
  'speckit-tasks': { writes: ['{featureDir}/tasks.md'], hooks: ['.specify/scripts/bash/setup-tasks.sh'] },
}

/** The flags a `prime-agent --autonomous` launch needs; a missing one blocks the launch. */
export const REQUIRED_AUTONOMOUS_FLAGS = [
  '--autonomous',
  '--autonomous-gate',
  '--autonomous-gate-retries',
  '--autonomous-max-turns',
  '--autonomous-max-continuations',
  '--autonomous-max-tokens',
  '--autonomous-timeout-ms',
  '--goal',
]

/** The result of expanding one skill against the approved manifest. */
export interface ToolExpansion {
  /** The skill name. */
  skill: string
  /** Whether the skill is part of the approved skill set. */
  known: boolean
  /** The paths the skill creates or changes. */
  writes: string[]
  /** The paths the manifest approves. */
  approvedWrites: string[]
  /** The paths the manifest does not approve; they block the run. */
  unapprovedWrites: string[]
  /** The scripts the skill runs. */
  hooks: string[]
  /** The scripts the manifest does not pin; they block the run. */
  unapprovedHooks: string[]
}

/** Reports which required flags the installed CLI does not support. */
export function flagSupport(required: string[], reported: { supported: boolean; missing: string[] }): FlagSupport {
  const missing = [...new Set(reported.missing)]
  const confirmed = required.filter(flag => !missing.includes(flag))
  return { supported: reported.supported && missing.length === 0, confirmed, missing }
}

/** The skills the approved tasks name, in a stable order. */
export function requiredSkills(manifest: ApprovedManifest): string[] {
  const names = new Set<string>()
  for (const task of manifest.tasks) {
    for (const match of task.text.matchAll(/\bskill:([A-Za-z0-9._-]+)/g)) names.add(match[1]!)
  }
  return [...names].sort()
}

/** Reports whether an approved path covers a file the skill would write. */
function covers(entry: string, path: string): boolean {
  if (entry === path) return true
  return path.startsWith(entry.endsWith('/') ? entry : `${entry}/`)
}

/**
 * Expands one skill against the approved manifest.
 * A write the manifest does not name and a hook the manifest does not pin are reported as unapproved, so the run
 * blocks instead of writing outside the approved scope.
 */
export function toolExpansion(skill: string, manifest: ApprovedManifest): ToolExpansion {
  const effects = SKILL_SIDE_EFFECTS[skill]
  if (!effects) {
    return { skill, known: false, writes: [], approvedWrites: [], unapprovedWrites: [], hooks: [], unapprovedHooks: [] }
  }
  const writes = effects.writes.map(path => path.replace('{featureDir}', manifest.featureDir))
  const approvedWrites = writes.filter(path => manifest.allowedPaths.some(entry => covers(entry, path)))
  const unapprovedWrites = writes.filter(path => !approvedWrites.includes(path))
  const hooks = [...effects.hooks]
  const unapprovedHooks = manifest.artifacts.hooksSha256 ? [] : hooks
  return { skill, known: true, writes, approvedWrites, unapprovedWrites, hooks, unapprovedHooks }
}

/** Removes the values that look like secrets from a free-text detail, so the evidence never holds one. */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, '$1-***')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{8,}/g, 'gh*_***')
    .replace(/\bBearer\s+[A-Za-z0-9._-]{8,}/g, 'Bearer ***')
    .replace(/\b(api[_-]?key|apikey|token|secret|password)\b(\s*[=:]\s*)("?)[^\s",;]+/gi, '$1$2***')
}

/** Builds one failure record. */
function failure(check: string, detail: string, nextAction: string): PreflightFailure {
  return { check, detail, nextAction }
}

/**
 * Runs every preflight check against the host.
 * The checks run in a fixed order and every failure is recorded, so the operator sees all the blockers at once.
 */
export async function preflight(manifest: ApprovedManifest, host: PreflightHost): Promise<PreflightVerdict> {
  const failures: PreflightFailure[] = []
  const collected: PreflightCollected = {
    cliVersion: '',
    flags: { supported: false, confirmed: [], missing: [] },
    skills: { required: requiredSkills(manifest), expanded: [], rejected: [], unapprovedWrites: [] },
    interpreter: { ok: false, version: '' },
    checks: [],
    confinement: { ok: false, detail: '' },
    monitor: { ok: false, detail: '' },
    environment: { ok: false, detail: '' },
    credentialCategories: [...manifest.environment.credentials],
  }

  try {
    const version = await host.primeVersion()
    collected.cliVersion = version
    if (!version.trim()) {
      failures.push(failure('cli-version', 'the installed CLI reported no version', 'Install the approved CLI and rerun the preflight'))
    } else if (version !== manifest.environment.runner.version) {
      failures.push(failure('cli-version',
        `the installed CLI version ${version} differs from the approved ${manifest.environment.runner.version}`,
        'Approve a new manifest for the installed CLI version'))
    }
  } catch (error) {
    failures.push(failure('cli-version', `the CLI version could not be read: ${error instanceof Error ? error.message : String(error)}`,
      'Make the approved CLI available and rerun the preflight'))
  }

  try {
    const reported = await host.primeFlags(REQUIRED_AUTONOMOUS_FLAGS)
    collected.flags = flagSupport(REQUIRED_AUTONOMOUS_FLAGS, reported)
    if (!collected.flags.supported) {
      const missing = collected.flags.missing.length ? collected.flags.missing.join(', ') : 'the required options'
      failures.push(failure('cli-flags', `the installed CLI does not support ${missing}`,
        'Upgrade the CLI to a version that supports every required option'))
    }
  } catch (error) {
    failures.push(failure('cli-flags', `the CLI options could not be read: ${error instanceof Error ? error.message : String(error)}`,
      'Make the approved CLI available and rerun the preflight'))
  }

  try {
    const smoke = await host.backendSmoke()
    if (!smoke.ok) {
      failures.push(failure('backend-smoke', `the backend smoke call failed: ${smoke.detail}`,
        'Fix the backend or its credential and rerun the preflight'))
    }
  } catch (error) {
    failures.push(failure('backend-smoke', `the backend smoke call could not be made: ${error instanceof Error ? error.message : String(error)}`,
      'Make the backend reachable and rerun the preflight'))
  }

  for (const skill of collected.skills.required) {
    const expansion = toolExpansion(skill, manifest)
    if (!expansion.known) {
      failures.push(failure('skill-expansion', `the skill "${skill}" is not part of the approved skill set`,
        'Approve the skill in the manifest or remove it from the approved task'))
      continue
    }
    if (expansion.unapprovedWrites.length) {
      collected.skills.unapprovedWrites.push(...expansion.unapprovedWrites)
      failures.push(failure('skill-expansion',
        `the skill "${skill}" writes ${expansion.unapprovedWrites.join(', ')}, which the manifest does not approve`,
        'Add the files to the approved paths or remove the skill from the approved task'))
    }
    if (expansion.unapprovedHooks.length) {
      failures.push(failure('skill-expansion',
        `the skill "${skill}" runs hooks the manifest does not pin: ${expansion.unapprovedHooks.join(', ')}`,
        'Pin the hook configuration in the manifest or remove the skill from the approved task'))
    }
  }

  try {
    const expansion = await host.expandSkills(collected.skills.required)
    collected.skills.expanded = [...expansion.expanded]
    collected.skills.rejected = [...expansion.rejected]
    for (const skill of expansion.rejected) {
      failures.push(failure('skill-expansion', `the skill "${skill}" did not expand`,
        'Fix the skill installation and rerun the preflight'))
    }
    for (const skill of collected.skills.required) {
      if (!expansion.expanded.includes(skill) && !expansion.rejected.includes(skill)) {
        failures.push(failure('skill-expansion', `the skill "${skill}" was neither expanded nor rejected`,
          'Fix the skill installation and rerun the preflight'))
      }
    }
  } catch (error) {
    failures.push(failure('skill-expansion', `the skill expansion could not be run: ${error instanceof Error ? error.message : String(error)}`,
      'Fix the skill installation and rerun the preflight'))
  }

  try {
    const interpreter = await host.interpreter()
    collected.interpreter = { ok: interpreter.ok, version: interpreter.version }
    if (!interpreter.ok) {
      failures.push(failure('interpreter', 'the interpreter the runner needs is not available',
        'Provide the interpreter and its absolute path and rerun the preflight'))
    }
  } catch (error) {
    failures.push(failure('interpreter', `the interpreter could not be checked: ${error instanceof Error ? error.message : String(error)}`,
      'Provide the interpreter and rerun the preflight'))
  }

  try {
    const reported = await host.checks()
    collected.checks = reported.map(check => ({ name: check.name, ok: check.ok, detail: check.detail }))
    for (const approved of manifest.checks) {
      const found = reported.find(check => check.name === approved.name)
      if (!found) {
        failures.push(failure('checks', `the approved check "${approved.name}" was not run`,
          'Make the check runnable and rerun the preflight'))
      } else if (!found.ok) {
        failures.push(failure('checks', `the approved check "${approved.name}" failed: ${found.detail}`,
          'Fix the failing check before the run'))
      }
    }
    for (const check of reported) {
      if (!manifest.checks.some(approved => approved.name === check.name)) {
        failures.push(failure('checks', `the check "${check.name}" is not approved by the manifest`,
          'Approve the check in the manifest or stop running it'))
      }
    }
  } catch (error) {
    failures.push(failure('checks', `the approved checks could not be run: ${error instanceof Error ? error.message : String(error)}`,
      'Make the checks runnable and rerun the preflight'))
  }

  try {
    const confinement = await host.confinement()
    collected.confinement = { ok: confinement.ok, detail: confinement.detail }
    if (!confinement.ok) {
      failures.push(failure('confinement', `the isolation probe failed: ${confinement.detail}`,
        'Provide a working isolation backend or keep the bridge disabled'))
    }
  } catch (error) {
    failures.push(failure('confinement', `the isolation probe could not be run: ${error instanceof Error ? error.message : String(error)}`,
      'Provide a working isolation backend and rerun the preflight'))
  }

  try {
    const monitor = await host.monitor()
    collected.monitor = { ok: monitor.ok, detail: monitor.detail }
    if (!monitor.ok) {
      failures.push(failure('monitor', `the quota monitor is not registered: ${monitor.detail}`,
        'Register the run-owned quota guard before the run'))
    }
  } catch (error) {
    failures.push(failure('monitor', `the quota monitor could not be registered: ${error instanceof Error ? error.message : String(error)}`,
      'Register the run-owned quota guard before the run'))
  }

  try {
    const environment = await host.environment()
    collected.environment = { ok: environment.ok, detail: environment.detail }
    if (!environment.ok) {
      failures.push(failure('environment', `the approved credential categories are not available: ${environment.detail}`,
        'Provide the approved credential categories or approve a different environment'))
    }
  } catch (error) {
    failures.push(failure('environment', `the environment could not be checked: ${error instanceof Error ? error.message : String(error)}`,
      'Provide the approved environment and rerun the preflight'))
  }

  return { status: failures.length ? 'blocked' : 'ready', failures, collected }
}

/** The ordered list of checks the manifest requires, with what a failure of each one means. */
export function checkPlan(manifest: ApprovedManifest): CheckPlanItem[] {
  const skills = requiredSkills(manifest)
  return [
    {
      name: 'cli-version',
      requirement: `The installed CLI reports the approved version ${manifest.environment.runner.version}.`,
      failureMeans: 'The runner would run a CLI the operator did not approve.',
      nextAction: 'Approve a manifest for the installed CLI version.',
      subjects: [manifest.environment.runner.cli],
    },
    {
      name: 'cli-flags',
      requirement: 'The installed CLI supports every option the autonomous launch needs.',
      failureMeans: 'The launch command would fail or would guess an equivalent option.',
      nextAction: 'Upgrade the CLI to a version that supports every required option.',
      subjects: [...REQUIRED_AUTONOMOUS_FLAGS],
    },
    {
      name: 'backend-smoke',
      requirement: 'A minimal real call proves the model backend and its credential work.',
      failureMeans: 'The run would start without a working backend.',
      nextAction: 'Fix the backend or its credential and rerun the preflight.',
      subjects: [manifest.environment.model.provider, manifest.environment.model.id],
    },
    {
      name: 'skill-expansion',
      requirement: 'Every skill the approved tasks name expands, and its writes and hooks are approved.',
      failureMeans: 'The run would write outside the approved scope or run an unapproved command.',
      nextAction: 'Approve the writes and the hook configuration, or remove the skill from the approved task.',
      subjects: skills,
    },
    {
      name: 'interpreter',
      requirement: 'The interpreter the runner uses exists and reports its version.',
      failureMeans: 'The runner would start without the interpreter it needs.',
      nextAction: 'Provide the interpreter and its absolute path.',
      subjects: [],
    },
    {
      name: 'checks',
      requirement: 'Every approved check is available and passes.',
      failureMeans: 'The result could not be verified against the approved checks.',
      nextAction: 'Fix the failing or missing check and rerun the preflight.',
      subjects: manifest.checks.map(check => check.name),
    },
    {
      name: 'confinement',
      requirement: 'The isolation probe proves the runner cannot write outside the approved paths.',
      failureMeans: 'The run would have no enforced write boundary.',
      nextAction: 'Provide a working isolation backend or keep the bridge disabled.',
      subjects: manifest.environment.isolation.writablePaths,
    },
    {
      name: 'monitor',
      requirement: 'The run-owned quota monitor is registered before the work starts.',
      failureMeans: 'The run would have no external quota guard.',
      nextAction: 'Register the run-owned quota guard before the run.',
      subjects: [manifest.environment.quota.meteringScope],
    },
    {
      name: 'environment',
      requirement: 'The credential categories the manifest approves are available.',
      failureMeans: 'The run would start without the approved credentials.',
      nextAction: 'Provide the approved credential categories or approve a different environment.',
      subjects: [...manifest.environment.credentials],
    },
  ]
}

/** Builds the durable evidence record of a preflight; it holds no secret value. */
export function preflightEvidence(verdict: PreflightVerdict): PreflightEvidence {
  const collected = verdict.collected
  return {
    schemaVersion: 1,
    cliVersion: redactSecrets(collected.cliVersion),
    flags: {
      supported: collected.flags.supported,
      confirmed: [...collected.flags.confirmed],
      missing: [...collected.flags.missing],
    },
    skills: {
      required: [...collected.skills.required],
      expanded: [...collected.skills.expanded],
      rejected: [...collected.skills.rejected],
      unapprovedWrites: [...collected.skills.unapprovedWrites],
    },
    interpreter: { ok: collected.interpreter.ok, version: redactSecrets(collected.interpreter.version) },
    checks: collected.checks.map(check => ({ name: check.name, ok: check.ok, detail: redactSecrets(check.detail) })),
    confinement: { ok: collected.confinement.ok, detail: redactSecrets(collected.confinement.detail) },
    monitor: { ok: collected.monitor.ok, detail: redactSecrets(collected.monitor.detail) },
    environment: { ok: collected.environment.ok, credentialCategories: [...collected.credentialCategories] },
    failures: verdict.failures.map(item => ({
      check: item.check,
      detail: redactSecrets(item.detail),
      nextAction: item.nextAction,
    })),
  }
}
