import { describe, expect, it } from 'vitest'
import {
  ApprovalError, CheckError, DependencyError, DeliveryError, failureOf, failureReport, IsolationError, mapFailure,
  noticeText, PreflightError, ProviderError, QuotaError, redact, ReportError, StopError,
} from '../src/executor/prime-report.ts'
import type { FailureCause, FailureRecord, ReportedCheck } from '../src/executor/prime-model.ts'

/** One error of every cause the bridge can report. */
const errorOf = (cause: FailureCause): Error => ({
  preflight: new PreflightError('the git binary is missing', 'the preflight evidence', 'install git and approve a new launch'),
  provider: new ProviderError('the model backend refused the run', 'the provider log', 'restore the backend'),
  dependency: new DependencyError('the required tool is missing', 'the dependency list', 'provide the tool'),
  quota: new QuotaError('the metered limit stopped the run', 'the quota alert', 'raise the limit'),
  check: new CheckError('the build check failed', 'checks/build.log', 'fix the failing check'),
  report: new ReportError('the runner wrote no usable report', 'the run storage', 'recover the report'),
  isolation: new IsolationError('the isolation is unavailable', 'the isolation plan', 'repair the isolation'),
  approval: new ApprovalError('the approval no longer holds', 'the approval record', 'approve the manifest again'),
  stop: new StopError('the runner did not stop', 'the cgroup state', 'stop the runner manually'),
  delivery: new DeliveryError('the pull request could not be published', 'the delivery evidence', 'resolve the delivery'),
}[cause] as Error)

describe('the distinct failure causes', () => {
  it('gives every cause its own cause, summary and next action', () => {
    const causes: FailureCause[] = ['dependency', 'provider', 'quota', 'preflight', 'check', 'report']
    const mapped = causes.map(cause => ({ cause, record: failureOf(cause, 'the evidence', '') }))
    expect(mapped.map(item => item.record.cause)).toEqual(causes)
    expect(new Set(mapped.map(item => item.record.summary)).size).toBe(causes.length)
    expect(new Set(mapped.map(item => item.record.nextAction)).size).toBe(causes.length)
  })

  it('maps an error of each cause to that cause', () => {
    for (const cause of ['preflight', 'provider', 'dependency', 'quota', 'check', 'report', 'isolation', 'approval', 'stop', 'delivery'] as FailureCause[]) {
      const error = errorOf(cause)
      const record = mapFailure(error)
      expect(record.cause).toBe(cause)
      expect(record.nextAction.length).toBeGreaterThan(0)
    }
  })

  it('never reports an unknown error as a success', () => {
    const record = mapFailure(new Error('something broke'))
    expect(record.cause).toBe('report')
    expect(record.nextAction.length).toBeGreaterThan(0)
  })
})

describe('the report of a failed run', () => {
  it('names the cause, the check evidence, the quota coverage and the one next action', () => {
    const failure: FailureRecord = {
      cause: 'quota',
      summary: 'the metered limit stopped the run',
      evidence: 'the quota alert',
      nextAction: 'an operator must raise the metered limit',
      at: '2026-11-01T00:00:00.000Z',
    }
    const checks: ReportedCheck[] = [{ name: 'build', exitCode: 1, evidence: 'checks/build.log' }]
    const report = failureReport(failure, { checks, quotaCoverage: { statement: 'The guard measured the session file only.' } })
    expect(report.cause).toBe('quota')
    expect(report.checks).toEqual(checks)
    expect(report.quotaCoverage).toContain('session file')
    expect(report.nextAction).toBe('an operator must raise the metered limit')
    expect(report.text).toContain('quota')
    expect(report.text).toContain('checks/build.log')
    expect(report.text).toContain('session file')
  })

  it('keeps a secret out of the report, the notice and the message', () => {
    const failure: FailureRecord = {
      cause: 'provider',
      summary: 'the model backend refused the run',
      evidence: 'the key sk-abcdefgh12345678 was refused',
      nextAction: 'rotate the token=abcdefgh12345678 and approve a new launch',
      at: '2026-11-01T00:00:00.000Z',
    }
    const checks: ReportedCheck[] = [{ name: 'build', exitCode: 1, evidence: 'checks/build.log with api_key=supersecretvalue' }]
    const report = failureReport(failure, { checks })
    const notice = noticeText(failure)
    for (const text of [report.text, report.evidence, report.nextAction, notice]) {
      expect(text).not.toContain('abcdefgh12345678')
      expect(text).not.toContain('supersecretvalue')
      expect(text).toContain('***')
    }
  })
})

describe('the redaction', () => {
  it('removes the common secret shapes', () => {
    expect(redact('sk-abcdefgh12345678')).not.toContain('abcdefgh12345678')
    expect(redact('ghp_abcdefgh12345678')).not.toContain('abcdefgh12345678')
    expect(redact('Bearer abcdefgh.12345678')).not.toContain('abcdefgh.12345678')
    expect(redact('api_key=supersecretvalue')).not.toContain('supersecretvalue')
    expect(redact('password: hunter2hunter2')).not.toContain('hunter2hunter2')
  })

  it('keeps the ordinary text intact', () => {
    expect(redact('the build check failed in checks/build.log')).toBe('the build check failed in checks/build.log')
  })
})
