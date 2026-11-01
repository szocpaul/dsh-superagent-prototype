import { describe, expect, it } from 'vitest'
import { gateQuestion } from '../src/executor/prime-gate.ts'
import type { ApprovedManifest } from '../src/executor/prime-model.ts'
import type { TaskLine } from '../src/executor/prime-tasks.ts'

const gate: TaskLine = { id: 'T003', kind: 'human', order: 2, checked: false, line: 3, text: 'MANUAL GATE - review it', tags: [] }
const manifest = {
  environment: { deploymentId: 'superagent', runner: { cli: 'prime-agent', version: '0.10.1' },
    model: { provider: 'minimax', id: 'MiniMax-M3.1-Flash' },
    isolation: { backend: 'bubblewrap', writablePaths: [], network: 'none', allowedEndpoints: [] },
    credentials: [], quota: { warnTokens: 0, stopTokens: 0, maxWallMs: 0, meteringScope: 'session' }, digest: 'd' },
  repository: { id: 1, fullName: 'owner/repo' }, featureDir: 'specs/001-example',
  baselineCommit: 'c'.repeat(40), artifacts: {}, allowedPaths: ['src/a.ts'], tasks: [gate],
  checks: [], schemaVersion: 1,
} as unknown as ApprovedManifest

describe('the question the operator receives', () => {
  it('names the agent account the decision comment has to mention', () => {
    const question = gateQuestion(gate, manifest, 'szocpaul-dsh-agent')
    expect(question).toContain('@szocpaul-dsh-agent APPROVE GATE T003')
    expect(question).not.toContain('@<agent>')
  })

  it('keeps the placeholder when the login is unknown, rather than naming a wrong account', () => {
    expect(gateQuestion(gate, manifest)).toContain('@<agent>')
  })
})
