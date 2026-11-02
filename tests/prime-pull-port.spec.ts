import { expect, it, vi } from 'vitest'
import { Commands } from '../src/infra/commands.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { pullPort } from '../src/app/prime-service.ts'

const commands = () => new Commands(() => testDeployment(), {}, new AbortController().signal)

it('sends every field of a new pull request as its own argument, and reads the answer as JSON', async () => {
  const cli = commands()
  const run = vi.spyOn(cli, 'run').mockResolvedValue(JSON.stringify({ number: 42, url: 'https://example.test/pull/42' }))
  const pull = await pullPort(cli, '/tmp').createPull({ title: 'the title', body: 'the body', head: 'agent/x', base: 'main', draft: true })
  expect(pull).toEqual({ number: 42, url: 'https://example.test/pull/42' })
  expect(run).toHaveBeenCalledWith('/bin/false', ['api', 'repos/acme/widgets/pulls', '-X', 'POST',
    '-f', 'title=the title', '-f', 'body=the body', '-f', 'head=agent/x', '-f', 'base=main', '-F', 'draft=true'])
})

it('updates an existing pull request with the same fields', async () => {
  const cli = commands()
  const run = vi.spyOn(cli, 'run').mockResolvedValue(JSON.stringify({ number: 42, url: 'u' }))
  await pullPort(cli, '/tmp').updatePull(42, { title: 't', body: 'b', draft: false })
  expect(run).toHaveBeenCalledWith('/bin/false', ['api', 'repos/acme/widgets/pulls/42', '-X', 'PATCH',
    '-f', 'title=t', '-f', 'body=b', '-F', 'draft=false'])
})

it('reads the state of an existing pull request, including the auto-merge request', async () => {
  const cli = commands()
  vi.spyOn(cli, 'run').mockResolvedValue(JSON.stringify({ state: 'open', draft: true, auto_merge: null, head: { ref: 'agent/x' }, base: { ref: 'main' }, html_url: 'u' }))
  expect(await pullPort(cli, '/tmp').pull(7)).toEqual({ state: 'open', draft: true, autoMerge: false, head: 'agent/x', base: 'main', url: 'u' })
})

it('reads the branch head from the server, so a branch that does not exist yet has no moved head', async () => {
  const cli = commands()
  const run = vi.spyOn(cli, 'run')
  run.mockResolvedValueOnce(JSON.stringify({ object: { sha: 'a'.repeat(40) } }))
  expect(await pullPort(cli, '/tmp').branchHead('agent/x')).toBe('a'.repeat(40))
  expect(run).toHaveBeenCalledWith('/bin/false', ['api', 'repos/acme/widgets/git/ref/heads/agent%2Fx'])
  // A branch the server does not know has no head at all.
  run.mockRejectedValueOnce(new Error('404 Not Found'))
  expect(await pullPort(cli, '/tmp').branchHead('agent/y')).toBeUndefined()
})

it('reports an auto-merge request that the server named', async () => {
  const cli = commands()
  vi.spyOn(cli, 'run').mockResolvedValue(JSON.stringify({ state: 'open', draft: false, auto_merge: { enabled_by: { login: 'someone' } }, head: { ref: 'agent/x' }, base: { ref: 'main' } }))
  expect((await pullPort(cli, '/tmp').pull(7)).autoMerge).toBe(true)
})
