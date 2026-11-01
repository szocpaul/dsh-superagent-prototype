import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { canonicalize, checkPath, digest, duplicateKey, ManifestError, manifestDigest, parseCanonical, validateManifest } from '../src/executor/prime-manifest.ts'
import { bytesDigest } from '../src/executor/prime-manifest.ts'
import type { ApprovedManifest } from '../src/executor/prime-model.ts'

const fixture = (name: string): string => readFileSync(fileURLToPath(new URL(`./fixtures/prime-bridge/${name}`, import.meta.url)), 'utf8')
const digests = JSON.parse(fixture('digests.json')) as Record<string, string>

/** A manifest built from the pinned fixture digests, so the fixture cannot drift without the test noticing. */
function manifest(overrides: Partial<ApprovedManifest> = {}): ApprovedManifest {
  const environment = {
    deploymentId: 'deployment-fixture',
    runner: { cli: 'prime-agent', version: '0.10.1' },
    model: { provider: 'fixture', id: 'fixture-model' },
    isolation: { backend: 'bubblewrap' as const, writablePaths: ['src/fixture.ts'], network: 'none' as const, allowedEndpoints: [] },
    credentials: ['model-api'],
    quota: { warnTokens: 1000, stopTokens: 2000, maxWallMs: 600000, meteringScope: 'session' },
  }
  const value = {
    schemaVersion: 1 as const,
    repository: { id: 4242, fullName: 'example/fixture' },
    featureDir: 'specs/001-fixture',
    baselineCommit: 'a'.repeat(40),
    artifacts: { specSha256: digests['baseline-spec.md']!, planSha256: digests['baseline-plan.md']!, tasksSha256: digests['tasks-no-gate.md']!,
      constitutionSha256: null, guidanceSha256: digests['guidance.md']!, hooksSha256: digests['hooks.yml']!, treeSha256: digests['check.sh']! },
    allowedPaths: ['src/fixture.ts'],
    tasks: [{ id: 'T001', kind: 'automated' as const, order: 0, text: 'Set up the fixture workspace' }],
    checks: [{ name: 'fixture-check', argv: ['pnpm', 'test'], cwd: '.', timeoutMs: 60000 }],
    environment: { ...environment, digest: '' },
    ...overrides,
  }
  const withDigest = { ...value, environment: { ...environment, digest: digest(environment as never) } }
  return withDigest as unknown as ApprovedManifest
}

describe('canonical JSON', () => {
  it('sorts object keys and emits no whitespace', () => {
    expect(canonicalize({ b: 1, a: { d: 2, c: [3, 'x'] } })).toBe('{"a":{"c":[3,"x"],"d":2},"b":1}')
  })

  it('keeps array order and canonical escapes', () => {
    expect(canonicalize(['b', 'a', 'ü', 'line\nbreak'])).toBe('["b","a","ü","line\\nbreak"]')
    expect(canonicalize({ 'é': 1 })).toBe('{"é":1}')
  })

  it('rejects values JSON cannot represent', () => {
    expect(() => canonicalize(Number.NaN)).toThrow(ManifestError)
    expect(() => canonicalize(-0)).toThrow(ManifestError)
  })

  it('rejects a repeated key so an ambiguous document never reaches a digest', () => {
    expect(duplicateKey('{"a":1,"a":2}')).toBeTypeOf('string')
    expect(() => parseCanonical('{"a":1,"a":2}')).toThrow(ManifestError)
    expect(parseCanonical('{"a":1}')).toEqual({ a: 1 })
  })

  it('digests the same value the same way regardless of key order', () => {
    expect(digest({ a: 1, b: 2 })).toBe(digest({ b: 2, a: 1 }))
  })
})

describe('manifest paths', () => {
  it('rejects absolute paths, parent segments, and control state', () => {
    expect(() => checkPath('/etc/passwd')).toThrow(ManifestError)
    expect(() => checkPath('../outside')).toThrow(ManifestError)
    expect(() => checkPath('src/../src')).toThrow(ManifestError)
    expect(() => checkPath('.git/config')).toThrow(ManifestError)
    expect(() => checkPath('.specify/feature.json')).toThrow(ManifestError)
  })

  it('accepts a repository-relative path', () => {
    expect(() => checkPath('src/executor/prime-bridge.ts')).not.toThrow()
  })
})

describe('manifest validation', () => {
  it('accepts a valid manifest and gives it a stable digest', () => {
    const value = manifest()
    expect(validateManifest(value)).toEqual(value)
    expect(manifestDigest(value)).toBe(manifestDigest(structuredClone(value)))
  })

  it('rejects a manifest whose environment digest does not match its environment', () => {
    const value = manifest()
    ;(value.environment as { digest: string }).digest = 'b'.repeat(64)
    expect(() => validateManifest(value)).toThrow(/environment digest/)
  })

  it('rejects an unknown key, a repeated task, and a shell command', () => {
    const value = manifest() as ApprovedManifest & { extra?: string }
    value.extra = 'nope'
    expect(() => validateManifest(value)).toThrow(ManifestError)
    expect(() => validateManifest(manifest({ tasks: [{ id: 'T001', kind: 'automated', order: 0, text: 'a' }, { id: 'T001', kind: 'automated', order: 1, text: 'b' }] })))
      .toThrow(/repeat the task ID/)
    expect(() => validateManifest(manifest({ checks: [{ name: 'c', argv: ['sh', '-c', 'rm -rf /'], cwd: '.', timeoutMs: 1 }] }))).toThrow(ManifestError)
  })

  it('rejects a manifest that names writable paths without an isolation backend', () => {
    const value = manifest()
    value.environment.isolation.backend = 'none'
    ;(value.environment as { digest: string }).digest = digest({ ...value.environment, digest: undefined } as never)
    expect(() => validateManifest(value)).toThrow(/isolation backend/)
  })
})

describe('pinned fixture digests', () => {
  it('matches the fixture files on disk, so a changed fixture fails the suite', () => {
    for (const [name, expected] of Object.entries(digests)) {
      expect(bytesDigest(fixture(name)), name).toBe(expected)
    }
  })
})
