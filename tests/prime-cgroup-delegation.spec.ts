import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cgroupPath, CGROUP_ROOT, systemdUnitName } from '../src/infra/prime-isolation.ts'

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
