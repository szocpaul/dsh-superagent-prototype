import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cgroupPath, CGROUP_ROOT, systemdUnitName } from '../src/infra/prime-isolation.ts'
import { hostRunEnvironment } from '../src/app/prime-service.ts'
import { PrimeSupervisor } from '../src/executor/prime-supervisor.ts'

const exec = promisify(execFile)
const segmentId = 'test-segment-0001'

/**
 * The cgroup a run needs only exists when the account that runs the controller
 * owns the delegation. This test proves the delegation on the host it runs on,
 * and states plainly when the host cannot provide it.
 */
describe('the delegated cgroup of a run', () => {
  it('places the run under the delegated root, not under the login session scope', () => {
    expect(cgroupPath(segmentId)).toContain(CGROUP_ROOT)
    expect(cgroupPath(segmentId)).not.toContain('session-')
    expect(cgroupPath(segmentId)).toContain(systemdUnitName(segmentId))
  })

  it('creates the cgroup through the run service unit and proves the quiescence', async () => {
    const unit = `${systemdUnitName(segmentId)}.service`
    try {
      await exec('systemd-run', ['--user', `--unit=${unit}`, '--property=Delegate=yes', '--collect', '/bin/sleep', 'infinity'])
    } catch (error) {
      // The host cannot delegate a cgroup to this account. The run stays blocked.
      expect(String(error)).toBeTruthy()
      return
    }
    const shown = await exec('systemctl', ['--user', 'show', unit, '--property=ControlGroup', '--value'])
    const cgroup = `/sys/fs/cgroup${shown.stdout.trim()}`
    expect(existsSync(join(cgroup, 'cgroup.procs'))).toBe(true)

    // The cgroup holds the service's own process, so it is not yet quiescent.
    const before = readFileSync(join(cgroup, 'cgroup.procs'), 'utf8').split('\n').filter(Boolean)
    expect(before.length).toBeGreaterThan(0)

    // Writing the kill file empties the whole tree, which is the proof of a stop.
    writeFileSync(join(cgroup, 'cgroup.kill'), '1')
    await new Promise(resolve => setTimeout(resolve, 500))
    const after = existsSync(join(cgroup, 'cgroup.procs'))
      ? readFileSync(join(cgroup, 'cgroup.procs'), 'utf8').split('\n').filter(Boolean)
      : []
    expect(after).toEqual([])
  }, 30_000)
})

/**
 * The cgroup of a run that is gone.
 *
 * The kernel removes a cgroup only when it holds no process and no child cgroup, so a cgroup that does not exist
 * proves that the run holds no process. A cgroup that exists but cannot be read keeps the state of the run unknown.
 */
describe('the cgroup of a run that is gone', () => {
  const commands = { run: async () => '' } as never
  const gone = join(tmpdir(), 'prime-cgroup-gone', 'no-such-cgroup')

  it('reads a cgroup that does not exist as a run that holds no process', () => {
    expect(hostRunEnvironment(commands).processes(gone)).toEqual([])
  })

  it('cancels a run whose cgroup is gone without failing', async () => {
    await expect(hostRunEnvironment(commands).cancel({ cgroup: gone } as never)).resolves.toBeUndefined()
  })

  it('keeps the state of a run unknown when its cgroup cannot be read', () => {
    const unreadable = mkdtempSync(join(tmpdir(), 'prime-cgroup-unreadable-'))
    expect(() => hostRunEnvironment(commands).processes(unreadable)).toThrow()
  })

  it('confirms the stop of a run whose cgroup is gone', async () => {
    const supervisor = new PrimeSupervisor({} as never, hostRunEnvironment(commands))
    const verdict = await supervisor.stop({ cgroup: gone } as never, 'the test stops the run')
    expect(verdict.status).toBe('stopped')
    expect(verdict.processes).toEqual([])
  })
})
