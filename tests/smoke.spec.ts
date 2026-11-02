import { describe, expect, it } from 'vitest'
import { SMOKE_VERSION, smoke } from '../src/smoke.ts'

describe('the smoke fixture', () => {
  it('returns the smoke string', () => {
    expect(smoke()).toBe('smoke')
  })

  it('exports the behaviour as a function', () => {
    expect(typeof smoke).toBe('function')
  })

  it('exposes the version one', () => {
    expect(SMOKE_VERSION).toBe(1)
  })
})
