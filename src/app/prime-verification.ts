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
import { cpSync, mkdirSync, mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import type { Commands } from '../infra/commands.ts'
import type { ApprovedCheck, ApprovedManifest, BridgeSegment, RunnerReport } from '../executor/prime-model.ts'
import { parseRunnerReport, REPORT_FILE } from '../executor/prime-report.ts'
import { assess, collectSnapshot, createResultRevision, rerunChecks, verify, type AssessHost, type RevisionPort, type VerifierPort } from '../executor/prime-verify.ts'

const exec = promisify(execFile)

/**
 * The environment the verifier runs in: nothing that names a credential, and a private home.
 *
 * The map is the whole environment of the check, not an addition to the environment of the controller: a check that
 * reruns an untrusted revision must not inherit the deployment's model key, its GitHub token, or the git identity
 * that points at the deployment's credential helper.
 */
export function verifierEnvironment(workspace: string): Record<string, string | undefined> {
  return {
    HOME: workspace,
    TMPDIR: join(workspace, 'tmp'),
    PATH: '/usr/local/bin:/usr/bin:/bin',
    LANG: 'C.UTF-8',
    CI: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    GIT_CONFIG_GLOBAL: undefined,
    GH_TOKEN: undefined,
    GITHUB_TOKEN: undefined,
  }
}

/**
 * Puts the checkout on the branch of the run.
 *
 * The branch of the run may not be in the checkout yet: the delivery creates it on the remote, and the human's gate
 * commit reaches the remote too. The remote is the truth about that branch, so it is asked first, and the local
 * branch follows it. A branch that exists nowhere is created at the current head, which is where the first delivery
 * publishes the result of the run.
 */
export async function checkoutRunBranch(git: (args: string[]) => Promise<string>, branch: string): Promise<void> {
  await git(['fetch', '--quiet', 'origin', branch]).catch(() => undefined)
  const remote = await git(['rev-parse', '--verify', `refs/remotes/origin/${branch}`]).catch(() => undefined)
  // The checkout holds the run's own result, and git refuses to switch branches over a change it would overwrite. The
  // result is committed on the branch of the run, so the working copy is set aside for the switch and taken back
  // afterwards: the changes that the branch already carries are the same, and the others stay the operator's.
  const stashed = await git(['stash', 'push', '--quiet']).then(() => true).catch(() => false)
  try {
    if (remote) {
      await git(['checkout', '-B', branch, `origin/${branch}`])
    } else {
      const local = await git(['rev-parse', '--verify', `refs/heads/${branch}`]).catch(() => undefined)
      if (local) await git(['checkout', branch])
      else await git(['checkout', '-b', branch])
    }
  } finally {
    if (stashed) await git(['stash', 'pop']).catch(() => undefined)
  }
}

/**
 * The repository adapter that creates the controller's commit of the approved result.
 *
 * The commit is created in the run's own workspace, on the branch of the run, and it holds only the files the
 * approved scope allows. The commit is local: pushing it is the delivery's own decision.
 */
export function revisionPort(commands: Commands, root: string, branch?: string): RevisionPort {
  return {
    async commit(input) {
      for (const file of input.files) {
        const target = join(root, file.path)
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, file.content)
      }
      const git = async (args: string[]) => (await commands.git(args, root)).trim()
      // The revision belongs to the branch of the run: the checkout may hold another branch, and the delivery
      // publishes the revision on the branch of the run, so the commit has to sit on it.
      if (branch) await checkoutRunBranch(git, branch)
      // The branch the checkout is on keeps no trace of the run's result: the commit is created, published under its
      // own name, and the branch returns to the baseline with the files in the working tree.
      const parent = await git(['rev-parse', 'HEAD']).catch(() => undefined)
      // A segment that only runs the checks and records the evidence changes no file, so there is nothing to stage
      // and no change to commit. The result is still a revision of its own, or the delivery would have nothing to
      // publish and the run would end without a result.
      if (input.files.length > 0) await git(['add', '--', ...input.files.map(file => file.path)])
      const args = ['-c', 'user.name=dsh-superagent', '-c', `user.email=${process.env.DSH_PRIME_COMMIT_EMAIL ?? 'dsh-superagent@users.noreply.github.com'}`, 'commit', '--no-verify', '--allow-empty', '-m', input.message]
      // The date of the commit is part of the commit, so it has to be fixed: the same result yields the same revision
      // every time, and a delivery that runs again finds the revision it published before.
      if (input.date) await commands.run('env', [`GIT_AUTHOR_DATE=${input.date}`, `GIT_COMMITTER_DATE=${input.date}`, 'git', ...args], root)
      else await git(args)
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
export function verifierPort(commands: Commands, root: string, storage = tmpdir()): VerifierPort {
  return {
    async run(check: ApprovedCheck, revision: string, environment) {
      // The scratch copy lives in the run's own storage: the temporary directory of the host is small, and the
      // dependencies of the project do not fit into it.
      const scratch = mkdtempSync(join(storage, 'prime-verify-'))
      try {
        const git = async (args: string[], cwd = scratch) => (await commands.git(args, cwd)).trim()
        await git(['init', '--quiet'], scratch)
        await git(['remote', 'add', 'origin', root], scratch)
        await git(['fetch', '--quiet', 'origin', revision], scratch)
        await git(['checkout', '--quiet', 'FETCH_HEAD'], scratch)
        const cwd = join(scratch, check.cwd || '.')
        mkdirSync(cwd, { recursive: true })
        // The check needs the project's own dependencies, and a fresh checkout has none: the verifier copies them from
        // the repository it checks out. A link is not enough: the package manager checks the state of the tree it
        // finds and refuses a linked one.
        const dependencies = join(root, 'node_modules')
        if (existsSync(dependencies)) cpSync(dependencies, join(scratch, 'node_modules'), { recursive: true, verbatimSymlinks: true })
        // The checkout holds no credential helper, so a check cannot reach GitHub even if it tried: an empty helper
        // resets the list the global configuration of the controller would otherwise add.
        await git(['config', '--local', '--unset-all', 'credential.helper'], scratch).catch(() => undefined)
        await git(['config', '--local', 'credential.helper', ''], scratch).catch(() => undefined)
        // The private temporary directory of the check has to exist: the environment names it, and a tool that writes
        // into it fails when the directory is missing.
        const temporary = environment.TMPDIR
        if (temporary) mkdirSync(temporary, { recursive: true })
        const [program, ...args] = check.argv
        if (!program) throw new Error('the check names no program')
        // The check runs with the audited environment alone: the environment of the controller never reaches it.
        const result = await exec(program, args, { cwd, env: environment as NodeJS.ProcessEnv, timeout: check.timeoutMs })
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
  // The revision belongs to the branch of the run, so the commit is created there.
  const committer = revisionPort(commands, root, segment.runner.branch)
  // The verifier keeps its scratch copy in the run's own storage, so the check does not fill the small temporary
  // directory of the host.
  const verifier = verifierPort(commands, root, storage)
  const environment = verifierEnvironment(storage)
  const resultRevision = await createResultRevision(snapshot, manifest.allowedPaths, committer, segment.createdAt)
  const checks = await rerunChecks(manifest.checks, resultRevision, verifier, environment)
  const assessment = assessHost ? await assess(manifest, segment, 1, assessHost) : undefined
  return verify({
    manifest, segment, report, workspace: root, commands, verifier, environment,
    committer,
    assessment,
  })
}
