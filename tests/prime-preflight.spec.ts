import { describe, expect, it } from 'vitest'
import { digest } from '../src/executor/prime-manifest.ts'
import type { ApprovedManifest } from '../src/executor/prime-model.ts'
import {
  checkPlan,
  flagSupport,
  preflight,
  preflightEvidence,
  requiredSkills,
  toolExpansion,
  REQUIRED_AUTONOMOUS_FLAGS,
  type PreflightHost,
} from '../src/executor/prime-preflight.ts'

/** A manifest for the happy path: one automated task, one approved check, and no skill in the task text. */
function manifest(overrides: Partial<ApprovedManifest> = {}): ApprovedManifest {
  const environment = {
    deploymentId: 'deployment-fixture',
    runner: { cli: 'prime-agent', version: '0.10.1' },
    model: { provider: 'fixture', id: 'fixture-model' },
    isolation: { backend: 'bubblewrap' as const, writablePaths: ['specs/001-fixture'], network: 'none' as const, allowedEndpoints: [] },
    credentials: ['model-api'],
    quota: { warnTokens: 1000, stopTokens: 2000, maxWallMs: 600000, meteringScope: 'session' },
  }
  const value = {
    schemaVersion: 1 as const,
    repository: { id: 4242, fullName: 'example/fixture' },
    featureDir: 'specs/001-fixture',
    baselineCommit: 'a'.repeat(40),
    artifacts: {
      specSha256: 'b'.repeat(64), planSha256: 'c'.repeat(64), tasksSha256: 'd'.repeat(64),
      constitutionSha256: null, guidanceSha256: 'e'.repeat(64), hooksSha256: 'f'.repeat(64), treeSha256: '0'.repeat(64),
    },
    allowedPaths: ['specs/001-fixture'],
    tasks: [{ id: 'T001', kind: 'automated' as const, order: 0, text: 'Implement the fixture task' }],
    checks: [{ name: 'fixture-check', argv: ['pnpm', 'test'], cwd: '.', timeoutMs: 60000 }],
    environment: { ...environment, digest: '' },
    ...overrides,
  }
  return { ...value, environment: { ...environment, digest: digest(environment as never) } } as unknown as ApprovedManifest
}

/** A host whose every check passes, so a test can replace exactly one of them. */
function host(overrides: Partial<PreflightHost> = {}): PreflightHost {
  return {
    primeVersion: async () => '0.10.1',
    primeFlags: async () => ({ supported: true, missing: [] }),
    backendSmoke: async () => ({ ok: true, detail: 'the model backend answered' }),
    expandSkills: async () => ({ expanded: [], rejected: [] }),
    interpreter: async () => ({ ok: true, version: '3.14.4' }),
    checks: async () => [{ name: 'fixture-check', ok: true, detail: 'passed' }],
    confinement: async () => ({ ok: true, detail: 'bubblewrap contained the runner' }),
    monitor: async () => ({ ok: true, detail: 'the quota guard is registered' }),
    environment: async () => ({ ok: true, detail: 'the model-api credential category is available' }),
    ...overrides,
  }
}

describe('preflight', () => {
  it('is ready when every check passes and records the evidence', async () => {
    const verdict = await preflight(manifest(), host())
    expect(verdict.status).toBe('ready')
    expect(verdict.failures).toEqual([])
    const evidence = preflightEvidence(verdict)
    expect(evidence.cliVersion).toBe('0.10.1')
    expect(evidence.flags.supported).toBe(true)
    expect(evidence.flags.confirmed).toContain('--autonomous')
    expect(evidence.interpreter.version).toBe('3.14.4')
    expect(evidence.checks).toEqual([{ name: 'fixture-check', ok: true, detail: 'passed' }])
    expect(evidence.confinement.ok).toBe(true)
    expect(evidence.monitor.ok).toBe(true)
  })

  it('leaves the manifest untouched, so the preflight is not a destructive step', async () => {
    const value = manifest()
    const before = structuredClone(value)
    await preflight(value, host())
    expect(value).toEqual(before)
  })

  it('blocks when the installed CLI version differs from the approved one', async () => {
    const verdict = await preflight(manifest(), host({ primeVersion: async () => '0.11.0' }))
    expect(verdict.status).toBe('blocked')
    expect(verdict.failures[0]?.check).toBe('cli-version')
    expect(verdict.failures[0]?.detail).toContain('0.11.0')
    expect(verdict.failures[0]?.nextAction).toBeTruthy()
  })

  it('blocks when a flag the launch needs is not supported', async () => {
    const verdict = await preflight(manifest(), host({ primeFlags: async () => ({ supported: true, missing: ['--autonomous-max-tokens'] }) }))
    expect(verdict.status).toBe('blocked')
    expect(verdict.failures[0]?.check).toBe('cli-flags')
    expect(verdict.failures[0]?.detail).toContain('--autonomous-max-tokens')
    expect(verdict.failures[0]?.nextAction).toBeTruthy()
  })

  it('blocks when the backend smoke call fails', async () => {
    const verdict = await preflight(manifest(), host({ backendSmoke: async () => ({ ok: false, detail: 'the model backend refused the credential' }) }))
    expect(verdict.status).toBe('blocked')
    expect(verdict.failures[0]?.check).toBe('backend-smoke')
    expect(verdict.failures[0]?.detail).toContain('refused')
  })

  it('blocks when the interpreter is missing', async () => {
    const verdict = await preflight(manifest(), host({ interpreter: async () => ({ ok: false, version: '' }) }))
    expect(verdict.status).toBe('blocked')
    expect(verdict.failures[0]?.check).toBe('interpreter')
  })

  it('blocks when an approved check fails and names the check', async () => {
    const verdict = await preflight(manifest(), host({ checks: async () => [{ name: 'fixture-check', ok: false, detail: 'exit code 1' }] }))
    expect(verdict.status).toBe('blocked')
    expect(verdict.failures[0]?.check).toBe('checks')
    expect(verdict.failures[0]?.detail).toContain('fixture-check')
  })

  it('blocks when an approved check is missing from the run', async () => {
    const verdict = await preflight(manifest(), host({ checks: async () => [] }))
    expect(verdict.status).toBe('blocked')
    expect(verdict.failures[0]?.check).toBe('checks')
    expect(verdict.failures[0]?.detail).toContain('fixture-check')
  })

  it('blocks when the host runs a check the manifest does not approve', async () => {
    const verdict = await preflight(manifest(), host({ checks: async () => [
      { name: 'fixture-check', ok: true, detail: 'passed' },
      { name: 'other-check', ok: true, detail: 'passed' },
    ] }))
    expect(verdict.status).toBe('blocked')
    expect(verdict.failures[0]?.detail).toContain('other-check')
  })

  it('blocks when the confinement probe fails', async () => {
    const verdict = await preflight(manifest(), host({ confinement: async () => ({ ok: false, detail: 'the runner could write outside the workspace' }) }))
    expect(verdict.status).toBe('blocked')
    expect(verdict.failures[0]?.check).toBe('confinement')
    expect(verdict.failures[0]?.detail).toContain('outside the workspace')
  })

  it('blocks when the quota monitor is not registered', async () => {
    const verdict = await preflight(manifest(), host({ monitor: async () => ({ ok: false, detail: 'the guard cron entry is missing' }) }))
    expect(verdict.status).toBe('blocked')
    expect(verdict.failures[0]?.check).toBe('monitor')
  })

  it('blocks when the approved credential categories are not available', async () => {
    const verdict = await preflight(manifest(), host({ environment: async () => ({ ok: false, detail: 'the model-api credential category is missing' }) }))
    expect(verdict.status).toBe('blocked')
    expect(verdict.failures[0]?.check).toBe('environment')
  })

  it('blocks when the host cannot answer at all, instead of assuming success', async () => {
    const verdict = await preflight(manifest(), host({ primeVersion: async () => { throw new Error('the CLI is not installed') } }))
    expect(verdict.status).toBe('blocked')
    expect(verdict.failures[0]?.check).toBe('cli-version')
    expect(verdict.failures[0]?.detail).toContain('the CLI is not installed')
  })

  it('blocks when a skill writes outside the approved scope, instead of running it', async () => {
    const value = manifest({
      tasks: [{ id: 'T001', kind: 'automated', order: 0, text: 'Run /skill:speckit-implement for the feature' }],
    })
    const verdict = await preflight(value, host({ expandSkills: async () => ({ expanded: ['speckit-implement'], rejected: [] }) }))
    expect(verdict.status).toBe('blocked')
    expect(verdict.failures[0]?.check).toBe('skill-expansion')
    expect(verdict.failures[0]?.detail).toContain('.gitignore')
  })

  it('blocks when a skill is not part of the approved skill set', async () => {
    const value = manifest({
      tasks: [{ id: 'T001', kind: 'automated', order: 0, text: 'Run /skill:unknown-skill for the feature' }],
    })
    const verdict = await preflight(value, host({ expandSkills: async () => ({ expanded: ['unknown-skill'], rejected: [] }) }))
    expect(verdict.status).toBe('blocked')
    expect(verdict.failures[0]?.check).toBe('skill-expansion')
    expect(verdict.failures[0]?.detail).toContain('unknown-skill')
  })

  it('blocks when a skill does not expand', async () => {
    const value = manifest({
      tasks: [{ id: 'T001', kind: 'automated', order: 0, text: 'Run /skill:speckit-converge for the feature' }],
    })
    const verdict = await preflight(value, host({ expandSkills: async () => ({ expanded: [], rejected: ['speckit-converge'] }) }))
    expect(verdict.status).toBe('blocked')
    expect(verdict.failures[0]?.check).toBe('skill-expansion')
    expect(verdict.failures[0]?.detail).toContain('speckit-converge')
  })

  it('reports every failed prerequisite in the order the checks ran', async () => {
    const verdict = await preflight(manifest(), host({
      backendSmoke: async () => ({ ok: false, detail: 'the backend refused the credential' }),
      confinement: async () => ({ ok: false, detail: 'the runner could write outside the workspace' }),
      monitor: async () => ({ ok: false, detail: 'the guard cron entry is missing' }),
    }))
    expect(verdict.status).toBe('blocked')
    expect(verdict.failures.map(item => item.check)).toEqual(['backend-smoke', 'confinement', 'monitor'])
  })

  it('never lets a failed check pass as a warning', async () => {
    const verdict = await preflight(manifest(), host({ interpreter: async () => ({ ok: false, version: '' }) }))
    expect(verdict.status).not.toBe('ready')
    expect(preflightEvidence(verdict).failures.length).toBeGreaterThan(0)
  })

  it('keeps no secret value in the evidence', async () => {
    const verdict = await preflight(manifest(), host({
      backendSmoke: async () => ({ ok: true, detail: 'the model backend answered with sk-live-SECRETVALUE0123' }),
      environment: async () => ({ ok: true, detail: 'token=topsecretvalue used for model-api' }),
    }))
    const evidence = preflightEvidence(verdict)
    const text = JSON.stringify(evidence)
    expect(text).not.toContain('SECRETVALUE0123')
    expect(text).not.toContain('topsecretvalue')
    expect(evidence.environment.credentialCategories).toEqual(['model-api'])
  })
})

describe('check plan', () => {
  it('lists the checks in order and says what a failure means', () => {
    const plan = checkPlan(manifest())
    expect(plan.map(item => item.name)).toEqual([
      'cli-version', 'cli-flags', 'backend-smoke', 'skill-expansion', 'interpreter', 'checks', 'confinement', 'monitor', 'environment',
    ])
    for (const item of plan) {
      expect(item.failureMeans).toBeTruthy()
      expect(item.nextAction).toBeTruthy()
    }
    expect(plan.find(item => item.name === 'checks')?.subjects).toEqual(['fixture-check'])
  })

  it('names the skills the approved tasks use', () => {
    const value = manifest({
      tasks: [{ id: 'T001', kind: 'automated', order: 0, text: 'Run /skill:speckit-implement and /skill:speckit-converge' }],
    })
    expect(checkPlan(value).find(item => item.name === 'skill-expansion')?.subjects).toEqual(['speckit-converge', 'speckit-implement'])
    expect(requiredSkills(value)).toEqual(['speckit-converge', 'speckit-implement'])
  })
})

describe('pure helpers', () => {
  it('reports the flags the installed CLI does not support', () => {
    const support = flagSupport(REQUIRED_AUTONOMOUS_FLAGS, { supported: true, missing: ['--goal'] })
    expect(support.supported).toBe(false)
    expect(support.missing).toEqual(['--goal'])
    expect(support.confirmed).toContain('--autonomous')
    expect(support.confirmed).not.toContain('--goal')
    expect(flagSupport(REQUIRED_AUTONOMOUS_FLAGS, { supported: true, missing: [] }).supported).toBe(true)
  })

  it('expands a known skill and separates the approved writes from the rest', () => {
    const value = manifest({
      tasks: [{ id: 'T001', kind: 'automated', order: 0, text: 'Run /skill:speckit-implement' }],
    })
    const expansion = toolExpansion('speckit-implement', value)
    expect(expansion.known).toBe(true)
    expect(expansion.writes).toContain('specs/001-fixture/tasks.md')
    expect(expansion.approvedWrites).toContain('specs/001-fixture/tasks.md')
    expect(expansion.unapprovedWrites).toContain('.gitignore')
    expect(toolExpansion('unknown-skill', value).known).toBe(false)
  })

  it('treats an unpinned hook configuration as an unapproved hook', () => {
    const value = manifest({
      tasks: [{ id: 'T001', kind: 'automated', order: 0, text: 'Run /skill:speckit-implement' }],
    }) as ApprovedManifest & { artifacts: { hooksSha256: string | null } }
    value.artifacts.hooksSha256 = null
    const expansion = toolExpansion('speckit-implement', value)
    expect(expansion.unapprovedHooks.length).toBeGreaterThan(0)
  })
})
