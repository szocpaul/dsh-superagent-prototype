import { describe, expect, it } from 'vitest'
import { allowlistOf } from '../src/app/prime-service.ts'
import { approvalIsCurrent } from '../src/app/prime-approval.ts'
import { SettingsSchema } from '../src/policy.ts'

/** The settings the test needs: a Policy with a GitHub allowlist. */
const settings = (allowed: string[]) => SettingsSchema.parse({
  policy: { sources: { github: { allowed: allowed.map(id => ({ id })) } } },
})

describe('the approver allowlist', () => {
  it('never includes the agent own account', () => {
    expect(allowlistOf(settings(['szocpaul', 'szocpaul-dsh-agent']), 'szocpaul-dsh-agent')).toEqual(['szocpaul'])
  })

  it('ignores the case of the login', () => {
    expect(allowlistOf(settings(['SzocPaul-DSH-Agent', 'szocpaul']), 'szocpaul-dsh-agent')).toEqual(['szocpaul'])
  })

  it('keeps the list when the agent login is unknown', () => {
    expect(allowlistOf(settings(['szocpaul']), undefined)).toEqual(['szocpaul'])
  })

  it('refuses an approval that the agent account made', () => {
    const approval = { decision: 'approved', actor: { id: 1, login: 'szocpaul-dsh-agent', type: 'User' } }
    const allowed = allowlistOf(settings(['szocpaul-dsh-agent']), 'szocpaul-dsh-agent')
    expect(approvalIsCurrent(approval as never, allowed)).toBe(false)
  })

  it('accepts an approval that an allowlisted human made', () => {
    const approval = { decision: 'approved', actor: { id: 2, login: 'szocpaul', type: 'User' } }
    const allowed = allowlistOf(settings(['szocpaul']), 'szocpaul-dsh-agent')
    expect(approvalIsCurrent(approval as never, allowed)).toBe(true)
  })
})
