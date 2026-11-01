/**
 * The accepted task grammar of an approved task list, and the comparator that tells authorized progress from a scope change.
 * The parser is deliberately narrow: it fails closed on ambiguous syntax instead of inferring what a Markdown list meant.
 */

/** Raised when a task list does not match the accepted grammar; the message names the offending line. */
export class TaskError extends Error {
  constructor(message: string) { super(message); this.name = 'TaskError' }
}

/** Whether a task may be completed by the runner (`automated`) or only by a person (`human`). */
export type TaskKind = 'automated' | 'human'

/** One parsed task line. */
export interface TaskLine {
  /** The unique task ID, such as `T012`. */
  id: string
  kind: TaskKind
  /** The task's position in the file, starting at 0. */
  order: number
  /** Whether the line's checkbox is marked. */
  checked: boolean
  /** The one-based line number in the source text. */
  line: number
  /** The task's text, without the checkbox, ID, and tags. */
  text: string
  /** The tags the line carried, such as `P` or `US1`. */
  tags: string[]
}

const TASK_LINE = /^[-*]\s+\[([ xX])\]\s+([A-Za-z0-9_-]+)\s*(.*)$/
const ID = /^T\d{3,}$/
/** The words that mark a task as a human gate; a person alone completes it. */
export const GATE_WORDS = ['MANUAL GATE', 'HUMAN GATE', 'GATE', 'MANUÁLIS KAPU']
const TAG = /^\[([^\]]+)\]\s*/

/**
 * Parses an approved task list into its tasks.
 * @throws TaskError when a checkbox line has no task ID, repeats an ID, or names a gate in an unexpected place.
 */
export function parseTasks(markdown: string): TaskLine[] {
  const tasks: TaskLine[] = []
  const seen = new Map<string, number>()
  const lines = markdown.split('\n')
  for (const [index, text] of lines.entries()) {
    const match = TASK_LINE.exec(text)
    if (!match) {
      if (/^\s*[-*]\s+\[/.test(text)) throw new TaskError(`Line ${index + 1} is a checkbox line the accepted grammar does not allow`)
      continue
    }
    const marker = match[1] ?? ' '
    const id = match[2] ?? ''
    const rest = match[3] ?? ''
    if (!ID.test(id)) throw new TaskError(`Line ${index + 1} names "${id}", which is not a task ID`)
    if (seen.has(id)) throw new TaskError(`Line ${index + 1} repeats the task ID ${id} from line ${seen.get(id)}`)
    seen.set(id, index + 1)
    let body = rest ?? ''
    const tags: string[] = []
    for (;;) {
      const tag = TAG.exec(body)
      if (!tag) break
      tags.push(tag[1] ?? '')
      body = body.slice(tag[0].length)
    }
    const gate = GATE_WORDS.find(word => body.startsWith(word))
    tasks.push({
      id,
      kind: gate ? 'human' : 'automated',
      order: tasks.length,
      checked: marker !== ' ',
      line: index + 1,
      text: body.trim(),
      tags,
    })
  }
  if (!tasks.length) throw new TaskError('The task list has no task lines')
  return tasks
}

/** The first human gate at or after `from`, when the segment stops before one. */
export function nextGate(tasks: readonly TaskLine[], from = 0): TaskLine | undefined {
  return tasks.slice(from).find(task => task.kind === 'human')
}

/** One difference between an approved task list and the current one. */
export type ProgressDifference =
  | { kind: 'progress'; id: string; from: boolean; to: boolean }
  | { kind: 'added'; id: string }
  | { kind: 'removed'; id: string }
  | { kind: 'reordered'; id: string; expected: number; actual: number }
  | { kind: 'edited'; id: string }

/**
 * Compares an approved task list with the current one.
 * Progress is a checkbox change of an existing task; anything else changes the approved scope and needs a new approval.
 */
export function compareTasks(approved: readonly TaskLine[], current: readonly TaskLine[]): ProgressDifference[] {
  const differences: ProgressDifference[] = []
  const before = new Map(approved.map(task => [task.id, task]))
  const after = new Map(current.map(task => [task.id, task]))
  for (const task of approved) {
    const now = after.get(task.id)
    if (!now) { differences.push({ kind: 'removed', id: task.id }); continue }
    if (now.order !== task.order) differences.push({ kind: 'reordered', id: task.id, expected: task.order, actual: now.order })
    if (now.text !== task.text) differences.push({ kind: 'edited', id: task.id })
    if (now.checked !== task.checked) differences.push({ kind: 'progress', id: task.id, from: task.checked, to: now.checked })
  }
  for (const task of current) if (!before.has(task.id)) differences.push({ kind: 'added', id: task.id })
  return differences
}

/** Why the current task list may not be treated as progress on the approved one. */
export interface ScopeViolation {
  /** The task the difference belongs to. */
  id: string
  /** Why the difference is not authorized progress. */
  reason: string
}

/**
 * Checks that the current task list only records authorized progress on the approved one.
 * A checkbox may change only for an automated task, and a task that was already checked stays checked.
 * @returns The violations; an empty list means the change is authorized progress.
 */
export function scopeViolations(approved: readonly TaskLine[], current: readonly TaskLine[]): ScopeViolation[] {
  const violations: ScopeViolation[] = []
  const kinds = new Map(approved.map(task => [task.id, task.kind]))
  for (const difference of compareTasks(approved, current)) {
    if (difference.kind === 'progress') {
      const kind = kinds.get(difference.id)
      if (kind === 'human') { violations.push({ id: difference.id, reason: 'a human gate may only be completed by a person' }); continue }
      if (difference.from && !difference.to) { violations.push({ id: difference.id, reason: 'a completed task may not be unchecked' }); continue }
    } else if (difference.kind === 'added') violations.push({ id: difference.id, reason: 'a new task changes the approved scope' })
    else if (difference.kind === 'removed') violations.push({ id: difference.id, reason: 'a removed task changes the approved scope' })
    else if (difference.kind === 'reordered') violations.push({ id: difference.id, reason: 'a reordered task changes the approved scope' })
    else violations.push({ id: difference.id, reason: 'an edited task changes the approved scope' })
  }
  return violations
}

/** The tasks of a segment: the approved tasks up to the first human gate. */
export function segmentTasks(approved: readonly TaskLine[], from = 0): TaskLine[] {
  const segment: TaskLine[] = []
  for (const task of approved.slice(from)) {
    if (task.kind === 'human') break
    segment.push(task)
  }
  return segment
}
