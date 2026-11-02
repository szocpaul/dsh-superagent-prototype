import { describe, expect, it } from 'vitest'
import * as fixture from '../src/smoke.ts'
import { SMOKE_VERSION, smoke } from '../src/smoke.ts'

describe('the smoke fixture', () => {
  it('returns the smoke string', () => {
    expect(smoke()).toBe('smoke')
  })

  it('exports the behaviour as a function', () => {
    expect(smoke).toBeTypeOf('function')
  })

  it('exposes the version one', () => {
    expect(SMOKE_VERSION).toBe(1)
  })

  it('exports the behaviour and the version, and nothing else', () => {
    expect(Object.keys(fixture).sort()).toEqual(['SMOKE_VERSION', 'smoke'])
  })
})
