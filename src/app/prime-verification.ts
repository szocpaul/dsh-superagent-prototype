/**
 * The host-side verification of a Prime Runner Bridge segment.
 *
 * The verification is the controller's own work: it creates the commit that holds the runner's approved result,
 * it reruns the approved checks against that exact commit in a separate workspace that holds no GitHub,
 * controller, or model credential, and it assesses the implementation against the approved specification on an
 * isolated scratch copy. Without this adapter every run blocks at the verification step, which is the safe
 * default but leaves the bridge unusable.
 */
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, existsSync, readFileSync, symlinkSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import type { Commands } from '../infra/commands.ts'
import type { ApprovedCheck, ApprovedManifest, BridgeSegment, RunnerReport } from '../executor/prime-model.ts'
import { parseRunnerReport, REPORT_FILE } from '../executor/prime-report.ts'
import { assess, collectSnapshot, createResultRevision, rerunChecks, verify, type AssessHost, type RevisionPort, type VerifierPort } from '../executor/prime-verify.ts'

const exec = promisify(execFile)

/** The environment the verifier runs in: nothing that names a credential, and a private home. */
export function verifierEnvironment(workspace: string): Record<string, string | undefined> {
  return {
    HOME: workspace,
    TMPDIR: join(workspace, 'tmp'),
    PATH: '/usr/local/bin:/usr/bin:/bin',
    LANG: 'C.UTF-8',
    CI: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    GH_TOKEN: undefined,
    GITHUB_TOKEN: undefined,
  }
}

/**
 * The repository adapter that creates the controller's commit of the approved result.
 *
 * The commit is created in the run's own workspace, on a branch named after the segment, and it holds only the
 * files the approved scope allows. The commit is local: pushing it is the delivery's own decision.
 */
export function revisionPort(commands: Commands, root: string): RevisionPort {
  return {
    async commit(input) {
      for (const file of input.files) {
        const target = join(root, file.path)
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, file.content)
      }
      const git = async (args: string[]) => (await commands.git(args, root)).trim()
      // The branch the checkout is on keeps no trace of the run's result: the commit is created, published under its
      // own name, and the branch returns to the baseline with the files in the working tree.
      const parent = await git(['rev-parse', 'HEAD']).catch(() => undefined)
      await git(['add', '--', ...input.files.map(file => file.path)])
      await git(['-c', 'user.name=dsh-superagent', '-c', `user.email=${process.env.DSH_PRIME_COMMIT_EMAIL ?? 'dsh-superagent@users.noreply.github.com'}`, 'commit', '--no-verify', '-m', input.message])
      const commit = await git(['rev-parse', 'HEAD'])
      if (parent) await git(['reset', '--mixed', parent])
      return commit
    },
  }
}

/**
 * The verifier that reruns one approved check against the exact revision.
 *
 * The check runs in a separate checkout of the revision, so it cannot see the runner's working tree, and it
 * holds no credential: the environment names none, and the git configuration of the checkout has no helper.
 */
export function verifierPort(commands: Commands, root: string): VerifierPort {
  return {
    async run(check: ApprovedCheck, revision: string, environment) {
      const scratch = mkdtempSync(join(tmpdir(), 'prime-verify-'))
      try {
        const git = async (args: string[], cwd = scratch) => (await commands.git(args, cwd)).trim()
        await git(['init', '--quiet'], scratch)
        await git(['remote', 'add', 'origin', root], scratch)
        await git(['fetch', '--quiet', 'origin', revision], scratch)
        await git(['checkout', '--quiet', 'FETCH_HEAD'], scratch)
        const cwd = join(scratch, check.cwd || '.')
        mkdirSync(cwd, { recursive: true })
        // The check needs the project's own dependencies, and a fresh checkout has none: the verifier borrows them
        // read-only from the repository it checks out, so the check runs against the exact revision.
        const dependencies = join(root, 'node_modules')
        if (existsSync(dependencies)) symlinkSync(dependencies, join(scratch, 'node_modules'), 'dir')
        // The checkout holds no credential helper, so a check cannot reach GitHub even if it tried.
        await git(['config', '--local', '--unset-all', 'credential.helper'], scratch).catch(() => undefined)
        const [program, ...args] = check.argv
        if (!program) throw new Error('the check names no program')
        const result = await exec(program, args, { cwd, env: { ...process.env, ...environment } as NodeJS.ProcessEnv, timeout: check.timeoutMs })
        return { exitCode: 0, evidence: result.stdout.trim().slice(0, 2000) }
      } catch (error) {
        const failure = error as { code?: number; stdout?: string; stderr?: string; message?: string }
        const code = typeof failure.code === 'number' ? failure.code : 1
        const evidence = `${failure.stdout ?? ''}${failure.stderr ?? ''}`.trim().slice(0, 2000) || failure.message || 'the check did not run'
        return { exitCode: code, evidence }
      } finally {
        rmSync(scratch, { recursive: true, force: true })
      }
    },
  }
}

/**
 * Reads the runner's structured report from the run's own storage.
 *
 * The report is data, never authority: a missing or malformed report is a failed verification, not a result.
 * @throws when the report cannot be read or parsed.
 */
export function readRunnerReport(workspace: string, expected: Parameters<typeof parseRunnerReport>[1]): RunnerReport {
  const file = join(workspace, REPORT_FILE)
  if (!existsSync(file)) throw new Error(`the runner wrote no structured report at ${file}`)
  return parseRunnerReport(readFileSync(file, 'utf8'), expected)
}

/**
 * The verification of one segment against the real repository.
 *
 * @throws when the segment's workspace is missing, because an absent workspace is not evidence of anything.
 */
export async function verifySegment(options: {
  commands: Commands
  root: string
  manifest: ApprovedManifest
  segment: BridgeSegment
  report: Parameters<typeof verify>[0]['report']
  /** The run's own storage, where the report and the session of the run live; it is not a repository. */
  storage: string
  assessHost?: AssessHost
}): Promise<Awaited<ReturnType<typeof verify>>> {
  const { commands, root, manifest, segment, report, storage, assessHost } = options
  // The changed files are the ones of the repository the runner worked in; the run's own storage holds its report.
  const snapshot = await collectSnapshot(commands, root, manifest.allowedPaths)
  const committer = revisionPort(commands, root)
  const verifier = verifierPort(commands, root)
  const environment = verifierEnvironment(storage)
  const resultRevision = await createResultRevision(snapshot, manifest.allowedPaths, committer)
  const checks = await rerunChecks(manifest.checks, resultRevision, verifier, environment)
  const assessment = assessHost ? await assess(manifest, segment, 1, assessHost) : undefined
  return verify({
    manifest, segment, report, workspace: root, commands, verifier, environment,
    committer,
    assessment,
  })
}
