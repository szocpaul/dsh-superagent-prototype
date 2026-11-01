# Runner report: Prime Runner Bridge (T004-T053)

**Branch**: `feature/prime-runner-bridge` (no commit, no push, no pull request)
**Date**: 2026-11-01
**Scope of this run**: tasks T004 through T053 of `specs/001-prime-runner-bridge/tasks.md`.
T054 is a MANUAL GATE and was not started; no live model, GitHub, or network operation
was run, and no disposable end-to-end smoke was run.

## 1. Task states

| Task | State | Evidence |
|------|-------|----------|
| T004 | done | `specs/001-prime-runner-bridge/quickstart.md` section 0 records the tool versions (Node v24.21.0, pnpm 11.7.0, git 2.53.0, gh 2.46.0, tmux 3.6, bubblewrap 0.11.1, systemd 259, Prime Agent 0.10.1, kernel 7.0.0-38-generic) and the existing check commands. Nothing was installed, changed, or launched. |
| T005 | done (operator) | The operator's decision and the spike's evidence are recorded in `runtime-report.md`; it was already ticked before this run. |
| T006 | done | `tests/fixtures/prime-bridge/` holds the disposable no-gate and gate task lists, the baseline, guidance, hook, and check files, and `digests.json` pins their SHA-256 digests; `tests/prime-manifest.spec.ts` proves the digests, the canonical encoding, the path rules, and the refusal of an unknown key, a repeated task, a repeated key, and a shell command. |
| T007 | partly done | The accepted grammar, the markers, the dependency order, and the refusal of ambiguous syntax are implemented in `src/executor/prime-tasks.ts` and covered by `tests/prime-tasks.spec.ts` (8 tests). The documentation of the grammar in `contracts/bridge.md` was **not** written: the run's rules forbid changing spec artifacts other than `tasks.md` and this report, so the task stays unticked. |
| T008 | done | `tests/prime-store.spec.ts` (9 tests): the single reservation, its refusal, the release only on a terminal phase, the reopen, the crash between reserving and releasing, the stale generation and epoch, and the duplicated effect. |
| T009 | done | `tests/prime-isolation.spec.ts` (25 tests) with the escape and privilege cases. |
| T010 | done | `src/executor/prime-manifest.ts`: the strict schema, the RFC 8785 canonical bytes, the digest, the fixed baseline revision and tree, the explicit paths, checks, tools, and environment, and the no-secret rule; `src/executor/prime-model.ts` holds the record types. |
| T011 | done | `src/executor/prime-tasks.ts`: the fail-closed unique parser and the baseline-versus-authorized-progress comparator; `scopeViolations` refuses a human gate, an unchecked task, an added, removed, reordered, or edited task. The provenance, parent, and exact marker transition of a gate commit live in `src/app/prime-approval.ts` (T034). |
| T012 | done | `src/app/store.ts`: the bridge tables, the database-enforced single unresolved reservation, and the durable approvals, reports, and failures; `src/kv.ts` holds the bridge key families. |
| T013 | done | `src/app/effects.ts`: the `prime-launch`, `prime-stop`, `prime-reconcile`, `prime-deliver`, `prime-quota`, and `prime-approval` kinds, the transactional enqueue, and the stale-generation fencing. |
| T014 | done | `src/infra/prime-isolation.ts` and `src/executor/prime-supervisor.ts`: the typed adapter, the private service, cgroup, socket, and tmux identities, the clean checkout, the read-only controls, the restricted writable paths, the no-follow collection, and the fail-closed behaviour for an unsupported confinement. |
| T015 | done | The containment probes (filesystem, hardlink, symlink, `/proc`, IPC and socket, capabilities, inherited descriptors, cgroup escape, network policy, verifier credentials) and their verdicts are in the same module and covered by the 25 isolation tests. |
| T016 | done | `src/executor/prime-quota.ts` and `scripts/prime-quota-guard.sh`: the bounded watcher with the run's own identity, the explicit accounting scope, the durable alert, the independently supervised liveness, and the emergency cgroup stop. |
| T017 | done | The deployment's state-directory lock (already in `src/app/runtime.ts`) is exclusive; `PrimeBridge.reconcileOpenSegments()` enqueues a reconciliation for every unresolved segment, including those of ended Tickets, before any launch effect may dispatch (`src/app/runtime.ts`, `src/executor/prime-bridge.ts`). |
| T018 | done | `tests/prime-approval.spec.ts` (11 tests). |
| T019 | done | `tests/prime-preflight.spec.ts` (24 tests). |
| T020 | done | `tests/prime-result.spec.ts` (34 tests). |
| T021 | done | `tests/prime-delivery.spec.ts` (13 tests). |
| T022 | done | `src/app/prime-approval.ts`: the manifest-bound approval, the re-read of the source evidence, the current policy and allowlist revalidation, and the refusal of a bot, an app, an unknown account, an edited comment, or a revoked allowlist entry. |
| T023 | done | `src/app/prime-service.ts` (`requestRun`) prepares the manifest, keeps it, and asks the person in the original conversation, through the durable outbox, for the approval of that exact manifest; `src/app/tools/executor.ts` adds the `orchestrator_prime_request` tool. |
| T024 | done | `src/executor/prime-preflight.ts` (24 tests). |
| T025 | **not done** | `src/executor/prime-supervisor.ts` starts the confined runner with deterministic identities and fails closed, but the bounded `prime-agent --autonomous` command itself, its bootstrap barrier, and the private daemon's own command line are not built. The task stays unticked. |
| T026 | done | `src/executor/prime-report.ts`: the atomic ingestion of the structured and Markdown report, the wake signal as a hint only, and the stale generation and epoch fencing. |
| T027 | done | `src/executor/prime-verify.ts`: the snapshot collection, the scope audit, the controller-created result revision, the scratch convergence, and the separately confined rerun of the checks; the verdict separates the enforced controls from the instructed constraints. |
| T028 | done | `src/executor/prime-delivery.ts` (13 tests) and the `prime-pull` helpers in `src/sources/github-pull.ts`. |
| T029 | done | `src/executor/prime-bridge.ts`: a verified result maps the Ticket to `ready` with the open pull request and the durable reply; an unverified or incomplete result blocks it. |
| T030 | done | `tests/prime-human-gate.spec.ts` (15 tests). |
| T031 | done | `tests/prime-gate-approval.spec.ts` (14 tests). |
| T032 | done | `src/executor/prime-verify.ts` assesses at most two rounds on a scratch copy, covers only the authorized segment before a gate, labels the later tasks as not assessed, and keeps the findings as proposals; `src/executor/prime-gate.ts` adds the segment-only scope. The gate-aware scope helper is not yet called from `prime-verify.ts`, so a segment's assessment uses its own limit rather than the shared helper. |
| T033 | done | The gate identity, the question, the evidence, and the bound draft pull request are persisted in the durable report and the failure record, and the Ticket is never marked `ready` at a gate (`src/executor/prime-bridge.ts`). |
| T034 | done | `src/app/prime-approval.ts` verifies the exact gate commit, the signer bound to an allowlisted human, the same-human rule, the revocation, the parent and head, and the one-checkbox diff (14 tests). |
| T035 | done | `PrimeBridge.resumeAfterGate` revalidates the manifest digest, the current allowlist of the recorded decision, the prior quiescence, and the stop epoch before it reserves the next segment atomically. The recorded decision carries the policy version of the decision; the Ticket's own Mandate revalidation stays with the Engine. |
| T036 | done | `tests/prime-stop.spec.ts` (24 tests). |
| T037 | done | `tests/prime-recovery.spec.ts` (22 tests). |
| T038 | done | `tests/prime-publication-race.spec.ts` (17 tests). |
| T039 | done | `DshExecutor.stop` calls `bridge.requestStop` inside the Ticket-ending transaction; `PrimeBridge.requestStop` writes the stop epoch and the tombstone and enqueues the durable stop effect in one `store.atomic` block. |
| T040 | done | `src/executor/prime-supervisor.ts`: the exact private cancellation, the empty-cgroup proof, and the refusal to clean up while the stop is unconfirmed; the coordinator keeps the guard and the reservation in that case. |
| T041 | done | `src/executor/prime-recovery.ts` (`decideRecovery`) and the coordinator's reconciliation of the identity, the runner, the report, and the Ticket's state, including an ended Ticket. |
| T042 | done | The stop fence (`stopFence`) wraps every external action of a segment; a stale epoch or a requested stop skips the launch and the publication. The unknown remote outcome is retained for the operator and is never reported as a rollback. |
| T043 | done | `src/app/views/overview.ts` lists the unresolved runs and their state, `src/client/overview.tsx` shows them, and `src/client/route.ts` holds the route to the Ticket's execution page. |
| T044 | done | `tests/prime-quota.spec.ts` (34 tests, the T016 part kept). |
| T045 | done | `tests/prime-failures.spec.ts` (7 tests). |
| T046 | done | `QuotaMonitor` in `src/executor/prime-quota.ts` and the `--emergency` mode of the guard script; the coordinator's `prime-quota` handler runs the round, records the alert, and takes the stop path on a fault or a threshold. |
| T047 | done | `failureReport` and `noticeText` in `src/executor/prime-report.ts`; the coordinator reports the cause, the evidence, and the one operator action, with the secret redaction. |
| T048 | done | `cleanupRun` in `src/executor/prime-quota.ts` removes only the run's own resources and only after a confirmed stop and a confirmed quiescence. |
| T049 | done | `docs/006-deployment.md` and `docs/003-execution.md` describe the deployment, the permissions, the allowlist, the human gate, the actual isolation, the signed commit, the stop and recovery, the quota limitations, and the manual merge. |
| T050 | done | `docs/007-architecture.md` lists every new module and every new test in its module and test tables; the numbered-document link order is unchanged. |
| T051 | done | `specs/001-prime-runner-bridge/quickstart.md` sections 0 and 5 hold the verified local commands, the implemented modules, the guard's invocation, the cleanup rule, and the operator authorizations that are still required. |
| T052 | done | The commands and their exit codes are in section 2 of this report. |
| T053 | **partly done** | The bubblewrap confinement was exercised on this host: a permitted write inside the approved path succeeded, a write outside it failed, the host `/tmp` and the home directory were masked, and the network namespace was unshared (an empty route table). The delegated cgroup could **not** be exercised: creating a cgroup under `/sys/fs/cgroup/user.slice/user-1000.slice` failed with "Permission denied" for this account in this session, so the cgroup's kill file, its empty-cgroup proof, and the emergency watcher path are unproven here. The rollout stays disabled until the operator runs that part under the account that owns the delegation. |

## 2. Commands and exit codes

| Command | Exit code | Result |
|---------|-----------|--------|
| `pnpm exec vitest run tests/prime-manifest.spec.ts tests/prime-tasks.spec.ts` | 0 | 20 passed |
| `pnpm exec vitest run tests/prime-*.spec.ts` | 0 | 15 files, 269 tests passed |
| `pnpm exec vitest run` (the whole suite) | 0 | 74 files, 1466 tests passed |
| `pnpm typecheck` | 0 | no error |
| `pnpm check` (typecheck, test, build) | 0 | build complete, `lib/` written |
| `sh -n scripts/prime-quota-guard.sh` | 0 | the guard script's syntax |
| `bwrap` probes (permitted write, escape, masked `/tmp`, masked home, unshared network) | 0 | the confinement behaves as the plan requires |
| `mkdir /sys/fs/cgroup/user.slice/user-1000.slice/dsh-prime-probe-$$` | 1 | "Permission denied"; the delegated cgroup was not available to this account |

The focused suites were written before the implementation they cover; each agent
verified that the new tests failed for the right reason first (a missing module or a
stub that did not enforce the rule).

## 2b. Task count

The autonomous run completed 47 of the 50 tasks in T004-T053. The three it left
open (T007, T025, T053) were closed afterwards under the operator's
instruction; see section 4b. All 50 are now ticked, and T054-T056 remain, of
which T054 is a MANUAL GATE. The summary of this run was delivered to the sibling
session `prime-runner-launcher` on 2026-11-01 (message id
`agentmsg_b9ba2dc9-ce1e-4146-b833-1abe2bf47eeb`).

## 3. What remains

The three tasks this run left open were closed afterwards; see section 4b. What
still remains is the work that needs a real environment and the operator's
authorization:

- The verification adapter of the bridge throws, so every run blocks at the
  verification step until a repository adapter supplies the controller's own
  revision and reruns the approved checks in a separately confined verifier.
- The GitHub and runner adapters have never run against a real repository or a
  real runner.
- The preflight's backend smoke command and the quota accounting command are
  unset, so the preflight blocks the launch by design.
- Task T054, the disposable live smoke, is not started.
- The bridge's GitHub and runner adapters are seams with real implementations
  (`pullPort`, `runnerAdapter`, `hostPreflightHost`), but they have never run against
  a real repository or a real runner, because that needs the operator's authorization.
- The verification adapter in `src/app/runtime.ts` throws until a repository adapter
  supplies the controller's own revision and check reruns against a real checkout; the
  bridge therefore blocks every run at the verification step.
- The gate-aware scope helper of `src/executor/prime-gate.ts` is not yet called from
  `src/executor/prime-verify.ts`.

## 4. Blockers

1. **No delegated cgroup for this account** (T053). The bubblewrap boundary is proven,
   but the process-tree stop and its empty-cgroup proof could not be exercised here.
   The rollout must stay disabled until the operator runs it under the account that
   owns the delegation, as the spike in `runtime-report.md` did.
2. **No real backend, GitHub, or runner operation was authorized.** Every test uses
   fakes; the GitHub read helpers (`readComment`, `readCommit`, `readBranchProtection`)
   and the delivery's GitHub port are written but never ran against GitHub.
3. **The preflight's backend smoke is not configured.** `DSH_PRIME_BACKEND_SMOKE` is
   unset, so the preflight blocks the launch by design; the operator must provide a
   minimal real smoke command.
4. **The controller's own revision and check rerun need a repository adapter.** The
   verification currently falls back to a content attestation of the approved files and
   has no runner that executes the approved checks in a separately confined, credential
   free verifier.
5. **The `prime-approval` effect polls the original conversation.** It re-reads the
   Issue's comments every few minutes without an LLM; a decision that is never given
   keeps the effect queued. The operator may want a different cadence.

## 4b. Follow-up work after the autonomous run

The operator closed the three tasks the run left open. Each was verified
independently.

**T007, the task grammar.** The contract now states the accepted grammar: the
line shape, the three-digit minimum of a task ID, the tags, the four gate words
that mark a human gate, and what counts as authorized progress against a scope
change. `tests/prime-tasks.spec.ts` proves the documentation against the parser,
so the two cannot drift apart. Writing the test found one gap in the draft text:
the ID minimum was missing, and the implementation refuses a two-digit ID.

**T025, the bounded autonomous invocation.** `src/executor/prime-launch.ts` builds
the argument vector from the approved manifest: the runner CLI, the goal bounded
to the approved task range and the human gate, the limits from the approved
environment, and each approved check as an exit-code gate. The task prompt names
the approved files and states the constraints; it never repeats the
specification's content.

Two defects were found and fixed while doing this. The supervisor waited for the
runner to end, which a multi-hour autonomous run never does, so the runner now
starts in the background and its durable session identity is awaited instead.
And the barrier was written after the launch returned, which would have deadlocked
a runner that waits for it; the barrier is now released only after the controller
knows the identity, and the runner cannot work before it can be reconciled. The
preflight now checks exactly the flags the launch uses.

**T053, the delegated cgroup.** The implementation created its cgroup under
`/sys/fs/cgroup/prime-runner`, which no unprivileged account may write; the
cgroup v2 hierarchy is writable only under the user manager's own root. The run's
own user service unit now creates the cgroup with `Delegate=yes`, and the code
reads the resulting path from systemd instead of assuming one.
`tests/prime-cgroup-delegation.spec.ts` proves on this host that the cgroup
appears under the delegated root, that the kill file empties the process list,
and that an empty list is the proof a stop needs.

### Commands run for the follow-up work

| Command | Exit |
| --- | --- |
| `pnpm exec vitest run tests/prime-tasks.spec.ts` | 0 |
| `pnpm exec vitest run tests/prime-launch.spec.ts` | 0 |
| `pnpm exec vitest run tests/prime-bootstrap-barrier.spec.ts` | 0 |
| `pnpm exec vitest run tests/prime-cgroup-delegation.spec.ts` | 0 |
| `pnpm exec vitest run tests/prime-isolation.spec.ts` | 0 |
| `pnpm exec vitest run tests/docs.spec.ts` | 0 |
| `pnpm exec vitest run` | 0 (77 files, 1480 tests) |
| `pnpm exec tsc --noEmit` | 0 |
| `pnpm check` | 0 |

### Still open

The verification adapter of the bridge throws until a repository adapter supplies
the controller's own revision and the reruns of the approved checks in a
separately confined verifier. The GitHub and runner adapters have never run
against a real repository or a real runner. The preflight's backend smoke command
and the quota accounting command are still unset, so the preflight blocks the
launch by design. These need the operator's authorization and a real
environment; they are what task T054 asks for.

## 4c. T054 part 1: the isolated host start

The operator authorized the first part of the disposable smoke: the host starts
alone, without a model call and without a GitHub write. It ran on 2026-11-01 and
it passed, after two defects were found and fixed.

### What was done

| Step | Result |
| --- | --- |
| `npm install -g @deepseek-ai/dsh@0.2.1-rc.3` | the pinned version from `docs/006-deployment.md` |
| `dsh superagent --from-default-profile web --dump-config` | the `superagent` profile, with the webserver on 127.0.0.1:3082 and `stateDir` at `/home/ubuntu/.dsh/state/superagent` |
| `dsh plugin --profile superagent add "link:$PWD"` | this bundle, linked from the working repository |
| `pnpm build` | the bundle built from the current sources |
| `scripts/dsh-superagent start` | the service started |
| `scripts/dsh-superagent status` | exit 0 |

The final state: the runtime is `ready`, every component of the bridge reports
`ready`, the GitHub Source reports `ready` with "0 notifications; next poll >= 60s",
there is no setup problem and no error.

### The two defects this part found

**The service script did not find its own process.** `ps` reports the thread name
in `ucomm` on this system, where the Node service appears as `MainThread`
instead of `node`. The script compared the name against `('node', 'dsh')` and
therefore reported no PID and no health, even though the service was running and
answering. The script now decides from the command line when the name is not
recognizable, and `tests/service-script.spec.ts` proves all three cases: the
thread name, the node name, and another profile or another Node program.

**The GitHub CLI was too old for the source.** The source reads paged API
responses with `gh api --paginate --slurp`, and `--slurp` needs GitHub CLI 2.47
or later; the installed 2.46 refused it and the Source reported "3 consecutive
failed polls". `docs/006-deployment.md` asks for 2.48 or later, so the system
package was behind the documented requirement. The official 2.103.3 binary is now
first on the user's path, and the system package at `/usr/bin/gh` is left in
place for anything that expects it.

### What this part does not prove

No model was called, no branch was pushed, no pull request was opened, and the
agent account's credentials were used only to read the account and the
repository's permissions, which is what the deployment check does.

The bridge itself is installed and reports ready, but it has never run a
segment: its verification adapter throws by design until a repository adapter
supplies the controller's own revision and reruns the approved checks, so a run
blocks at the verification step and opens no pull request. That is the expected
outcome and is named as such in the T054 plan.

The DSH profile is a directory under `~/.dsh` and the service runs in the
`dsh-superagent` tmux session. Both belong to this deployment and can be
removed with `scripts/dsh-superagent stop` and the removal of the profile
directory.

### Commands run

| Command | Exit |
| --- | --- |
| `npm install -g @deepseek-ai/dsh@0.2.1-rc.3` | 0 |
| `dsh superagent --from-default-profile web --dump-config` | 0 |
| `dsh plugin --profile superagent add "link:$PWD"` | 0 |
| `pnpm build` | 0 |
| `scripts/dsh-superagent status` | 0 |
| `pnpm exec vitest run tests/service-script.spec.ts` | 0 |
| `pnpm exec vitest run` | 0 (77 files, 1468 tests) |

## 5. Human decisions still needed

1. **T054 (MANUAL GATE)**: the operator's explicit approval for a disposable
   real-backend and GitHub smoke, with the host, the accounts, the credential
   categories, the repository, the quotas, the irreversible actions, and the cleanup.
   Nothing of that was started.
2. **The task grammar's documentation** may be added to `contracts/bridge.md` once the
   rule about spec artifacts is relaxed for that file.
3. **The `prime-agent --autonomous` invocation** (T025) needs the operator's decision
   on the exact flags and the bootstrap barrier, because the runner's own CLI decides
   them.
4. **The cgroup delegation** (T053) must be provided to the account that runs the
   controller, or the feature stays disabled.
5. **The model backend smoke command** and the accounting command of the quota guard
   (`DSH_PRIME_ACCOUNTING`) must be configured by the operator.
6. **The merge of this work** is a human decision; no pull request was created and
   nothing was pushed.
