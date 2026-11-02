/**
 * Canonical encoding and strict validation of an approved manifest.
 * The manifest digest is SHA-256 over RFC 8785 canonical JSON bytes, so the operator and the controller compare the
 * same bytes, and every validation fails closed rather than repairing a malformed manifest.
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { parseTasks } from './prime-tasks.ts'
import type { ApprovedCheck, ApprovedEnvironment, ApprovedManifest, ApprovedTask } from './prime-model.ts'

/** The canonical bytes of a value, as UTF-8 text. */
export type CanonicalBytes = string

/** Raised when a manifest or a canonical encoding is malformed; the message names the rejected part. */
export class ManifestError extends Error {
  constructor(message: string) { super(message); this.name = 'ManifestError' }
}

const HEX64 = /^[0-9a-f]{64}$/
const SHA1 = /^[0-9a-f]{40}$/
const COMMIT = /^[0-9a-f]{40}$/
/** The shells a check may not run through, because a check is an argument vector and never shell text. */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish', 'ksh'])

/** JSON values that survive canonicalization; `undefined`, functions, and symbols are not JSON. */
type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

const ESCAPES: Record<string, string> = { '"': '\\"', '\\': '\\\\', '\b': '\\b', '\f': '\\f', '\n': '\\n', '\r': '\\r', '\t': '\\t' }

/** Escapes a string exactly as RFC 8785 requires: only the mandatory escapes, other control characters as `\u00xx`. */
function canonicalString(value: string): string {
  let out = '"'
  for (const char of value) {
    const escape = ESCAPES[char]
    if (escape) out += escape
    else if (char < ' ') out += `\\u${char.codePointAt(0)!.toString(16).padStart(4, '0')}`
    else out += char
  }
  return `${out}"`
}

/** Formats a number the way RFC 8785 requires; only finite numbers are JSON. */
function canonicalNumber(value: number): string {
  if (!Number.isFinite(value)) throw new ManifestError('A manifest may not contain a non-finite number')
  if (Object.is(value, -0)) throw new ManifestError('A manifest may not contain negative zero')
  return String(value)
}

/**
 * Canonicalizes a JSON value per RFC 8785: object keys are sorted by UTF-16 code unit, arrays keep their order,
 * strings and numbers use the canonical forms, and no whitespace is emitted.
 * @throws ManifestError when the value contains a value JSON cannot represent.
 */
export function canonicalize(value: Json): CanonicalBytes {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return canonicalNumber(value)
  if (typeof value === 'string') return canonicalString(value)
  if (Array.isArray(value)) return `[${value.map(item => canonicalize(item)).join(',')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as { [key: string]: Json })
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    return `{${entries.map(([key, item]) => `${canonicalString(key)}:${canonicalize(item)}`).join(',')}}`
  }
  throw new ManifestError('A manifest may only contain JSON values')
}

/** Scans JSON text and reports the first duplicate object key it finds, so an ambiguous document never reaches a digest. */
export function duplicateKey(text: string): string | undefined {
  const stack: { keys: Set<string>; path: string }[] = []
  let index = 0
  let repeated: string | undefined
  while (index < text.length) {
    const char = text[index]!
    if (char === '"') {
      let cursor = index + 1
      let value = ''
      while (cursor < text.length) {
        const inner = text[cursor]!
        if (inner === '\\') { value += text[cursor + 1] ?? ''; cursor += 2; continue }
        if (inner === '"') break
        value += inner
        cursor++
      }
      if (text[cursor + 1] === ':') {
        const frame = stack.at(-1)
        if (frame) {
          if (frame.keys.has(value) && repeated === undefined) repeated = value
          frame.keys.add(value)
        }
        index = cursor + 2
        continue
      }
      index = cursor + 1
      continue
    }
    if (char === '{' || char === '[') { stack.push({ keys: new Set(), path: 'object' }); index++; continue }
    if (char === '}' || char === ']') { stack.pop(); index++; continue }
    index++
  }
  return repeated
}

/** Parses JSON text into a canonical value, rejecting duplicate keys and non-I-JSON values. */
export function parseCanonical(text: string): Json {
  const repeated = duplicateKey(text)
  if (repeated !== undefined) throw new ManifestError(`A manifest may not repeat the key "${repeated}"`)
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch (error) { throw new ManifestError(`A manifest is not valid JSON: ${String(error)}`) }
  const value = parsed as Json
  canonicalize(value)
  return value
}

/** SHA-256 over the canonical bytes of a value, as lowercase hex. */
export function digest(value: Json): string {
  return createHash('sha256').update(canonicalize(value), 'utf8').digest('hex')
}

/** SHA-256 over exact bytes, as lowercase hex. */
export function bytesDigest(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

const PathSchema = z.string().min(1)
const Sha256Schema = z.string().regex(HEX64, 'a SHA-256 digest is 64 lowercase hex characters')

/** Rejects a path that is absolute, escapes the repository, or names a control directory. */
export function checkPath(path: string, label = 'path'): void {
  if (!path || path.trim() !== path) throw new ManifestError(`A ${label} may not be empty or padded with whitespace`)
  if (path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)) throw new ManifestError(`A ${label} may not be absolute: ${path}`)
  if (path.includes('\\')) throw new ManifestError(`A ${label} may not use backslashes: ${path}`)
  if (path !== '.' && path.split('/').some(part => part === '..' || part === '.' || part === '')) throw new ManifestError(`A ${label} may not contain "." or "..": ${path}`)
  if (path.startsWith('.git') || path.startsWith('.specify/')) throw new ManifestError(`A ${label} may not name control state: ${path}`)
  if (path.includes('\0')) throw new ManifestError(`A ${label} may not contain a NUL byte`)
}

/** The manifest schema; every field is explicit, so an unknown key fails the parse. */
const ManifestSchema = z.object({
  schemaVersion: z.literal(1),
  repository: z.object({ id: z.number().int().positive(), fullName: z.string().regex(/^[\w.-]+\/[\w.-]+$/) }).strict(),
  featureDir: PathSchema,
  baselineCommit: z.string().regex(COMMIT),
  artifacts: z.object({
    specSha256: Sha256Schema, planSha256: Sha256Schema, tasksSha256: Sha256Schema,
    constitutionSha256: Sha256Schema.nullable(), guidanceSha256: Sha256Schema.nullable(), hooksSha256: Sha256Schema.nullable(),
    treeSha256: Sha256Schema,
  }).strict(),
  allowedPaths: z.array(PathSchema).min(1),
  tasks: z.array(z.object({
    id: z.string().regex(/^T\d{3,}$/),
    kind: z.enum(['automated', 'human']),
    order: z.number().int().nonnegative(),
    text: z.string().min(1),
  }).strict()).min(1),
  checks: z.array(z.object({
    name: z.string().min(1), argv: z.array(z.string()).min(1), cwd: PathSchema, timeoutMs: z.number().int().positive(),
  }).strict()),
  environment: z.object({
    deploymentId: z.string().min(1),
    runner: z.object({ cli: z.string().min(1), version: z.string().min(1) }).strict(),
    model: z.object({ provider: z.string().min(1), id: z.string().min(1) }).strict(),
    isolation: z.object({
      backend: z.enum(['bubblewrap', 'none']),
      writablePaths: z.array(PathSchema),
      network: z.enum(['none', 'allowlist']),
      allowedEndpoints: z.array(z.string().min(1)),
    }).strict(),
    credentials: z.array(z.string().min(1)),
    quota: z.object({ warnTokens: z.number().int().nonnegative(), stopTokens: z.number().int().positive(), maxWallMs: z.number().int().positive(),
      meteringScope: z.string().min(1) }).strict(),
    digest: Sha256Schema,
  }).strict(),
}).strict()

/**
 * Validates a manifest and returns it in its canonical shape.
 * @throws ManifestError when the manifest is malformed, when a path escapes the repository, when a task ID repeats,
 *   when a check names a shell string, or when the environment digest does not match its content.
 */
export function validateManifest(value: unknown): ApprovedManifest {
  const parsed = ManifestSchema.safeParse(value)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new ManifestError(`A manifest is invalid: ${issue?.path.join('.') || 'the document'} ${issue?.message ?? 'is not valid'}`)
  }
  const manifest = parsed.data
  checkPath(manifest.featureDir, 'feature directory')
  const seen = new Set<string>()
  for (const task of manifest.tasks) {
    if (seen.has(task.id)) throw new ManifestError(`A manifest may not repeat the task ID ${task.id}`)
    seen.add(task.id)
  }
  manifest.tasks.forEach((task, index) => {
    if (task.order !== index) throw new ManifestError(`The task ${task.id} must have the order ${index}`)
  })
  const paths = new Set<string>()
  for (const path of manifest.allowedPaths) {
    checkPath(path, 'allowed path')
    if (paths.has(path)) throw new ManifestError(`A manifest may not repeat the allowed path ${path}`)
    paths.add(path)
  }
  for (const check of manifest.checks) {
    checkPath(check.cwd, 'check directory')
    if (SHELLS.has(check.argv[0] ?? '')) throw new ManifestError(`The check ${check.name} may not run through a shell; store it as an argument vector`)
  }
  for (const path of manifest.environment.isolation.writablePaths) checkPath(path, 'writable path')
  if (manifest.environment.isolation.backend === 'none' && manifest.environment.isolation.writablePaths.length) {
    throw new ManifestError('A manifest without an isolation backend may not name writable paths')
  }
  const { digest: recorded, ...environment } = manifest.environment
  const computed = digest(environment as never)
  if (computed !== recorded) throw new ManifestError('The environment digest does not match the environment it covers')
  return manifest as ApprovedManifest
}

/** The canonical bytes of a manifest, which are the bytes the manifest digest covers. */
export function manifestBytes(manifest: ApprovedManifest): CanonicalBytes {
  return canonicalize(manifest as never)
}

/** The manifest's digest: SHA-256 over its canonical bytes. */
export function manifestDigest(manifest: ApprovedManifest): string {
  return bytesDigest(manifestBytes(manifest))
}


/** The repository the manifest is built from, read at one fixed baseline. */
export interface ManifestSource {
  /** The full commit SHA of the baseline. */
  revision(): Promise<string>
  /** The tree SHA of the baseline commit. */
  tree(): Promise<string>
  /** The exact bytes of a repository-relative file at the baseline, or undefined when it does not exist. */
  read(path: string): Promise<string | undefined>
  /** The repository-relative paths the baseline tracks. */
  paths(): Promise<string[]>
}

/** What the operator or the request names for the manifest. */
export interface ManifestRequest {
  /** The GitHub repository the run touches. */
  repository: { id: number; fullName: string }
  /** The repository-relative feature directory. */
  featureDir: string
  /** The environment the run uses; its digest is part of the manifest. */
  environment: Omit<ApprovedEnvironment, 'digest'>
  /** The paths the runner may write; when it is absent, the paths the plan names are proposed. */
  allowedPaths?: string[]
  /** The checks the controller reruns; when it is absent, the repository's own scripts are proposed. */
  checks?: ApprovedCheck[]
}

/**
 * The paths the plan's Project Structure section names, which the manifest proposes as the writable scope.
 *
 * The section is read from its "Source Code" part, not from the documentation tree: a plan lists the feature's own
 * artifacts first and the repository's files afterwards, and the documentation tree names no writable path at all.
 * A plan without that heading falls back to every code block, so a simpler plan still proposes a scope.
 */
export function pathsFromPlan(plan: string): string[] {
  const blocks = [...plan.matchAll(/```(?:text|ts|tsx)?\n([\s\S]*?)```/g)].map(match => match[1] ?? '')
  const heading = plan.indexOf('### Source Code')
  const candidates = heading < 0 ? blocks : blocks.slice(1)
  const found = new Set<string>()
  for (const block of candidates) {
    for (const line of block.split('\n')) {
      const match = /([\w./@-]+(?:\/[\w./@-]+)*)\/?(?:\s|$)/.exec(line.replace(/^[\u2502\u251c\u2514\u2500\s]+/, ''))
      const path = match?.[1]
      if (!path || path.includes('.') && !path.includes('/')) continue
      if (path.startsWith('specs/') || path.startsWith('docs/') || path.startsWith('prompts/') || path.startsWith('skills/')) continue
      found.add(path.replace(/\/$/, ''))
    }
  }
  return [...found].sort()
}

/**
 * Builds the approved manifest of one feature at one baseline: the exact artifact bytes, the ordered tasks, the
 * proposed writable scope, the proposed checks, and the environment.
 * @throws ManifestError when the feature directory, its artifacts, or the baseline are missing or malformed.
 */
export async function buildManifest(source: ManifestSource, request: ManifestRequest): Promise<ApprovedManifest> {
  checkPath(request.featureDir, 'feature directory')
  const revision = await source.revision()
  if (!COMMIT.test(revision)) throw new ManifestError('The baseline revision must be a full commit SHA')
  const tree = await source.tree()
  if (!HEX64.test(tree)) throw new ManifestError('The baseline tree must be a SHA-256 digest')
  const [spec, plan, tasks, constitution, guidance, hooks] = await Promise.all([
    source.read(`${request.featureDir}/spec.md`),
    source.read(`${request.featureDir}/plan.md`),
    source.read(`${request.featureDir}/tasks.md`),
    source.read('.specify/memory/constitution.md'),
    source.read('AGENTS.md'),
    source.read('.specify/extensions.yml'),
  ])
  if (!spec) throw new ManifestError(`The feature directory ${request.featureDir} has no spec.md`)
  if (!plan) throw new ManifestError(`The feature directory ${request.featureDir} has no plan.md`)
  if (!tasks) throw new ManifestError(`The feature directory ${request.featureDir} has no tasks.md`)
  const parsed = parseTaskList(tasks)
  const tracked = new Set(await source.paths())
  const proposed = request.allowedPaths ?? pathsFromPlan(plan)
  const allowedPaths = proposed.filter(path => {
    try { checkPath(path, 'allowed path') } catch { return false }
    return tracked.has(path) || [...tracked].some(item => item.startsWith(`${path}/`))
  })
  if (!allowedPaths.length) throw new ManifestError('The manifest proposes no writable path; the operator must name the approved scope')
  const checks = request.checks ?? await defaultChecks(source)
  // The writable scope of the run is the approved scope: the confinement binds exactly these paths writable, so the
  // manifest and the isolation can never disagree about what the run may write.
  const isolation = { ...request.environment.isolation, writablePaths: [...allowedPaths] }
  const environment = { ...request.environment, isolation, digest: digest({ ...request.environment, isolation } as never) }
  return validateManifest({
    schemaVersion: 1,
    repository: request.repository,
    featureDir: request.featureDir,
    baselineCommit: revision,
    artifacts: {
      specSha256: bytesDigest(spec),
      planSha256: bytesDigest(plan),
      tasksSha256: bytesDigest(tasks),
      constitutionSha256: constitution ? bytesDigest(constitution) : null,
      guidanceSha256: guidance ? bytesDigest(guidance) : null,
      hooksSha256: hooks ? bytesDigest(hooks) : null,
      treeSha256: tree,
    },
    allowedPaths,
    tasks: parsed,
    checks,
    environment,
  })
}

/** The tasks of an approved task list, in approved order. */
function parseTaskList(markdown: string): ApprovedTask[] {
  const tasks = parseTasks(markdown)
  return tasks.map(task => ({ id: task.id, kind: task.kind, order: task.order, text: task.text }))
}

/** The repository's own check scripts, proposed as the checks the controller reruns. */
async function defaultChecks(source: ManifestSource): Promise<ApprovedCheck[]> {
  const text = await source.read('package.json')
  if (!text) return []
  const scripts = (JSON.parse(text) as { scripts?: Record<string, string> }).scripts ?? {}
  return ['typecheck', 'test'].filter(name => scripts[name]).map(name => ({
    name, argv: ['pnpm', 'run', name], cwd: '.', timeoutMs: 900_000,
  }))
}
