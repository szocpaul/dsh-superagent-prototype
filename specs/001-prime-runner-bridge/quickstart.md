# Quickstart: Validate the Prime Runner Bridge

This is a validation guide for the proposed feature. The bridge is not yet
implemented; tests and interfaces below are design targets, not available commands
unless explicitly marked as existing. Perform real-backend, credential, cron,
service and GitHub operations only with operator approval in a disposable environment.

## Prerequisites

- Node, pnpm, DSH and repository dependencies supported by `package.json`; Linux host
  with working user-service/cgroup and namespace isolation, tmux, Git, cron, and the
  installed Prime CLI. Presence of binaries alone does not prove isolation works.
- One disposable GitHub repository with an agent account, an operator-vetted human
  allowlist, a prepared approved feature, and required tests. No auto-merge credentials.
- A dedicated runner identity and private home/socket; no host Prime daemon access.
  Configure model credentials and a metered-provider quota guard without placing secret
  values in repository files, reports, prompts, or issue comments.
- Provision a test project whose `spec.md`, `plan.md`, `tasks.md`, task grammar,
  allowed paths and checks can be validated under [contracts/bridge.md](contracts/bridge.md).
  Prepare one no-gate scenario and one distinct manual-gate scenario. No fixture or
  production repository should be modified by these instructions before review.

## 0. Verified local prerequisites (2026-11-01)

The tool versions and the existing check commands of this repository were read without
installing, changing, or launching anything, and without a backend call.

| Tool | Version |
|------|---------|
| Node | v24.21.0 |
| pnpm | 11.7.0 |
| TypeScript | 6.0.3 (from `package.json`) |
| Vitest | 4.1.8 (from `package.json`) |
| git | 2.53.0 |
| GitHub CLI | 2.46.0 |
| tmux | 3.6 |
| bubblewrap | 0.11.1 |
| systemd | 259 |
| Prime Agent CLI | 0.10.1 |
| Python | 3.14.4 |
| Kernel | 7.0.0-38-generic |

The repository's existing commands, unchanged by this feature:

```sh
pnpm exec vitest run tests/prime-<name>.spec.ts   # one focused bridge suite
pnpm exec vitest run tests/prime-*.spec.ts        # every bridge suite
pnpm typecheck                                    # tsc --noEmit
pnpm test                                         # vitest run
pnpm build                                        # tsdown
pnpm check                                        # typecheck, then test, then build
```

`pnpm check` is the full check; a focused suite is not a substitute for it. The host
already runs unrelated cron entries, so the bridge's quota guard must own exactly one
entry of its own and remove only that one. `bwrap` is the verified isolation binary on
this host (see [runtime-report.md](runtime-report.md)); raw unprivileged user namespaces
are denied by AppArmor here.

## 1. Run existing checks

Dependencies install with the committed lockfile:

```sh
pnpm install --frozen-lockfile
```

Measured on 2026-11-01 in this environment: Node v24.21.0, pnpm 11.7.0, git 2.53.0,
tmux 3.6, Python 3.14.4, GitHub CLI 2.46.0. The deployment guide asks for GitHub CLI
2.48 or later; the installed 2.46 serves the API calls this feature makes, and the
upgrade belongs to the deployment, not to the bridge.

`pnpm exec vitest run` reports 1196 passing and one failing test in
`tests/sources.spec.ts` ("drops the events it reads once the Source is off"). The
same file passes when it runs alone, so the failure is order-dependent and flaky.
The prototype's own sources were not modified at this point, which `git diff`
against the upstream commit confirms.

From this repository, after dependencies are installed and the feature is implemented:

```sh
pnpm check
```

This existing command runs TypeScript typecheck, Vitest and build. Report failures or
checks not run; a green suite is not a substitute for the integration scenarios below.
Use `pnpm exec vitest run tests/<implemented-bridge-test>.spec.ts` for focused tests,
replacing the placeholder with actual test files created during implementation.

## 2. Controlled, non-network integration tests

Run the bridge tests added by implementation with fake GitHub, Prime, clock, storage,
quota guard, and external process adapters. The tests MUST cover:

- missing/mismatched approval and content, explicit unauthorized/bot actor, edited or
  deleted approval, changed environment, progress-only versus scope-bearing changes;
- duplicate event and concurrent requests, process launch crash windows, unknown
  identities, persisted stop intent, restart with ended Tickets, and stale reports;
- stop racing launch, gate approval, verification and PR initiation; unknown remote
  outcome causes reconciliation rather than a duplicate write or false rollback;
- a manual gate: no task after the gate, no agent-ticked gate, only verified human
  gate-only commit and decision resume the next segment;
- missing/failed checks, stale revision and report, quota alert/guard failure,
  unavailable original conversation, and already enabled auto-merge;
- independent verification checks and exact revision, one open Ticket PR, and no
  auto-merge/merge credentials or calls.

## 3. Real containment and process-lifecycle test

The host mechanisms this test relies on are already proven on the target host and
recorded in [runtime-report.md](runtime-report.md): `bubblewrap` isolation with a
masked home and `/tmp`, a delegated service cgroup whose kill file empties a
nested process tree, and the `cgroup.procs`, `pids.current` and `populated` reads
that show quiescence. The implementation must use those mechanisms, not invent
its own.

In a disposable Linux test environment, explicitly start the test supervisor and
private daemon after the operator approves the environment. The implementation must
provide a documented command for this test before release. It must demonstrate:

1. A permitted write succeeds; writes outside approved paths, host-home/credential
   reads, host-daemon socket access and unauthorized network access fail.
2. A child and a nested descendant started by the runner remain in the run-owned
   containment boundary; stop confirms the whole boundary is empty.
3. Simulated crash before session identity is persisted, host restart, and a missing
   event retain the reservation/guard until identity and quiescence are established.
4. Failed containment or quota guard prevents prompt release; unconfirmed stop keeps
   monitoring active and shows the actual outcome.
5. The host Prime daemon socket stays unreachable from inside the sandbox, and the
   runner uses its own private socket.

If any claim cannot be reproduced on the target host, leave the feature disabled.
Use external non-LLM monitoring; do not create a Prime heartbeat for quota checks.

## 4. Manual end-to-end smoke (after implementation and explicit approval)

1. In the disposable repository, prepare and approve a baseline manifest according to
   [the approval contract](contracts/bridge.md#1-github-request-and-approval).
2. From the allowlisted test human account, request the existing feature in a GitHub
   issue. Verify one run, the correct branch/workspace, approved scope and a running
   external quota guard if the provider is metered.
3. For a no-gate fixture, verify exact-revision independent check evidence and one
   review-ready PR. Confirm auto-merge was never enabled; do not merge automatically.
4. For a gate fixture, verify no later task was performed and the PR remains draft.
   The human reviews, makes the required one-checkbox commit with a signer independently
   bound to their allowlisted identity, posts the gate approval bound to that revision,
   and observes the separately authorized continuation. If that binding cannot be
   verified, the flow remains blocked.
5. Repeat with an authorized stop, controller restart and lost notification. Confirm
   there is no duplicate runner or PR, no claim of confirmed stop until proven, and
   no guard cleanup while the runner may still be alive.
6. Verify report, evidence, review comments and documented cleanup. Independently
   confirm run-owned service, daemon, cron entry, and temporary workspace are disposed
   only after verified stop; do not touch unrelated sessions or cron entries.

## 5. Implemented local commands

The bridge is implemented and covered by focused suites; the commands below are the ones
that exist in this repository now.

```sh
pnpm exec vitest run tests/prime-*.spec.ts   # every bridge suite (269 tests)
pnpm exec vitest run tests/prime-store.spec.ts tests/prime-isolation.spec.ts tests/prime-quota.spec.ts
pnpm typecheck                               # tsc --noEmit
pnpm check                                   # typecheck, then test, then build
sh -n scripts/prime-quota-guard.sh           # the guard script's syntax
```

The bridge's own modules are `src/executor/prime-*.ts` (the manifest, the tasks, the
approval, the preflight, the isolation supervisor, the quota guard, the report, the
verification, the gate, the delivery, the coordinator, and the recovery policy),
`src/app/prime-approval.ts` and `src/app/prime-service.ts` (the approval protocol and the
composition), and `src/infra/prime-isolation.ts` (the containment adapter). The
disposable fixtures are in `tests/fixtures/prime-bridge/`, and the fake host the
coordinator tests share is `tests/fixtures/prime-bridge-host.ts`.

The quota guard is installed per run as one cron entry of its own and is removed only
after a confirmed stop. Its script takes the run's identity as arguments:

```sh
scripts/prime-quota-guard.sh --session <file> --log <file> --warn <tokens> --stop <tokens> \
  --alert <file> --cgroup <dir> -- <accounting command>
```

Cleanup of a run's own resources (guard entry, service unit, daemon socket, tmux server,
and workspace scratch) happens only after the stop is confirmed and the cgroup is proven
empty; the code refuses it otherwise.

### Operator authorization still required

Nothing below is run by the tests, and none of it may run without the operator's
separate authorization:

- any live model or backend call (the preflight's backend smoke needs
  `DSH_PRIME_BACKEND_SMOKE` to be configured, and it blocks the launch while it is not);
- any GitHub write, including the pull request, the push, and the branch protection
  check;
- the disposable end-to-end smoke (task T054), which is a MANUAL GATE;
- the real containment run of section 3, which needs the operator's approval of the
  environment.

The tests use fakes for GitHub, the runner, the clock, the quota accounting, and the
cgroup, so the suite never touches the network.

## Evidence to retain

Record the manifest digest, Ticket and segment IDs, GitHub approval IDs, baseline and
result revisions, actual checks and exit codes, containment test results, guard scope,
stop confirmation, PR URL and any unavailable checks. Store no secrets. The exact
implementation-specific commands for bridge setup and invocation must be added to
this guide and operator documentation when the interfaces exist.
