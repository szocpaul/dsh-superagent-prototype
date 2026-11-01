import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { compareTasks, nextGate, parseTasks, scopeViolations, segmentTasks, TaskError } from '../src/executor/prime-tasks.ts'

const fixture = (name: string): string => readFileSync(fileURLToPath(new URL(`./fixtures/prime-bridge/${name}`, import.meta.url)), 'utf8')

describe('task grammar', () => {
  it('parses ordered tasks with their tags', () => {
    const tasks = parseTasks(fixture('tasks-no-gate.md'))
    expect(tasks.map(task => task.id)).toEqual(['T001', 'T002', 'T003', 'T004'])
    expect(tasks[0]!.tags).toEqual(['P'])
    expect(tasks.every(task => task.kind === 'automated')).toBe(true)
    expect(tasks.map(task => task.order)).toEqual([0, 1, 2, 3])
  })

  it('recognises a human gate and stops a segment before it', () => {
    const tasks = parseTasks(fixture('tasks-gate.md'))
    expect(tasks[2]!.kind).toBe('human')
    expect(nextGate(tasks)?.id).toBe('T003')
    expect(segmentTasks(tasks).map(task => task.id)).toEqual(['T001', 'T002'])
    expect(segmentTasks(tasks, 3).map(task => task.id)).toEqual(['T004'])
  })

  it('fails closed on a repeated task ID and on an unusable checkbox line', () => {
    expect(() => parseTasks(fixture('tasks-ambiguous.md'))).toThrow(TaskError)
    expect(() => parseTasks(fixture('tasks-unparsable.md'))).toThrow(TaskError)
  })

  it('fails closed on a task list with no task lines', () => {
    expect(() => parseTasks('# Tasks\n\nNothing here.\n')).toThrow(TaskError)
  })
})

describe('progress and scope', () => {
  const approved = parseTasks(fixture('tasks-no-gate.md'))
  const withProgress = approved.map(task => task.id === 'T001' ? { ...task, checked: true } : task)

  it('reports a checkbox change as progress', () => {
    expect(compareTasks(approved, withProgress)).toEqual([{ kind: 'progress', id: 'T001', from: false, to: true }])
    expect(scopeViolations(approved, withProgress)).toEqual([])
  })

  it('reports an added, removed, reordered, or edited task as a scope change', () => {
    expect(scopeViolations(approved, [...approved, { ...approved[0]!, id: 'T009', order: 4, text: 'new' }]))
      .toEqual([{ id: 'T009', reason: 'a new task changes the approved scope' }])
    expect(scopeViolations(approved, approved.slice(1))[0]!.reason).toBe('a removed task changes the approved scope')
    const reordered = approved.map(task => ({ ...task, order: task.id === 'T001' ? 3 : task.order - 1 }))
    expect(scopeViolations(approved, reordered)[0]!.reason).toBe('a reordered task changes the approved scope')
    expect(scopeViolations(approved, [{ ...approved[0]!, text: 'edited' }, ...approved.slice(1)])[0]!.reason)
      .toBe('an edited task changes the approved scope')
  })

  it('never accepts a human gate as runner progress', () => {
    const gated = parseTasks(fixture('tasks-gate.md'))
    const ticked = gated.map(task => task.id === 'T003' ? { ...task, checked: true } : task)
    expect(scopeViolations(gated, ticked)).toEqual([{ id: 'T003', reason: 'a human gate may only be completed by a person' }])
  })

  it('never accepts unchecking a completed task', () => {
    const done = approved.map(task => ({ ...task, checked: true }))
    expect(scopeViolations(done, approved).map(item => item.id)).toEqual(['T001', 'T002', 'T003', 'T004'])
  })
})
