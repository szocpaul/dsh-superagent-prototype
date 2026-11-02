# Repository Guidance

This repository is the **dsh-superagent** research prototype with the **Prime Runner
Bridge** on top of it. The bridge lets an authorized dsh-superagent Ticket hand one
bounded, already approved specification to a supervised Prime Agent runner, stop at a
human gate, and deliver an independently verified pull request.

Read this file first. It says where the work stands, how the local deployment is
wired, and what is still missing.

## Where the work stands

The design phase is **closed and approved**: the constitution, the specification, the
plan, the research notes, the data model, the bridge contract and the task list live
under `specs/001-prime-runner-bridge/`. Of the 56 tasks, **53 are complete**; the
three that remain are the disposable smoke and its two follow-ups:

| Task | What it is |
| --- | --- |
| T054 | The MANUAL GATE: the operator's approval for a disposable real-backend and GitHub smoke |
| T055 | The approved end-to-end smoke itself |
| T056 | The bounded spec coverage assessment |

The implementation is **not** in production. It is a research prototype, and the
bridge has never completed a live run. Everything that follows assumes that.

The bridge itself now works up to the approval: the worker calls
`orchestrator_prime_request`, the controller builds the manifest and the Ticket
waits for the operator. What is still unproven is the run behind that approval,
the human gate, the stop and the recovery.

## The disposable smoke: what is running and what is next

The smoke runs against `szocpaul/dsh-superagent-prototype` (this repository) with
the disposable feature `specs/002-smoke-fixture`. The plan is in
`specs/001-prime-runner-bridge/t054-plan.md`; the operator's steps are in
`specs/001-prime-runner-bridge/operator-steps.md`.

**The state at the end of 2026-11-02 (evening)**: the smoke has found and fixed
**fourteen** defects in the bridge's runner launch path, which had never been
exercised. The whole chain now works up to the delivery:

- the controller side works: request, manifest, digest, approval, reservation,
  preflight, launch, barrier, reconcile, report, verification;
- the runner side works: it starts in the confinement, sets its kernel up, writes
  the two approved files, leaves the gate untouched, and writes its report;
- the **verification passes**: both approved checks exit 0 against the candidate
  revision, the scope audit is clean, and the verdict is `ready`;
- the **delivery** was fixed last (it asked for the protection of the branch that
  does not exist yet, and read the server's answer in the wrong shape) and is
  deployed, but no run has completed it yet.

The runner slot is free, the service runs, and the last worker is diagnosing the
known flaky test in `tests/sources.spec.ts` instead of building the manifest. The
next run needs the operator's approval of the digest the system posts, and the
gate after it.

**Following a run.** The operator reaches the panel through an SSH tunnel over the
tailnet, not through a proxy: `ssh -N -L 3082:127.0.0.1:3082 ubuntu@100.118.113.57`,
then `http://127.0.0.1:3082/?token=<token>` (the token is in the newest log under
`.artifacts`). The local port must be 3082, because the management routes accept
only that host. The state of the runs is also on the host: `prime-run-watch` prints
the bridge's segments, the barrier, the quota and the cgroup of the run, and
`prime-run-watch -f` follows the runner's live transcript. The API answers
`http://127.0.0.1:3082/orchestrator/api/overview` with the header
`x-orchestrator-request: 1`.

**Do not write the digest down.** The manifest names its baseline commit, so every
commit invalidates it. Read the digest the Ticket's question names, in the panel or
in the comment the system posts on the issue.

**The next step, in order:**

1. The operator approves the digest the system posted on **issue #4** with a
   comment that is exactly one line:

   ```text
   @szocpaul-dsh-agent APPROVE RUN <the digest the system posted>
   ```

2. The runner performs the automatable tasks, stops at the `MANUAL GATE` task, and
   opens a **draft** pull request. Nothing is merged; `main` stays protected.

3. The gate asks its own question. The operator answers it in two steps: tick the
   gate's checkbox in the approved task list with a GitHub-authenticated edit under
   their own identity, then reply with
   `@szocpaul-dsh-agent APPROVE GATE <gate> <digest> <full-gate-commit-sha>`.

If the digest is gone or the service is down, start over with a request comment on
issue #4:

```text
@szocpaul-dsh-agent Run the approved feature specs/002-smoke-fixture with the Prime runner.
```

Approve only the digest the system posts: the manifest names its baseline commit,
so a manifest built before a later commit is stale. The digest changes with every
commit, so a digest from an earlier run is never the one to approve.

The question names the agent account, so the approval comment must mention
`@szocpaul-dsh-agent`; the parser accepts no other form.

## The local deployment

- **DeepSeek Harness host**: `@deepseek-ai/dsh` 0.2.1-rc.3, installed globally.
- **Profile**: `superagent`, with its own state directory, the webserver on
  `127.0.0.1:3082`, and this bundle linked from the checkout.
- **Service**: `python3 scripts/dsh-superagent start | stop | restart | status`. The
  status exits 0 while the service runs normally.
- **Profile configuration**: `~/.dsh/profiles/superagent/cordis.patch.yml`. The
  main Session's model is an OpenAI-compatible route served by
  `@deepseek-ai/dsh-llm-pi-ai`, with the key named by an environment variable and
  never written into a file.
- **Deployment environment**: `.artifacts/control/profiles/superagent/prime.env` in
  this repository holds the bridge's model, quota thresholds and commands. It is
  machine state, not part of the repository, and the keys in it are secrets.
- **Models**: `minimax` / `MiniMax-M3.1-Flash` for both the main Session and the
  worker. The `commandcode` route was removed: its token had expired.
- **Identities**: the controller acts as the GitHub account `szocpaul-dsh-agent`,
  which holds `push` access only. The operator's own account `szocpaul` is the only
  allowlisted account and performs every approval and every merge.

## The GitHub CLI

`gh` 2.103.3 is first on the user's path, installed from the official release. The
system package at `/usr/bin/gh` is 2.46 and is too old: the source reads paged
responses with `--slurp`, which needs 2.47 or later.

The agent's own CLI is the `gh-agent` wrapper, which points `GH_CONFIG_DIR` at a
separate configuration:

```sh
GH_CONFIG_DIR="$HOME/.config/gh-agent" exec gh "$@"
```

Git commands that must act as the agent need the same identity:

```sh
GIT_CONFIG_GLOBAL="$HOME/.config/gh-agent/gitconfig" GIT_CONFIG_NOSYSTEM=1 git push
```

## Things that cost time, and the reason for each

- **`ps` reports the thread name here.** A Node service appears as `MainThread` in
  `ucomm`, not as `node`. The service script decides from the command line when the
  name is not recognizable; `tests/service-script.spec.ts` proves it.
- **A key with spaces or slashes breaks `export`.** The deployment environment file
  quotes every value. A key that is a shell command, such as `!cat <file>`, is not a
  key at all.
- **The manifest builder read the plan's documentation tree.** Every plan proposed no
  writable path. It now reads the source-code block; `tests/prime-plan-paths.spec.ts`
  proves it.
- **The manifest names the repository by its numeric id.** A placeholder of `0` was
  refused by the schema, so no digest could be prepared. Both the manifest and the
  approval evidence now read the real id.
- **The approval effect must wait for the human.** It now waits instead of
  completing, so a run still starts when the operator answers, and a refusal ends it.
  A denial is recorded by `denyRun` with the same evidence checks as an approval, and
  the Ticket is reported as blocked rather than left waiting forever.
- **The approval question named a placeholder.** It asked for
  `@<agent> APPROVE RUN <digest>` without substituting the agent's login, so the
  operator could not have answered from the notice alone. Both the run question and
  the gate question now name the account; `tests/prime-question-mention.spec.ts`
  proves it.
- **The worker prompt has a length budget** of 1000 characters and the worker session
  has a model budget of 40500. `tests/cards.spec.ts` and `tests/model-surface.spec.ts`
  enforce both, so keep new instructions in `prompts/work.md` and keep the worker
  prompt short.
- **A restart from inside the worker session can leave the service down.** The
  worker started `scripts/dsh-superagent restart` as a background job; the stop
  ended the worker's own session before the start phase ran, so the tmux session
  was gone and the Ticket waited with no digest. Check
  `python3 scripts/dsh-superagent status` first; start the service by hand if it
  is down.
- **An issue comment is served under `repos/<owner>/<repo>/issues/comments/<id>`.**
  The route that carries the issue number answers 404 for every comment, and the
  approval evidence was read from there, so a manifest the operator had approved
  waited forever.
- **The run's socket has to live in the account's own runtime directory.** The
  system runtime directory (`/run`) belongs to root, and the unprivileged
  deployment account cannot create a directory under it.
- **The cgroup of a run is removed with its unit.** The unit is created with
  `--collect`, so after the run's service ended, its cgroup was gone and the
  bridge could not prove that the run had ended: the stop stayed unconfirmed, the
  segment kept the single runner slot, and no further run could start. A cgroup
  that does not exist holds no process.
- **The run reaches the model with the network and one credential.** On 2026-11-02 the
  operator chose this for the smoke: the manifest names the endpoint
  (`DSH_PRIME_ENDPOINTS`), the confinement keeps the host's resolver, and the run
  receives the credential the deployment names (`DSH_PRIME_CREDENTIAL_ENV`). The
  endpoint allowlist is a record the operator approved, not a filter the kernel can
  enforce, and the residual risk is disclosed in the report.
- **The runner's prompt never reached the runner.** The launch carried only a one
  line goal, so the runner knew neither the specification nor the barrier nor the
  report. The prompt is now part of the invocation.
- **A worker session can end on its model budget.** The session stopped with
  `max-tokens` in the middle of a repair and left the Ticket with a stale
  `running` assignment; the panel's retry is refused when the last assignment
  reported nothing, so the operator stops the Ticket and posts a fresh request.
- **The confinement had none of the run's own tools.** The runner's command, the
  commands of the approved checks and the tool that sets the runner's kernel up
  were all outside the confinement, and the manifest's isolation named no writable
  path at all, so the checkout was read-only and the runner could not write the
  files it was asked to write. The manifest now carries the approved scope as its
  writable scope, and the plan binds the resolved commands read-only.
- **The runner's own home is masked, so the run needs its own configuration.**
  The runner reads its providers from its home; without a configuration of its own
  it fell back to the definition it ships with, which names another endpoint, and
  the model call failed. The controller writes the approved provider and model into
  the run's own home, with the credential named by its environment variable and
  never by its value.
- **The installed runner does not announce its session identity.** The supervisor
  read it from the runner's output, so the barrier that releases the runner was
  never written and the run waited for a decision that could not arrive. The
  runner names its session file after the session, so the supervisor looks in the
  run's own session directory as well.
- **The runner's kernel takes longer than the identity timeout.** The kernel is set
  up from scratch on the first run of a segment, which takes longer than the wait
  the supervisor allowed, so the run was killed while it was still starting.
- **The runner ran outside the cgroup of its own run.** The run's stop could not
  reach it, and the placeholder of the service unit made the cgroup look busy
  after the runner had died. The runner joins the cgroup of its run, and the
  liveness of a run counts the processes of the run and not the placeholder.
- **The checkout holds the deployment's own secrets.** The machine state of the
  repository carries the deployment's credentials, so the confinement masks it.
- **The verifier inherited the controller's whole environment**, and with it the
  agent's GitHub credential helper: the verifier held a GitHub credential, which
  the contract forbids, and two tests failed because of the inherited variable.
  The verifier's check now runs with a complete, minimal environment of its own.
- **The verifier ran its checks on the host's small temporary filesystem**, where
  the project's dependencies do not fit. The scratch copy of a check now lives in
  the run's own storage. The package manager also refuses a linked dependency
  tree, so the verifier copies the dependencies instead of linking them.
- **The delivery asked for the protection of the branch that does not exist yet**,
  and read the server's answer in the wrong shape, so every run ended with an
  unknown remote outcome. The merge rights that matter are the ones of the branch
  the pull request lands on.
- **A run that ends is noticed by a reconciliation, not by the runner.** The bridge
  reconciled only at startup, so a finished run waited for the next restart, and
  the reconciliation never read the report the runner had written.
- **A ticket whose segment was stopped could not run again**, because the approval
  effect treated every segment that was not blocked as a run in flight.
- **The runner cannot compute a digest over the whole workspace**, because that
  algorithm belongs to the controller. The contract now says that the report names
  the files the runner changed and the SHA-256 of each of them, and the controller
  derives the same list from the workspace's own version control and compares
  every path and every digest.
- **The run's checkout is the repository itself.** The scope audit reads the
  working tree of the checkout, so an edit that the bridge's own development makes
  during a live run is a write outside the approved paths, and the run is blocked
  for it. The bridge's own fixes therefore belong to a commit made before the run
  starts, never during one. The worker-agent's own commit lands in the same
  checkout, so the same rule applies to it.
- **The controller's identity cannot read the detailed protection rules of a
  branch.** They need administrative access, which the controller deliberately
  does not have, so the server answers 404 and every delivery ended with an
  unknown remote outcome. The merge guard is proven from what the controller's own
  identity may do: the target branch carries a protection rule, and the
  controller can neither administer nor maintain the repository.
- **A gate commit's parent is the revision the controller published.** The segment's
  own baseline is the revision from before the run, and a gate commit sits on the
  branch of the run, so its parent is the published result revision. The segment
  never carried a baseline revision at all, so the gate expected the parent of a
  gate commit to be the empty string, and no commit could ever satisfy it.
- **A verified gate decision must be recorded before the continuation.** The bridge
  verified the human's gate decision and then dropped it: the record was never
  stored, so the continuation found no decision and the segment waited at the gate
  forever. The refusal was silent, because the lookup swallowed the reason, so the
  only way to see it was to patch the built bundle and read what the running
  service wrote. The decision is recorded now, a repeated poll answers with the
  record it already made, and `tests/prime-run-request.spec.ts` proves it.
- **The gated segment must release the runner slot before the continuation takes
  it.** The segment ended after the continuation had tried to reserve the slot, so
  the reservation failed and the run waited at the gate again. The segment now ends
  first, in the same transaction that reserves the slot for the continuation.
- **A gate counts as complete once the human's commit changed its checkbox.** The
  task list of a manifest carries no checkbox state, so the continuation was
  refused with "the human has not marked the gate complete" even though the gate
  commit had changed exactly that line.
- **The Feishu consumer's health had one race.** The consumer's ready report and
  the error a malformed event reports arrive on two streams in either order, and the
  ready report could erase the error. The consumer keeps the error now, and
  `tests/sources.spec.ts` proves it.

## What the workers may and may not do

The DSH worker is an agent with the operator's file and shell access, and it acts
through the agent's GitHub identity. It found and fixed three real defects during
the smoke: the plan scope parser, the placeholder repository id and the approval
effect that lost the run. That is useful, and it is also a reminder:

- The worker may change the bridge's own code when the task needs it, but the
  change belongs in its own commit with a test, and `pnpm check` has to pass.
- The worker restarts the service to deploy its change, and that restart ends the
  worker's own session. Expect the Ticket to resume with a recovery note.
- The worker must not touch anything outside the task's scope, and it must never
  close the issue or delete the operator's comments.
- A worker that fixes the bridge in the middle of a smoke run has moved beyond the
  run's scope. Say so in the report rather than letting the two blend.

## Rules for the work in this repository

- The constitution in `.specify/memory/constitution.md` governs: authorized work,
  human control, honest status, minimal attention, explicit security boundaries and
  verifiable changes.
- **Write the project artifacts in English.** The operator reads Hungarian; the code,
  the documents and the reports are English.
- Every behaviour change needs a test, and the full `pnpm check` has to pass.
  `pnpm exec vitest run tests/prime-*.spec.ts` is the fast suite for the bridge.
- A `MANUAL GATE` in any task list belongs to a person. Never tick one, never work
  around one, and never let an agent mark a gate complete.
- The bridge's write scope is a hard boundary, not a hint. The isolation lives in
  `bubblewrap` with a private home, a masked `/tmp`, a private daemon socket and a
  delegated service cgroup; the workspace, the credential wrappers and the prompts
  are not a sandbox.
- Never merge a pull request and never enable auto-merge. The protected `main`
  refuses the agent account anyway; that refusal is a control, so keep it.
- The operator's approval is bound to one exact manifest digest and is re-checked at
  launch, at every continuation and before delivery.

## Where the evidence is

| What | Where |
| --- | --- |
| The approved specification | `specs/001-prime-runner-bridge/spec.md` |
| The plan and the design decisions | `specs/001-prime-runner-bridge/plan.md`, `research.md` |
| The protocol the bridge implements | `specs/001-prime-runner-bridge/contracts/bridge.md` |
| The task list and its state | `specs/001-prime-runner-bridge/tasks.md` |
| The proven host mechanisms | `specs/001-prime-runner-bridge/runtime-report.md` |
| The autonomous run's report | `specs/001-prime-runner-bridge/runner-report.md` |
| The smoke plan and the operator's steps | `specs/001-prime-runner-bridge/t054-plan.md`, `operator-steps.md` |
| The disposable feature | `specs/002-smoke-fixture/` |
| The bridge's own modules | `src/executor/prime-*.ts`, `src/app/prime-*.ts`, `src/infra/prime-isolation.ts` |
