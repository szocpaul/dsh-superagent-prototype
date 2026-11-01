import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PrimeSupervisor } from '../src/executor/prime-supervisor.ts'
import type { IsolationPlan, IsolationRunner } from '../src/infra/prime-isolation.ts'

/** A runner that reports its identity at once and then keeps running, like the real one. */
function reportingRunner(): IsolationRunner & { calls: string[][] } {
  const calls: string[][] = []
  return {
    calls,
    async run(argv) { calls.push(argv); return { exitCode: 0, stdout: '', stderr: '' } },
    spawn(argv) {
      calls.push(argv)
      let ended = false
      const stdout = 'session id: session-abc\nsession file: /run/prime/session-abc.jsonl\n'
      return {
        pid: 4242,
        kill() { ended = true },
        output() { return stdout },
        stderr() { return '' },
        ended() { return ended },
        async wait() { return { exitCode: 0, stdout, stderr: '' } },
      }
    },
  }
}

describe('the bootstrap barrier', () => {
  it('does not release the runner before the controller knows its identity', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'prime-barrier-'))
    try {
      const barrier = join(workspace, '.prime-bridge-barrier')
      expect(existsSync(barrier)).toBe(false)

      const plan = {
        backend: 'bubblewrap',
        segmentId: 'seg-1',
        workspace,
        repositoryRoot: workspace,
        mountPoint: '/workspace',
        workspaceMount: '/workspace',
        writablePaths: [],
        readOnlyPaths: [workspace],
        readOnlySample: workspace,
        network: 'none',
        allowedEndpoints: [],
        home: workspace,
        tmp: workspace,
        argv: ['prime-agent', '--autonomous'],
        env: { HOME: '/tmp', TMPDIR: '/tmp', PATH: '/usr/bin:/bin' },
        inheritedDescriptors: [0, 1, 2],
        cgroup: join(workspace, 'cgroup'),
        socket: join(workspace, 'runner.sock'),
      } as unknown as IsolationPlan

      const supervisor = new PrimeSupervisor(reportingRunner(), {
        supported: () => true,
        async start() {},
        async cancel() {},
        processes: () => [],
        async remove() { return [] },
      })
      const identity = {
        serviceUnit: 'prime-runner-seg-1',
        cgroup: join(workspace, 'cgroup'),
        tmux: 'tmux-seg-1',
        socket: 'sock',
        workspace,
        branch: 'agent/seg-1',
      }
      const result = await supervisor.launch(plan, identity)
      expect(result.identity.sessionId).toBe('session-abc')

      // The barrier is released only after the launch returned the durable identity.
      writeFileSync(barrier, 'seg-1:1')
      expect(readFileSync(barrier, 'utf8')).toContain('seg-1')
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})
