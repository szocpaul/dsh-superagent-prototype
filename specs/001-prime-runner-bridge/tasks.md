# Tasks: Prime Runner Bridge

**Input**: `specs/001-prime-runner-bridge/spec.md`, `plan.md`, `research.md`,
`data-model.md`, `contracts/bridge.md`, and `quickstart.md`.

**Scope**: One repository, explicit GitHub requests, one unresolved runner, approved
existing spec/plan/tasks, human gates, independently verified PR, and human merge.
No proactive intake, auto-merge, multiple active runners, or spec creation is in V1.

**Execution rules**: Complete tasks in phase/dependency order. A `MANUAL GATE` is a
mandatory stop: do not tick or bypass it, or perform the human decision on the
operator's behalf. Wait for explicit approval; after the decision, document it in
the named artifact without marking the gate complete. Tests below are required by
the spec and constitution. Use the project's environment; do not run live model
calls, create cron entries or services, or touch GitHub without separate operator
authorization. Tick only completed automatable tasks. Keep later stages disabled
until all P1 safety and verification prerequisites are complete.

## Phase 1: Setup and mandatory design decisions

**Purpose**: Resolve decisions required before changing runtime behavior.

- [x] T001 MANUAL GATE — In `specs/001-prime-runner-bridge/research.md`, obtain and record the operator's decision on a GitHub operation already in flight when stop is requested: allow a reconciled `unknown`/`delivered-after-stop` outcome, or revise `specs/001-prime-runner-bridge/spec.md`; do not proceed with implementation on an unresolved decision. Decision recorded 2026-11-01: reconciled outcome accepted; `spec.md` FR-015 states the guarantee explicitly.
- [ ] T002 MANUAL GATE — In `specs/001-prime-runner-bridge/contracts/bridge.md`, obtain and record approval or a revised protocol for allowlisted-human approval, gate signer identity binding, dedicated Linux isolation, restricted network, separately enforced no-merge branch protection and explicit environment/credential acknowledgment; decide whether the gate signer and approver must be the same person and how revoked authority is treated. If unavailable or declined, update the spec/plan and stop until the new scope is approved. Decision recorded 2026-11-01: accepted in principle as a conditional design, subject to the T005 feasibility spike; an unprovable control blocks the affected story instead of weakening the protocol.
- [x] T003 MANUAL GATE — In `specs/001-prime-runner-bridge/spec.md` and `specs/001-prime-runner-bridge/plan.md`, obtain and record the operator's resolution of (a) the runner snapshot versus controller-created result-revision report contract, (b) segment-limited convergence versus full-spec assessment, and (c) enforceable per-segment work/effect boundaries versus the absolute no-later-task claim; amend the artifacts if necessary and do not proceed while contradictory. Decision recorded 2026-11-01: (a) one durable report keeps the runner's observed workspace state and the system's verified result revision separate; (b) segment-limited assessment before a gate, full assessment after the last segment, findings remain proposals needing a new approval; (c) the specification now distinguishes enforced controls from instructed constraints and requires a human decision where a task boundary cannot be held.
- [ ] T004 [P] Verify local project prerequisites and capture tool versions and existing test commands without installing or changing the environment in `specs/001-prime-runner-bridge/quickstart.md`; do not run backend calls or launch processes.
- [ ] T005 MANUAL GATE — In `specs/001-prime-runner-bridge/runner-report.md`, run an operator-authorized disposable-repository and disposable-host feasibility spike that proves: (a) a GitHub-authenticated edit by an allowlisted human yields evidence bindable to that account and whether the human's own signing key is required; (b) the branch protection rule actually denies the controller identity merge and bypass rather than merely being configured; (c) the host supports the required user service, namespace and cgroup confinement with a provable empty-cgroup stop; (d) the acceptance wording and required check commands of the installed Spec Kit skills. Follow `specs/001-prime-runner-bridge/operator-steps.md` for the agent account, the separate CLI configuration and the human gate action. Record the results, and block the affected story where a control cannot be proven.
  - Verified 2026-11-01: (b) on `szocpaul/dsh-superagent-prototype` the protected `main` refused merging as the account that pushed the branch, refused an administrator merge, and refused a direct push; the temporary pull request was closed and its branch deleted. (a) web-interface commits report `verified: true` with the acting account as author, while machine pushes are unsigned. (c) and (d) remain open and block the affected stories.


**Checkpoint**: T001–T003 and T005 remain unchecked until performed by the operator.
T001 is recorded as decided on 2026-11-01. Only after the remaining decisions and any
resulting spec/plan amendments may foundation work begin. T004 is read-only and may
run independently.

## Phase 2: Foundational — shared safety and lifecycle

**Purpose**: Implement the controls needed by all four stories. No Prime runner is
released until the stop, quota and isolation prerequisites are implemented and tested.

- [ ] T006 [P] Add a disposable non-secret no-gate/gate fixture and RFC 8785 manifest canonicalization, path/symlink/control-file and unsupported checkout tests with pinned baseline/guidance/hook/check digests in `tests/fixtures/prime-bridge/` and `tests/prime-manifest.spec.ts`.
- [ ] T007 [P] Define accepted task grammar with concrete supported markers and dependency-order examples in `specs/001-prime-runner-bridge/contracts/bridge.md`, then add exact checkbox-progress tests including duplicate IDs, reordered/added tasks, initial checks, manual gates and ambiguous syntax in `tests/prime-tasks.spec.ts`.
- [ ] T008 [P] Add transactional bridge reservation, singleton capacity, stale generation/epoch and Store reopen tests in `tests/prime-store.spec.ts`.
- [ ] T009 [P] Add isolated runner preflight and escape/privilege tests for namespace, inherited descriptors, symlinks, cgroup, private daemon and allowed external effects in `tests/prime-isolation.spec.ts`.
- [ ] T010 Implement strict manifest, RFC 8785 canonical bytes/hash, fixed baseline revision/tree, explicit paths/checks/tool/environment and no-secret schemas in `src/executor/prime-manifest.ts` and `src/executor/prime-model.ts` (depends on T006).
- [ ] T011 Implement the fail-closed unique task parser and baseline-versus-authorized-progress comparator in `src/executor/prime-tasks.ts`, preserving initial checked markers and validating each permitted controller or human gate commit's provenance, parent and exact marker transition (depends on T007, T010).
- [ ] T012 Add durable bridge records, a database-enforced single unresolved reservation and migration/refusal handling to `src/app/store.ts`, `src/app/migration.ts` and `src/kv.ts`; atomic reservation must persist segment, generation, epoch, monitor and approved manifest identities (depends on T008, T010).
- [ ] T013 Add idempotent bridge launch, stop, reconcile and delivery effect types with transactional enqueue and stale-generation fencing in `src/app/effects.ts` (depends on T012).
- [ ] T014 Implement a typed process/containment adapter in `src/infra/prime-isolation.ts` and `src/executor/prime-supervisor.ts` with private user service/cgroup, socket, daemon and tmux identities, clean checkout, read-only controls, restricted writable paths and no-follow collection; fail closed for unsupported confinement (depends on T009, T010).
- [ ] T015 Implement independent containment probes in `src/infra/prime-isolation.ts` and `tests/prime-isolation.spec.ts` for filesystem, hardlink/symlink, `/proc`, IPC/socket, capabilities, inherited descriptors, cgroup escape, approved network policy and verifier credential separation (depends on T014).
- [ ] T016 Implement a bounded non-LLM quota watcher with per-run identity, explicit accounting scope, durable alert, independently supervised liveness and emergency cgroup-stop path in `src/executor/prime-quota.ts` and `scripts/prime-quota-guard.sh`; retain it while stop is uncertain and state account/child/credential coverage and possible overshoot (depends on T012–T015).
- [ ] T017 Wire an exclusive deployment/store controller lock and durable startup reconciliation for open and ended Tickets before bridge launch effects can dispatch in `src/app/runtime.ts` and `src/executor/prime-bridge.ts` (depends on T012–T016).

**Checkpoint**: The bridge remains disabled by default; a fake or unsafe environment
must not start real Prime work. The singleton reservation covers unknown processes.

## Phase 3: User Story 1 — Run an approved specification (Priority: P1)

**Goal**: Accept a verifiable authorized request for a prepared spec, execute one
bounded segment, and deliver one independently verified PR.

**Independent Test**: With fakes and a prepared no-gate fixture, approve an exact
manifest and exercise one run to one PR; reject missing/edited authorization, failed
preflight, stale result and duplicate launch or delivery.

### Tests for User Story 1

- [ ] T018 [P] [US1] Test GitHub human allowlist, exact manifest approval, current policy/revocation and edited/deleted/stale comments in `tests/prime-approval.spec.ts`.
- [ ] T019 [P] [US1] Test tool/flag/skill expansion, real-smoke adapter failures, no-destructive-preflight, hook/write restrictions and launch-barrier behavior with fakes in `tests/prime-preflight.spec.ts`.
- [ ] T020 [P] [US1] Test strict report schema, untrusted wake/report, scope validation, scratch convergence, exact snapshot commit and separate credential-free verification in `tests/prime-result.spec.ts`.
- [ ] T021 [P] [US1] Test same-repo exact branch PR claims, idempotent create/push, expected-old-SHA lease, stale/unknown outcomes and enforced no-auto-merge in `tests/prime-delivery.spec.ts`.

### Implementation for User Story 1

- [ ] T022 [US1] Implement manifest-bound explicit approval and source evidence refetch/current-policy revalidation for allowlisted humans in `src/app/prime-approval.ts` and `src/sources/github-read.ts`; require immutable GitHub actor/repo identity and fail closed for missing/unknown bot/user type rather than trusting Trigger.human (depends on T010–T013, T018).
- [ ] T023 [US1] Add approved manifest display and original-issue decision intake using existing Ticket attention and durable outbox in `src/app/tools/executor.ts`, `src/app/notices.ts` and `src/app/outbox.ts` (depends on T022).
- [ ] T024 [US1] Implement preflight for Prime flags, isolated skill expansion, actual backend/auth smoke adapters, interpreter, safe hooks, checks, isolation and monitor registration in `src/executor/prime-preflight.ts` (depends on T014–T016, T019, T022).
- [ ] T025 [US1] Implement a bounded `prime-agent --autonomous` launch with deterministic identities, private socket/daemon, exact approved workspace and bootstrap barrier in `src/executor/prime-supervisor.ts` and `src/executor/prime-bridge.ts` (depends on T017, T024).
- [ ] T026 [US1] Add atomic structured/Markdown report ingestion and local wake with non-LLM reconciliation fallback, rejecting stale or malformed run identities in `src/executor/prime-report.ts` and `src/executor/prime-bridge.ts` (depends on T013, T020, T025).
- [ ] T027 [US1] Implement approved-scope snapshot collection, controller-created commit and combined runner/controller report binding, scratch-based bounded/full convergence and separately confined exact-revision verification in `src/executor/prime-verify.ts` (depends on T003, T011, T015, T026).
- [ ] T028 [US1] Implement revalidated PR creation/update and claim, push with expected-old-SHA, server-enforced no-merge prerequisites and durable unknown remote outcome in `src/sources/github-pull.ts` and `src/executor/prime-delivery.ts` (depends on T021, T022, T027).
- [ ] T029 [US1] Map verified complete reports to Ticket `ready` with open PR, approved evidence and durable reply; block unverified/incomplete results in `src/app/tools/executor.ts` and `src/executor/prime-bridge.ts` (depends on T028).

**Checkpoint**: This story's happy path is demoable with fakes, but it is not a safe
release until the P1 gate, stop/recovery, and quota controls below also pass.

## Phase 4: User Story 2 — Review an explicit human gate (Priority: P1)

**Goal**: Stop before a manual task and resume only after an authorized, auditable
human action and explicit decision tied to the exact manifest and branch.

**Independent Test**: Using a gate fixture, show a draft PR and actionable question,
then prove an authorized verified human-only checkbox commit plus gate approval allows
a new segment; all other responses and subsequent tasks remain blocked.

### Tests for User Story 2

- [ ] T030 [P] [US2] Test untouched gate/later tasks, bound draft PR, original-channel attention and inaccessible conversation using `tests/prime-human-gate.spec.ts`.
- [ ] T031 [P] [US2] Test verified signer-to-allowlisted-human binding, exact one-checkbox diff, quoted/wrong/stale/edited/denied decisions and policy changes in `tests/prime-gate-approval.spec.ts`.

### Implementation for User Story 2

- [ ] T032 [US2] Implement gate-aware scratch assessment with explicit unassessed later tasks, at most two rounds and newly discovered work requiring a new approved manifest in `src/executor/prime-verify.ts` (depends on T027, T030).
- [ ] T033 [US2] Persist gate identity, question, result evidence and stop confirmation; bind an optional draft PR and deliver one human-action request without `ready` in `src/executor/prime-bridge.ts` and `src/app/tools/executor.ts` (depends on T026, T028, T030).
- [ ] T034 [US2] Verify exact GitHub-authenticated gate commit, independently bound signer/human identity, T002 signer/approver relationship, revocation, parent/head, one-checkbox diff and bound decision in `src/app/prime-approval.ts` and `src/sources/github-read.ts` (depends on T002, T022, T031, T033).
- [ ] T035 [US2] Revalidate policy, manifest, environment, gate decision, stop epoch and prior quiescence before atomically reserving a separately bounded next segment in `src/executor/prime-bridge.ts` (depends on T032–T034).

**Checkpoint**: Generic Ticket wake, bot comments, report text and ordinary PR approval
never act as gate approval; unsupported proof blocks instead of bypassing review.

## Phase 5: User Story 3 — Stop and recover long-running work (Priority: P1)

**Goal**: Stop the full owned process boundary or honestly report uncertainty, and
reconcile after restart without duplicate runners or external actions.

**Independent Test**: With a disposable nested process and fakes, stop an active
Ticket and confirm the cgroup is empty; exercise crash/unknown-stop windows and
prove reservation and monitoring remain while duplicate launch is blocked.

### Tests for User Story 3

- [ ] T036 [P] [US3] Test atomic stop tombstone/effect, stale callbacks and stop-versus-launch/approval/report/publication races in `tests/prime-stop.spec.ts`.
- [ ] T037 [P] [US3] Test restart recovery for ended Tickets, crash-before-identity, orphan/unknown runner, lost notification, monitor retention and idempotent replay in `tests/prime-recovery.spec.ts`.
- [ ] T038 [P] [US3] Test unknown in-flight GitHub call, delayed visibility and failed push lease reconciliation with no blind duplicate publication in `tests/prime-publication-race.spec.ts`.

### Implementation for User Story 3

- [ ] T039 [US3] Persist bridge stop epoch and durable stop effect in the same Ticket-ending transaction by integrating `src/core/tickets.ts`, `src/core/ports.ts` and `src/executor/dsh.ts` without moving I/O into core (depends on T012–T013, T036).
- [ ] T040 [US3] Implement exact private Prime/service cancellation and verified empty-cgroup confirmation in `src/executor/prime-supervisor.ts`; keep unknown runners locked/guarded and surface unconfirmed stop (depends on T016, T039).
- [ ] T041 [US3] Reconcile identity, runner, workspace, guard, report and GitHub state at startup and retry, including human-stopped/ended Tickets, in `src/executor/prime-bridge.ts` and `src/app/runtime.ts` (depends on T017, T037, T040).
- [ ] T042 [US3] Fence stale effects and serialize stop with delivery initiation; retain `unknown` or `delivered-after-stop` for operator reconciliation rather than claiming remote rollback in `src/executor/prime-delivery.ts` and `src/app/effects.ts` (depends on T001, T028, T036, T038–T041).
- [ ] T043 [US3] Expose operator-visible confirmed/unconfirmed stop and unresolved bridge state on the existing Ticket/system surface, including ended Tickets, in `src/app/views/overview.ts` and `src/client/route.ts` (depends on T040–T041).

**Checkpoint**: Stop acknowledgment or Prime `idle` alone is not proof of quiescence;
unknown state retains the reservation and the external quota guard.

## Phase 6: User Story 4 — Understand failures and protect resources (Priority: P2)

**Goal**: Distinguish preflight, provider, dependency, check, guard and quota failures;
keep resource controls active and actionable without false readiness.

**Independent Test**: Simulate failure of each required prerequisite and monitor path;
verify a durable actionable blocker, no release of unguarded work, and cleanup only
after confirmed quiescence without touching unrelated runs.

### Tests for User Story 4

- [ ] T044 [P] [US4] Test silent green quota guard, explicit billing coverage/limits, unreadable metrics, warning, threshold stop, controller crash, guard liveness loss and independent emergency stop in `tests/prime-quota.spec.ts`.
- [ ] T045 [P] [US4] Test distinct dependency/provider/quota/preflight/check/report failures and secret redaction in `tests/prime-failures.spec.ts`.

### Implementation for User Story 4

- [ ] T046 [US4] Integrate per-run cron guard lifecycle, liveness and emergency stop with durable alerts and independent target verification in `src/executor/prime-quota.ts`, `scripts/prime-quota-guard.sh` and `src/executor/prime-bridge.ts` (depends on T016, T040–T041, T044).
- [ ] T047 [US4] Map and persist distinct blocked/failed causes, check evidence, quota coverage and operator next action without leaking secrets in `src/executor/prime-report.ts` and `src/app/notices.ts` (depends on T026, T045–T046).
- [ ] T048 [US4] Clean up only bridge-owned guard, service, daemon and workspace resources after independently confirmed quiescence in `src/executor/prime-supervisor.ts` and `src/executor/prime-quota.ts` (depends on T040, T046).

**Checkpoint**: An unreadable guard or unavailable monitor fails closed; a token limit
is not described as an account-wide billed quota guarantee.

## Phase 7: Polish and cross-cutting validation

- [ ] T049 [P] Update English deployment, permissions, allowlist, human-gate, actual isolation, signed-commit, stop/recovery, quota limitations and manual merge instructions in `docs/006-deployment.md` and `docs/003-execution.md` (depends on T035, T042, T047–T048).
- [ ] T050 [P] Update the implementation/ownership map and test index in `docs/007-architecture.md`, keeping numbered-document link order intact (depends on T029, T035, T042, T047–T048).
- [ ] T051 Update `specs/001-prime-runner-bridge/quickstart.md` with actual implemented local test, setup and cleanup commands and explicit operator authorization requirements (depends on T029, T035, T042, T047–T048).
- [ ] T052 Run focused test suites from `tests/prime-*.spec.ts` and the full `pnpm check` from `package.json`; record actual commands, exit codes and blockers in `specs/001-prime-runner-bridge/runner-report.md` (depends on T029, T035, T042–T048).
- [ ] T053 Run the operator-authorized isolated Linux namespace/cgroup and emergency-watcher tests specified in `specs/001-prime-runner-bridge/quickstart.md` without real credentials; record evidence and disable rollout on any unsupported or failed control in `specs/001-prime-runner-bridge/runner-report.md` (depends on T015, T040–T048).
- [ ] T054 MANUAL GATE — In `specs/001-prime-runner-bridge/runner-report.md`, obtain explicit operator approval for a disposable real-backend/GitHub smoke and signer-binding/branch-protection feasibility checks: identify host, accounts, credential categories, repository, quotas, irreversible actions and cleanup; never request or record secret values (depends on T052–T053).
- [ ] T055 Run the operator-approved disposable end-to-end smoke from `specs/001-prime-runner-bridge/quickstart.md`, verify gate, stop/restart and PR without merge, and record concrete evidence/cleanup in `specs/001-prime-runner-bridge/runner-report.md` (depends on T054).
- [ ] T056 Run bounded spec coverage assessment per `specs/001-prime-runner-bridge/spec.md`, review remaining findings and document any blocked/incomplete verification in `specs/001-prime-runner-bridge/runner-report.md` (depends on T052–T055).

## Dependencies & Execution Order

- **Phase 1**: T001–T003 and T005 are human-owned decisions and block all
  implementation; T004 is read-only and may run independently. T005's feasibility
  results gate the US2 gate flow and the containment-dependent tasks.
- **Phase 2**: T006–T009 can be written in parallel; shared implementations follow the
  listed dependencies. T016 must exist before T025; no unguarded execution is valid.
- **US1**: After foundation, T018–T021 can be written in parallel, followed by
  T022–T029. A no-gate run can be tested in isolation with fakes.
- **US2**: Tests T030–T031 may be prepared after foundation; actual gate flow requires
  US1's approval, reporting, PR and verification interfaces.
- **US3**: Tests T036–T038 may be prepared after foundation; integration requires US1's
  coordinator and delivery interfaces. Safety-critical stop/recovery must be completed
  before any live Prime run or release.
- **US4**: Tests T044–T045 may be prepared after foundation; runtime integration uses
  the foundational guard and US3 stop/recovery path. Guard setup is a precondition
  even for the US1 happy path on metered providers.
- **Phase 7**: Documentation tasks T049–T050 are parallel after their dependencies;
  T052–T053 validate the implementation, T054 requires human authorization, then T055
  and T056 complete the bounded acceptance sequence.

## Parallel Examples

- **US1**: T018, T019, T020 and T021 touch separate test files and may run together.
- **US2**: T030 and T031 may run together; serialize T033–T035 because they share
  coordinator and approval files.
- **US3**: T036, T037 and T038 may run together; serialize T039–T042 where files or
  stop/publication state overlap.
- **US4**: T044 and T045 may run together; serialize T046–T048 where guard and
  supervisor files overlap.

## Implementation Strategy

1. Resolve the T001–T003 operator decisions first; no autonomous worker may tick a manual gate.
2. Build the shared security, durable state, and stop/guard foundation; keep the
   bridge disabled and use fakes until the controls can be independently proven.
3. Implement and independently exercise US1, US2, US3 and US4. US1 alone is a useful
   development increment, **not a safe deployable MVP**, because manual gates,
   verified stop/recovery and metered-usage safeguards are first-version requirements.
4. Run the focused and complete project checks, prove real isolation without secrets,
   then stop at T054 for human authorization before a disposable live smoke.
5. If a required security boundary, signer binding, guard accounting or external
   outcome cannot be verified, keep the feature disabled and report the blocker.
