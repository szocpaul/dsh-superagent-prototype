import { describe, expect, it } from 'vitest'
import { SMOKE_VERSION, smoke } from '../src/smoke.ts'

describe('the smoke fixture', () => {
  it('returns the smoke string', () => {
    expect(smoke()).toBe('smoke')
  })

  it('exports the behaviour and the version', () => {
    expect(typeof smoke).toBe('function')
    expect(typeof SMOKE_VERSION).toBe('number')
  })

  it('exposes the version one', () => {
    expect(SMOKE_VERSION).toBe(1)
  })
})
