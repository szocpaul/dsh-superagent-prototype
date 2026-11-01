import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

/**
 * Runs the service script's helpers against a fake `ps` output.
 * The script is Python, so its helpers are exercised by the interpreter itself rather than by a reimplementation.
 */
async function withFakePs(rows: string[], snippet: string): Promise<string> {
  const source = readFileSync('scripts/dsh-superagent', 'utf8')
  const patched = source.replace(
    /def ps\(\*options, check=False\):[\s\S]*?yield int\(parts\[0\]\), parts\[1\], parts\[2\]\.split\(\)/,
    `def ps(*options, check=False):\n    for row in rows:\n        parts = row.split(None, 2)\n        if len(parts) == 3 and parts[0].isdigit():\n            yield int(parts[0]), parts[1], parts[2].split()`,
  )
  const dir = mkdtempSync(join(tmpdir(), 'service-script-'))
  const file = join(dir, 'script.py')
  // The helper functions come first; the snippet runs them and prints the result.
  const body = patched.replace(/def main\(\)[\s\S]*$/m, '')
  writeFileSync(file, `ROWS = ${JSON.stringify(rows)}\n${body.replace('for row in rows:', 'for row in ROWS:')}\n${snippet}\n`)
  const out = await exec('python3', [file])
  return out.stdout
}

describe('the service script', () => {
  it('finds the service process when ps reports the thread name', async () => {
    // On some systems ps reports `MainThread` in ucomm instead of `node`.
    const rows = ['1324915 MainThread node /home/ubuntu/.npm-global/bin/dsh --profile superagent --no-open']
    const found = await withFakePs(rows, 'print(processes("superagent"))')
    expect(found.trim()).toBe('[1324915]')
  })

  it('finds the service process when ps reports the node name', async () => {
    const rows = ['1324915 node /home/ubuntu/.npm-global/bin/dsh --profile superagent --no-open']
    const found = await withFakePs(rows, 'print(processes("superagent"))')
    expect(found.trim()).toBe('[1324915]')
  })

  it('ignores another profile and another node program', async () => {
    const rows = [
      '111 node /home/ubuntu/.npm-global/bin/dsh --profile other --no-open',
      '222 node /usr/bin/node /home/ubuntu/some/server.js',
      '333 MainThread node /home/ubuntu/.npm-global/bin/dsh --profile superagent --no-open',
    ]
    const found = await withFakePs(rows, 'print(processes("superagent"))')
    expect(found.trim()).toBe('[333]')
  })
})
