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

**The state at the end of 2026-11-01**: the Ticket `8b43e5eb` waits for the
operator's approval. Its manifest was built at the baseline commit `3297d39` and
names the writable paths `src/smoke.ts` and `tests/smoke.spec.ts`, the checks
`pnpm run typecheck` and `pnpm run test`, the tasks `T001` to `T005` with `T003`
as the human gate, and the environment digest `8947a897`. Its manifest digest was

```text
4f07f70b1d16583a225e56b7b2d65171a5abda4daaeb2afb6f6bc0fdd0005b1b
```

Every comment on issue #4 was deleted afterwards by the operator's own account, so
the issue is empty and the digest was never read there.

**The next step, in order:**

1. Post a request comment on **issue #4** of the fork:

   ```text
   @szocpaul-dsh-agent Run the approved feature specs/002-smoke-fixture with the Prime runner.
   ```

2. The worker calls `orchestrator_prime_request`, the controller builds the manifest
   and posts the digest. The operator approves that exact digest with a second
   comment, and the comment must be exactly one line:

   ```text
   @szocpaul-dsh-agent APPROVE RUN <the digest the system posted>
   ```

3. The runner performs the automatable tasks, stops at the `MANUAL GATE` task, and
   opens a **draft** pull request. Nothing is merged; `main` stays protected.

Post a **fresh** request rather than approving the digest above: the manifest names
its baseline commit, so a manifest built before a later commit is stale. The digest
changes with every commit, so always approve the digest the system posts.

**A known defect in the question text**: the Ticket asks the operator to approve
with `@<agent> APPROVE RUN <digest>`, and that `@<agent>` is a literal placeholder
that was never substituted with the agent's login. The approval comment must name
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
- **The worker prompt has a length budget** of 1000 characters and the worker session
  has a model budget of 40500. `tests/cards.spec.ts` and `tests/model-surface.spec.ts`
  enforce both, so keep new instructions in `prompts/work.md` and keep the worker
  prompt short.
- **`tests/sources.spec.ts` has one flaky test.** "takes in the event lines it reads"
  fails in a full run and passes alone; it is unchanged since the upstream commit.
  Treat it as known, not as a regression.

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
