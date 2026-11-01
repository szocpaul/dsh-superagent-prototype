import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { pathsFromPlan } from '../src/executor/prime-manifest.ts'

describe('the writable scope a plan proposes', () => {
  it('reads the source tree, not the documentation tree', () => {
    const plan = [
      '# Implementation Plan',
      '',
      '## Project Structure',
      '',
      '### Documentation (this feature)',
      '',
      '```text',
      'specs/001-example/',
      '\u251c\u2500\u2500 spec.md',
      '\u2514\u2500\u2500 tasks.md',
      '```',
      '',
      '### Source Code (repository root)',
      '',
      '```text',
      'src/app.ts',
      'src/util.ts',
      'tests/app.spec.ts',
      '```',
    ].join('\n')
    expect(pathsFromPlan(plan)).toEqual(['src/app.ts', 'src/util.ts', 'tests/app.spec.ts'])
  })

  it('falls back to every block when the plan has no source heading', () => {
    const plan = ['```text', 'src/thing.ts', '```'].join('\n')
    expect(pathsFromPlan(plan)).toEqual(['src/thing.ts'])
  })

  it('proposes a scope for the bridge own plan', () => {
    const plan = readFileSync('specs/001-prime-runner-bridge/plan.md', 'utf8')
    expect(pathsFromPlan(plan).length).toBeGreaterThan(0)
  })

  it('proposes a scope for the disposable fixture plan', () => {
    const plan = readFileSync('specs/002-smoke-fixture/plan.md', 'utf8')
    expect(pathsFromPlan(plan)).toEqual(['src/smoke.ts', 'tests/smoke.spec.ts'])
  })
})
