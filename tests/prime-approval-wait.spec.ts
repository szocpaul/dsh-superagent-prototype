/**
 * The human approval of a run: the effect waits for the decision instead of completing on the first poll, so a
 * manifest the operator approves later still starts the run. A refusal ends the wait and is reported, and a denied
 * manifest never reserves a segment.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { harness, type Harness } from './fixtures/prime-bridge-host.ts'
import type { ApprovalRecord } from '../src/executor/prime-model.ts'

let host: Harness
afterEach(() => host?.dispose())

/** The decision the fake approval port reports for the manifest of the run. */
const decision = (recorded: 'approved' | 'denied'): ApprovalRecord => ({
  approvalId: 'approval-1',
  kind: 'run',
  manifestId: '5'.repeat(64),
  manifestSha256: '5'.repeat(64),
  ticketId: 'ticket-1',
  triggerId: 'trigger-1',
  policyVersion: 'policy-1',
  repositoryId: 42,
  commentId: '101',
  commentSha256: '6'.repeat(64),
  actor: { id: 7, login: 'human', type: 'User' },
  at: '2026-11-01T00:00:00.000Z',
  environmentApproved: true,
  decision: recorded,
})

/** Runs the approval effect of one ticket and waits for the attempt to finish. */
async function awaitDecision(): Promise<void> {
  host.bridge.install()
  host.effects.enqueue('prime-approval', 'ticket-1', { ticketId: 'ticket-1' })
  host.effects.start()
  await host.effects.idle('prime-approval')
}

describe('the approval of a run', () => {
  it('keeps waiting while the human has not answered, so a later approval still starts the run', async () => {
    host = harness()
    await awaitDecision()
    // The effect is still queued for the decision, and no segment was reserved without one.
    expect(host.effects.pending('prime-approval', 'ticket-1')).toBe(true)
    expect(host.store.bridge.segments.byTicket('ticket-1')).toHaveLength(0)
  })

  it('reserves the run when the human approves the manifest', async () => {
    host = harness({ runApproval: () => decision('approved') })
    await awaitDecision()
    expect(host.effects.pending('prime-approval', 'ticket-1')).toBe(false)
    expect(host.store.bridge.segments.byTicket('ticket-1')).toHaveLength(1)
  })

  it('reports the refusal and reserves nothing when the human denies the manifest', async () => {
    host = harness({ runApproval: () => decision('denied') })
    await awaitDecision()
    expect(host.store.bridge.segments.byTicket('ticket-1')).toHaveLength(0)
    expect(host.calls.reports.at(-1)).toEqual({
      state: 'blocked',
      summary: 'The human denied the run of specs/001-prime',
    })
  })
})
