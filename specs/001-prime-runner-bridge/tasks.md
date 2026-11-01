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
- [x] T002 MANUAL GATE — In `specs/001-prime-runner-bridge/contracts/bridge.md`, obtain and record approval or a revised protocol for allowlisted-human approval, gate signer identity binding, dedicated Linux isolation, restricted network, separately enforced no-merge branch protection and explicit environment/credential acknowledgment; decide whether the gate signer and approver must be the same person and how revoked authority is treated. If unavailable or declined, update the spec/plan and stop until the new scope is approved. Decision recorded 2026-11-01: approved. The operator approved the contract, the signer binding (the account that performs the gate edit and the account that approves the continuation are the same allowlisted human; a revoked allowlist entry withdraws the approval), the dedicated Linux isolation with its stated limit, the restricted network, the separately enforced no-merge branch protection, and the environment and credential acknowledgment carried by the approved manifest digest. The T005 spike proved the controls; an unprovable control blocks the affected story instead of weakening the protocol.
- [x] T003 MANUAL GATE — In `specs/001-prime-runner-bridge/spec.md` and `specs/001-prime-runner-bridge/plan.md`, obtain and record the operator's resolution of (a) the runner snapshot versus controller-created result-revision report contract, (b) segment-limited convergence versus full-spec assessment, and (c) enforceable per-segment work/effect boundaries versus the absolute no-later-task claim; amend the artifacts if necessary and do not proceed while contradictory. Decision recorded 2026-11-01: (a) one durable report keeps the runner's observed workspace state and the system's verified result revision separate; (b) segment-limited assessment before a gate, full assessment after the last segment, findings remain proposals needing a new approval; (c) the specification now distinguishes enforced controls from instructed constraints and requires a human decision where a task boundary cannot be held.
- [x] T004 [P] Verify local project prerequisites and capture tool versions and existing test commands without installing or changing the environment in `specs/001-prime-runner-bridge/quickstart.md`; do not run backend calls or launch processes.
  - Done 2026-11-01: the tool versions and the existing check commands are recorded in `quickstart.md` section 0; nothing was installed, changed, or launched.
- [x] T005 MANUAL GATE — In `specs/001-prime-runner-bridge/runtime-report.md`, run an operator-authorized disposable-repository and disposable-host feasibility spike that proves: (a) a GitHub-authenticated edit by an allowlisted human yields evidence bindable to that account and whether the human's own signing key is required; (b) the branch protection rule actually denies the controller identity merge and bypass rather than merely being configured; (c) the host supports the required user service, namespace and cgroup confinement with a provable empty-cgroup stop; (d) the acceptance wording and required check commands of the installed Spec Kit skills. The operator creates the dedicated agent account with `push` access only and its separate CLI configuration first, following `specs/001-prime-runner-bridge/operator-steps.md`; the agent account's own messages are dropped by the Source, so this separation is required for the operator's requests and approval to reach the system at all. Record the results, and block the affected story where a control cannot be proven.
  - Decision recorded 2026-11-01: the operator accepted the spike's findings and limits as stated. Verified evidence is in `specs/001-prime-runner-bridge/runtime-report.md`. (a) web-interface commits report `verified: true` with the acting account as author, while machine pushes are unsigned. (b) with the dedicated agent account `szocpaul-dsh-agent` (`write` access, no `admin` and no `maintain`), the agent's pull request could not be merged, not even with administrator privileges, and the operator's merge was refused until the operator approved it; the temporary pull requests were closed and their branches deleted, and the probe file was removed in a separate pull request. (c) `bubblewrap` isolation proven with masked home and `/tmp`, blocked writes outside the approved paths, a blocked host daemon socket, and a delegated cgroup whose kill file emptied a nested process tree with no survivor. The isolation contains the agent's mistakes but is not a privilege boundary against the operator's passwordless root. (d) the installed Spec Kit skills have no manual-gate handling, `/skill:speckit-implement` creates ignore files outside the approved scope, and the Spec Kit CLI cannot dispatch these steps headlessly.


**Checkpoint**: T001–T003 and T005 remain unchecked until performed by the operator.
T001 is recorded as decided on 2026-11-01. Only after the remaining decisions and any
resulting spec/plan amendments may foundation work begin. T004 is read-only and may
run independently.

## Phase 2: Foundational — shared safety and lifecycle

**Purpose**: Implement the controls needed by all four stories. No Prime runner is
released until the stop, quota and isolation prerequisites are implemented and tested.

- [x] T006 [P] Add a disposable non-secret no-gate/gate fixture and RFC 8785 manifest canonicalization, path/symlink/control-file and unsupported checkout tests with pinned baseline/guidance/hook/check digests in `tests/fixtures/prime-bridge/` and `tests/prime-manifest.spec.ts`.
  - Done 2026-11-01: `tests/fixtures/prime-bridge/` with the pinned digests, and `tests/prime-manifest.spec.ts` (12 tests).
- [x] T007 [P] Define accepted task grammar with concrete supported markers and dependency-order examples in `specs/001-prime-runner-bridge/contracts/bridge.md`, then add exact checkbox-progress tests including duplicate IDs, reordered/added tasks, initial checks, manual gates and ambiguous syntax in `tests/prime-tasks.spec.ts`. The grammar is documented in the contract, and `tests/prime-tasks.spec.ts` proves the documentation against the parser, including the three-digit task ID minimum the contract now states.
- [x] T008 [P] Add transactional bridge reservation, singleton capacity, stale generation/epoch and Store reopen tests in `tests/prime-store.spec.ts`.
  - `tests/prime-store.spec.ts` (9 tests): one segment holds the slot and a second is refused with nothing written; the reservation is kept while the phase is `unknown` and released only on a terminal phase; the segment, approval, report and reservation survive a reopen and a crash; a stale generation and a stale stop epoch do not overwrite a newer segment; a duplicated launch effect runs once.
    - `pnpm exec vitest run tests/prime-store.spec.ts` passes (9 passed).
- [x] T009 [P] Add isolated runner preflight and escape/privilege tests for namespace, inherited descriptors, symlinks, cgroup, private daemon and allowed external effects in `tests/prime-isolation.spec.ts`.
  - `tests/prime-isolation.spec.ts` (25 tests): the argument vector of a plan, the refusal of a manifest without a backend and of a writable path that leaves the workspace, the deterministic run identities, the containment probes with a fake attempt, the cgroup quiescence states, the stop verdicts, the cleanup refusal, and the artifact collection that refuses a symlink, a hard link and a non-directory root. The tests need no bubblewrap, systemd or root.
- [x] T010 Implement strict manifest, RFC 8785 canonical bytes/hash, fixed baseline revision/tree, explicit paths/checks/tool/environment and no-secret schemas in `src/executor/prime-manifest.ts` and `src/executor/prime-model.ts` (depends on T006).
  - Done 2026-11-01: `src/executor/prime-manifest.ts` and `src/executor/prime-model.ts`, with the manifest builder that reads one baseline.
- [x] T011 Implement the fail-closed unique task parser and baseline-versus-authorized-progress comparator in `src/executor/prime-tasks.ts`, preserving initial checked markers and validating each permitted controller or human gate commit's provenance, parent and exact marker transition (depends on T007, T010).
  - Done 2026-11-01: `src/executor/prime-tasks.ts` and `tests/prime-tasks.spec.ts` (8 tests); the gate commit provenance is in `src/app/prime-approval.ts`.
- [x] T012 Add durable bridge records, a database-enforced single unresolved reservation and migration/refusal handling to `src/app/store.ts`, `src/app/migration.ts` and `src/kv.ts`; atomic reservation must persist segment, generation, epoch, monitor and approved manifest identities (depends on T008, T010).
  - `src/app/store.ts`: the tables `bridge_segment`, `bridge_approval`, `bridge_report` and `bridge_failure` are created in the existing atomic block, so no schema version bump was needed and `src/app/migration.ts` is unchanged. A unique partial index `bridge_segment_slot` over the slot column of the unresolved rows keeps one runner slot; a second reservation is refused with `BridgeReservationError` and writes nothing.
  - The `Store.bridge` records keep the segment, its generation, stop epoch, manifest and quota guard identity; a stale generation or epoch is dropped, and the per-Ticket generation counter lives in `KV.bridge.generation` (`src/kv.ts`).
  - Uses the shared record types of `src/executor/prime-model.ts` (T010), which are still in flight in this branch.
- [x] T013 Add idempotent bridge launch, stop, reconcile and delivery effect types with transactional enqueue and stale-generation fencing in `src/app/effects.ts` (depends on T012).
  - `src/app/effects.ts`: the kinds `prime-launch`, `prime-stop`, `prime-reconcile`, `prime-deliver` and `prime-quota` join `EffectPayloads` and `EffectKind`. `Effects.enqueueOnce` ignores a repeated request while the same effect runs, and `Effects.enqueueSegment` drops an effect naming a generation older than the stored segment; `enqueueBridgeEffect` is the helper the coordinator uses inside a Store transaction.
  - The health words of the new kinds were added to `src/client/locales.ts`, and `tests/locales.spec.ts` lists them.
- [x] T014 Implement a typed process/containment adapter in `src/infra/prime-isolation.ts` and `src/executor/prime-supervisor.ts` with private user service/cgroup, socket, daemon and tmux identities, clean checkout, read-only controls, restricted writable paths and no-follow collection; fail closed for unsupported confinement (depends on T009, T010).
  - `src/infra/prime-isolation.ts`: `isolationPlan` derives the mounts and the command from the approved manifest and refuses a missing backend and a writable path that leaves the workspace or the repository; `buildBwrapArgs` returns the bubblewrap vector (unshared pid, ipc, uts and network, private `/proc`, tmpfs over the home and the host `/tmp`, the checkout read-only, only the approved paths writable, no descriptor beyond the standard streams); `systemdUnitName`, `cgroupPath`, `tmuxServerName` and `socketPath` derive collision-free identities from the segment ID; `cgroupProcesses`, `quiescenceState` and `isQuiescent` read the cgroup, where a missing cgroup is unknown and never quiescent; `collectArtifacts` collects without following links and refuses a symlink, a hard link out of the root and a root that is not a directory.
  - `src/executor/prime-supervisor.ts`: `PrimeSupervisor` launches the private identities and the confined runner and observes the durable session identity, `stop` returns `stopped`, `unconfirmed` or `unknown`, `quiescence` reads the same state without stopping, and `cleanup` refuses to remove anything while the state is unconfirmed.
- [x] T015 Implement independent containment probes in `src/infra/prime-isolation.ts` and `tests/prime-isolation.spec.ts` for filesystem, hardlink/symlink, `/proc`, IPC/socket, capabilities, inherited descriptors, cgroup escape, approved network policy and verifier credential separation (depends on T014).
  - The ten probes of `PROBE_KINDS` run through `probeContainment` and `containmentProbes`; each attempt reports an escape or a block, and a probe that reports no verdict counts as an escape. `verifyConfinement` returns the verdict with the reason of every failed probe. `sandboxProbeAttempt` runs the probe scripts inside the confinement with the paths passed as environment variables, so no value is interpolated into a script.
- [x] T016 Implement a bounded non-LLM quota watcher with per-run identity, explicit accounting scope, durable alert, independently supervised liveness and emergency cgroup-stop path in `src/executor/prime-quota.ts` and `scripts/prime-quota-guard.sh`; retain it while stop is uncertain and state account/child/credential coverage and possible overshoot (depends on T012–T015).
- [x] T017 Wire an exclusive deployment/store controller lock and durable startup reconciliation for open and ended Tickets before bridge launch effects can dispatch in `src/app/runtime.ts` and `src/executor/prime-bridge.ts` (depends on T012–T016).
  - Done 2026-11-01: the state-directory lock is exclusive, and `PrimeBridge.reconcileOpenSegments()` reconciles every unresolved segment, ended Tickets included, before a launch effect dispatches.

**Checkpoint**: The bridge remains disabled by default; a fake or unsafe environment
must not start real Prime work. The singleton reservation covers unknown processes.

## Phase 3: User Story 1 — Run an approved specification (Priority: P1)

**Goal**: Accept a verifiable authorized request for a prepared spec, execute one
bounded segment, and deliver one independently verified PR.

**Independent Test**: With fakes and a prepared no-gate fixture, approve an exact
manifest and exercise one run to one PR; reject missing/edited authorization, failed
preflight, stale result and duplicate launch or delivery.

### Tests for User Story 1

- [x] T018 [P] [US1] Test GitHub human allowlist, exact manifest approval, current policy/revocation and edited/deleted/stale comments in `tests/prime-approval.spec.ts`.
  - `tests/prime-approval.spec.ts` (11 tests): the exact approval comment form and the forms it refuses, the recorded approval of an allowlisted human, the refused bot, app, unknown account, missing account, unlisted human, wrong digest, edited comment, deleted comment, bare `yes`, stale policy version and foreign repository, the withdrawn approval after a revoked allowlist entry, the approval evidence of a re-read comment, and the record written through the Store's bridge approvals.
- [x] T019 [P] [US1] Test tool/flag/skill expansion, real-smoke adapter failures, no-destructive-preflight, hook/write restrictions and launch-barrier behavior with fakes in `tests/prime-preflight.spec.ts`.
  - `tests/prime-preflight.spec.ts` (24 tests): a complete preflight is `ready` and records the evidence; every single failing prerequisite (CLI version, flags, backend smoke, interpreter, checks, confinement, monitor, environment) blocks the launch and names the failed check and the next action; a missing check, a check the manifest does not approve, an unsupported flag, a rejected skill and an unknown skill all block; a skill that writes `.gitignore`, `.npmignore` and `.dockerignore` outside the approved paths blocks instead of running; the evidence keeps no secret value; the manifest is unchanged by the preflight.
  - `pnpm exec vitest run tests/prime-preflight.spec.ts` passes (24 passed).
- [x] T020 [P] [US1] Test strict report schema, untrusted wake/report, scope validation, scratch convergence, exact snapshot commit and separate credential-free verification in `tests/prime-result.spec.ts`.
  - `tests/prime-result.spec.ts` (34 tests): the strict report schema rejects an unknown key, a malformed value, a foreign segment, a stale generation, a stale stop epoch, and another manifest, and accepts the report of the current segment; the atomic structured report and its Markdown copy are ingested and a half-finished write is refused; the local wake signal is a hint only; a report that claims success with a missing or failed check blocks readiness, and the runner's own check output is never the proof; redaction removes an API key from a report and a bearer value from a notice; every failure cause maps to its own cause, summary, and next action, and an unknown error maps to a blocked failure; the snapshot digest changes when a file changes and a symlink out of the workspace is refused; the scope audit reports an out-of-scope write and blocks readiness; the result revision is the controller's own commit of the approved files and the checks are rerun against it; the assessment before a gate covers only the segment and labels the later tasks as not assessed, after the last segment it covers the whole scope, a third round is refused, and the findings stay proposals; the verdict separates the enforced controls from the instructed constraints, and a verdict without the controller's own convergence assessment is blocked.
  - `pnpm exec vitest run tests/prime-result.spec.ts` passes (34 passed).
- [x] T021 [P] [US1] Test same-repo exact branch PR claims, idempotent create/push, expected-old-SHA lease, stale/unknown outcomes and enforced no-auto-merge in `tests/prime-delivery.spec.ts`.

### Implementation for User Story 1

- [x] T022 [US1] Implement manifest-bound explicit approval and source evidence refetch/current-policy revalidation for allowlisted humans in `src/app/prime-approval.ts` and `src/sources/github-read.ts`; require immutable GitHub actor/repo identity and fail closed for missing/unknown bot/user type rather than trusting Trigger.human (depends on T010–T013, T018).
  - `src/app/prime-approval.ts`: `parseRunApproval` accepts only `@<agent> APPROVE RUN <manifest-sha256>` (and its `DENY RUN` counterpart) for that exact digest; `approveRun` re-reads the comment through the `ApprovalSource` port, requires an account of type `User` that is on the current allowlist, requires the comment to still carry the exact approval text, requires the named manifest to still be the approved manifest of the Ticket, requires the same repository and the same policy version, and records an `ApprovalRecord` of kind `run` with `environmentApproved` true through the `ApprovalStore` port, which the Store's `bridge.approvals` satisfies.
  - `src/sources/github-read.ts`: `readComment`, `readCommit`, `readBranchHead` and `readBranchProtection` read the comment, the commit with its verification, the branch head and the branch protection rules. A signature is bound to an account only when GitHub verifies it as a web edit signed on behalf of that account; a generic verified badge binds no account.
- [x] T023 [US1] Add approved manifest display and original-issue decision intake using existing Ticket attention and durable outbox in `src/app/tools/executor.ts`, `src/app/notices.ts` and `src/app/outbox.ts` (depends on T022).
  - Done 2026-11-01: `requestRun` in `src/app/prime-service.ts` keeps the manifest and asks the person in the original conversation; the `orchestrator_prime_request` tool starts it.
- [x] T024 [US1] Implement preflight for Prime flags, isolated skill expansion, actual backend/auth smoke adapters, interpreter, safe hooks, checks, isolation and monitor registration in `src/executor/prime-preflight.ts` (depends on T014–T016, T019, T022).
  - `src/executor/prime-preflight.ts`: the `PreflightHost` port has one seam per check (version, flags, backend smoke, skill expansion, interpreter, checks, confinement, monitor, environment), so no test needs a real CLI, backend or network. `preflight(manifest, host)` runs every check in a fixed order and fails closed: a failed check, a missing check, a check the manifest does not approve, an unsupported flag, an unpinned hook and a write outside the approved paths all block the launch, and every failure names the prerequisite and the next action. `checkPlan(manifest)` gives the coordinator the ordered plan with what a failure of each check means. `preflightEvidence(verdict)` is the durable record with the CLI version, the confirmed flags, the skill expansion result, the interpreter version, the check results and the confinement and monitor results, with the secret-looking values redacted and only the credential categories kept. `toolExpansion` and `flagSupport` are the pure helpers the tests pin.
- [x] T025 [US1] Implement a bounded `prime-agent --autonomous` launch with deterministic identities, private socket/daemon, exact approved workspace and bootstrap barrier in `src/executor/prime-supervisor.ts` and `src/executor/prime-bridge.ts` (depends on T017, T024). The invocation is built from the approved manifest in `src/executor/prime-launch.ts`; the runner starts in the background and its durable identity is awaited, and the barrier is released only after that identity is known, so the runner cannot work before the controller can reconcile it. The preflight now checks exactly the flags the launch uses.
- [x] T026 [US1] Add atomic structured/Markdown report ingestion and local wake with non-LLM reconciliation fallback, rejecting stale or malformed run identities in `src/executor/prime-report.ts` and `src/executor/prime-bridge.ts` (depends on T013, T020, T025).
  - `src/executor/prime-report.ts`: `readRunnerReport` reads the structured report from the run-owned storage and refuses a storage that still holds the temporary file of an unfinished write; `readRunnerReportMarkdown` reads the human-readable copy; `ingestRunnerReport` binds the report to the segment, generation, stop epoch, and manifest the controller expects and rejects a stale or malformed one; `readRunnerWake` reads the run-specific local wake signal, which is only a hint; `parseRunnerReport` applies the strict schema.
  - `src/executor/prime-bridge.ts`: the `prime-reconcile` effect is the non-LLM reconciliation fallback; it retries on a low-frequency schedule, and the effect queue drops an effect that names an older generation, so a stale or malformed run identity never reaches the report.
  - The runner adapter of the service reads the report through `ingestRunnerReport`; that adapter belongs to the launch task (T025), so this task delivers the ingestion it uses. The file watcher that turns the wake signal into a reconcile effect also belongs to T025 and T017; the wake signal itself is read here and stays a hint.
- [x] T027 [US1] Implement approved-scope snapshot collection, controller-created commit and combined runner/controller report binding, scratch-based bounded/full convergence and separately confined exact-revision verification in `src/executor/prime-verify.ts` (depends on T003, T011, T015, T026).
  - `src/executor/prime-verify.ts`: `collectSnapshot` collects the workspace the runner produced with a digest per file and one digest for the whole snapshot, follows no symlink out of the workspace, and leaves the control state out; `scopeAudit` reports the writes outside the approved paths; `createResultRevision` creates the controller's own commit of the approved files, so the revision is the controller's attestation and not the runner's; `rerunChecks` reruns the approved checks against that exact revision in a verifier whose environment may name no credential, and a check that does not run counts as a failed check; `assess` runs the convergence on a scratch copy, at most two rounds, covers only the authorized segment before a gate and labels the later tasks as not assessed, covers the whole approved scope after the last segment, and keeps its findings as proposals that change no scope and add no task; `verify` is the whole verdict, and it lists the enforced controls apart from the instructed constraints.
- [x] T028 [US1] Implement revalidated PR creation/update and claim, push with expected-old-SHA, server-enforced no-merge prerequisites and durable unknown remote outcome in `src/sources/github-pull.ts` and `src/executor/prime-delivery.ts` (depends on T021, T022, T027).
- [x] T029 [US1] Map verified complete reports to Ticket `ready` with open PR, approved evidence and durable reply; block unverified/incomplete results in `src/app/tools/executor.ts` and `src/executor/prime-bridge.ts` (depends on T028).
  - Done 2026-11-01: a verified result maps the Ticket to `ready` with the open pull request and the durable reply; anything unverified blocks it.

**Checkpoint**: This story's happy path is demoable with fakes, but it is not a safe
release until the P1 gate, stop/recovery, and quota controls below also pass.

## Phase 4: User Story 2 — Review an explicit human gate (Priority: P1)

**Goal**: Stop before a manual task and resume only after an authorized, auditable
human action and explicit decision tied to the exact manifest and branch.

**Independent Test**: Using a gate fixture, show a draft PR and actionable question,
then prove an authorized verified human-only checkbox commit plus gate approval allows
a new segment; all other responses and subsequent tasks remain blocked.

### Tests for User Story 2

- [x] T030 [P] [US2] Test untouched gate/later tasks, bound draft PR, original-channel attention and inaccessible conversation using `tests/prime-human-gate.spec.ts`.
  - `tests/prime-human-gate.spec.ts` (15 tests): the segment stops before the gate and the gate and later tasks stay untouched while the run waits; the question names the gate, the manifest digest, and the one-checkbox edit bound to the reviewer's identity; the durable evidence keeps the gate identity, the question, the result evidence, and the stop confirmation; the bound draft pull request presents the evidence, stays a draft, and never marks the ticket or feature ready; the decision request goes to the original conversation, and an unreachable conversation keeps the evidence available and the continuation blocked; the next segment covers only the work after the gate, stops before the next gate, and starts only after an approved, verified, bound decision that the human also marked complete; a generic wake, a bot comment, a runner report, and a pull request review are never a gate approval; the assessment before a gate covers only the segment and records the later tasks as not assessed.
  - `pnpm exec vitest run tests/prime-human-gate.spec.ts` passes (15 passed).
- [x] T031 [P] [US2] Test verified signer-to-allowlisted-human binding, exact one-checkbox diff, quoted/wrong/stale/edited/denied decisions and policy changes in `tests/prime-gate-approval.spec.ts`.
  - `tests/prime-gate-approval.spec.ts` (14 tests): the verified gate commit by the allowlisted human, the refused unsigned commit, generic badge, unlisted signer, wrong author, bot author, unknown author type, other parent, other branch head, two changed lines, changed text beside the marker, wrong task, wrong file and edited marker; the recorded decision, the refused denied, unrelated, stale, wrong-commit, edited and deleted decisions, the unauthorized, bot-authored and different-human decisions, the plain `yes` and pull request review, the changed policy version, and the withdrawn decision after a revoked allowlist entry.

### Implementation for User Story 2

- [x] T032 [US2] Implement gate-aware scratch assessment with explicit unassessed later tasks, at most two rounds and newly discovered work requiring a new approved manifest in `src/executor/prime-verify.ts` (depends on T027, T030).
  - Done 2026-11-01: the assessment is bounded to two rounds on a scratch copy, covers only the segment before a gate, labels the later tasks as not assessed, and keeps the findings as proposals.
  - Part delivered: the gate-aware scope lives in `src/executor/prime-gate.ts` (`gateAssessmentScope`: the segment only before a gate, the gate and the later tasks as not assessed, findings as proposals) and is tested in `tests/prime-human-gate.spec.ts`. Still open: the wiring of that scope into the scratch assessment of `src/executor/prime-verify.ts`, which this task owns and which was out of the file scope of this change.
- [x] T033 [US2] Persist gate identity, question, result evidence and stop confirmation; bind an optional draft PR and deliver one human-action request without `ready` in `src/executor/prime-bridge.ts` and `src/app/tools/executor.ts` (depends on T026, T028, T030).
  - Done 2026-11-01: the gate identity, the question, the evidence, and the bound draft pull request are persisted, and the Ticket is never `ready` at a gate.
  - Part delivered: the durable gate record and the decision request live in `src/executor/prime-gate.ts` (`gateEvidence`: gate ID, question, result evidence, stop confirmation, optional draft pull request with its evidence body; `gateDecisionRequest` and `gateWait`: the request goes to the original conversation, an unreachable conversation keeps the evidence available and the continuation blocked; `gateDecisionCandidate`: only a human comment may be read as a decision). Still open: persisting that record through `src/app/store.ts` and delivering the request through `src/app/tools/executor.ts`, which this task owns and which was out of the file scope of this change.
- [x] T034 [US2] Verify exact GitHub-authenticated gate commit, independently bound signer/human identity, T002 signer/approver relationship, revocation, parent/head, one-checkbox diff and bound decision in `src/app/prime-approval.ts` and `src/sources/github-read.ts` (depends on T002, T022, T031, T033).
  - `src/app/prime-approval.ts`: `verifyGateCommit` requires a verified commit whose signer is on the current allowlist, whose author is exactly that account and of type `User`, whose parent is the expected pre-gate revision, whose head is the expected one, and whose diff changes only the expected `[ ]` to `[x]` on the expected task line of the task list. `verifyGateDecision` requires the decision comment to name the gate, the manifest digest and the full gate commit SHA, and to come from the same currently allowlisted human who made the gate edit. `revoke` and `approvalIsCurrent` withdraw a decision when the allowlist entry is revoked.
  - `src/sources/github-read.ts`: `readCommit` returns the parent, the author, the verification and the changed lines of one commit, and binds the verified signature to the acting account only for a GitHub web edit.
- [x] T035 [US2] Revalidate policy, manifest, environment, gate decision, stop epoch and prior quiescence before atomically reserving a separately bounded next segment in `src/executor/prime-bridge.ts` (depends on T032–T034).
  - Done 2026-11-01: `resumeAfterGate` revalidates the manifest digest, the allowlist of the recorded decision, and the prior quiescence before it reserves the next segment atomically.

**Checkpoint**: Generic Ticket wake, bot comments, report text and ordinary PR approval
never act as gate approval; unsupported proof blocks instead of bypassing review.

## Phase 5: User Story 3 — Stop and recover long-running work (Priority: P1)

**Goal**: Stop the full owned process boundary or honestly report uncertainty, and
reconcile after restart without duplicate runners or external actions.

**Independent Test**: With a disposable nested process and fakes, stop an active
Ticket and confirm the cgroup is empty; exercise crash/unknown-stop windows and
prove reservation and monitoring remain while duplicate launch is blocked.

### Tests for User Story 3

- [x] T036 [P] [US3] Test atomic stop tombstone/effect, stale callbacks and stop-versus-launch/approval/report/publication races in `tests/prime-stop.spec.ts`.
- [x] T037 [P] [US3] Test restart recovery for ended Tickets, crash-before-identity, orphan/unknown runner, lost notification, monitor retention and idempotent replay in `tests/prime-recovery.spec.ts`.
- [x] T038 [P] [US3] Test unknown in-flight GitHub call, delayed visibility and failed push lease reconciliation with no blind duplicate publication in `tests/prime-publication-race.spec.ts`.

### Implementation for User Story 3

- [x] T039 [US3] Persist bridge stop epoch and durable stop effect in the same Ticket-ending transaction by integrating `src/core/tickets.ts`, `src/core/ports.ts` and `src/executor/dsh.ts` without moving I/O into core (depends on T012–T013, T036).
  - Done 2026-11-01: `DshExecutor.stop` calls `bridge.requestStop` inside the Ticket-ending transaction, which writes the stop epoch, the tombstone, and the durable stop effect in one transaction.
- [x] T040 [US3] Implement exact private Prime/service cancellation and verified empty-cgroup confirmation in `src/executor/prime-supervisor.ts`; keep unknown runners locked/guarded and surface unconfirmed stop (depends on T016, T039).
  - Done 2026-11-01: the supervisor cancels the exact private daemon and session and proves the stop with an empty cgroup; the coordinator keeps the guard and the reservation while the stop is unconfirmed.
- [x] T041 [US3] Reconcile identity, runner, workspace, guard, report and GitHub state at startup and retry, including human-stopped/ended Tickets, in `src/executor/prime-bridge.ts` and `src/app/runtime.ts` (depends on T017, T037, T040).
  - Done 2026-11-01: `decideRecovery` in `src/executor/prime-recovery.ts` and the coordinator's reconciliation, which holds a segment whose state cannot be established, ended Tickets included.
- [x] T042 [US3] Fence stale effects and serialize stop with delivery initiation; retain `unknown` or `delivered-after-stop` for operator reconciliation rather than claiming remote rollback in `src/executor/prime-delivery.ts` and `src/app/effects.ts` (depends on T001, T028, T036, T038–T041).
  - Done 2026-11-01: the stop fence wraps every external action, and an unknown remote outcome is retained for the operator and never reported as a rollback.
- [x] T043 [US3] Expose operator-visible confirmed/unconfirmed stop and unresolved bridge state on the existing Ticket/system surface, including ended Tickets, in `src/app/views/overview.ts` and `src/client/route.ts` (depends on T040–T041).
  - Done 2026-11-01: the overview view lists the unresolved runs, the panel shows them, and `bridgeRoute` opens the Ticket's execution page.

**Checkpoint**: Stop acknowledgment or Prime `idle` alone is not proof of quiescence;
unknown state retains the reservation and the external quota guard.

## Phase 6: User Story 4 — Understand failures and protect resources (Priority: P2)

**Goal**: Distinguish preflight, provider, dependency, check, guard and quota failures;
keep resource controls active and actionable without false readiness.

**Independent Test**: Simulate failure of each required prerequisite and monitor path;
verify a durable actionable blocker, no release of unguarded work, and cleanup only
after confirmed quiescence without touching unrelated runs.

### Tests for User Story 4

- [x] T044 [P] [US4] Test silent green quota guard, explicit billing coverage/limits, unreadable metrics, warning, threshold stop, controller crash, guard liveness loss and independent emergency stop in `tests/prime-quota.spec.ts`.
- [x] T045 [P] [US4] Test distinct dependency/provider/quota/preflight/check/report failures and secret redaction in `tests/prime-failures.spec.ts`.

### Implementation for User Story 4

- [x] T046 [US4] Integrate per-run cron guard lifecycle, liveness and emergency stop with durable alerts and independent target verification in `src/executor/prime-quota.ts`, `scripts/prime-quota-guard.sh` and `src/executor/prime-bridge.ts` (depends on T016, T040–T041, T044).
- [x] T047 [US4] Map and persist distinct blocked/failed causes, check evidence, quota coverage and operator next action without leaking secrets in `src/executor/prime-report.ts` and `src/app/notices.ts` (depends on T026, T045–T046).
- [x] T048 [US4] Clean up only bridge-owned guard, service, daemon and workspace resources after independently confirmed quiescence in `src/executor/prime-supervisor.ts` and `src/executor/prime-quota.ts` (depends on T040, T046).

**Checkpoint**: An unreadable guard or unavailable monitor fails closed; a token limit
is not described as an account-wide billed quota guarantee.

## Phase 7: Polish and cross-cutting validation

- [x] T049 [P] Update English deployment, permissions, allowlist, human-gate, actual isolation, signed-commit, stop/recovery, quota limitations and manual merge instructions in `docs/006-deployment.md` and `docs/003-execution.md` (depends on T035, T042, T047–T048).
  - Done 2026-11-01: `docs/006-deployment.md` and `docs/003-execution.md` describe the deployment, the permissions, the allowlist, the human gate, the actual isolation, the signed commit, the stop and recovery, the quota limitations, and the manual merge.
- [x] T050 [P] Update the implementation/ownership map and test index in `docs/007-architecture.md`, keeping numbered-document link order intact (depends on T029, T035, T042, T047–T048).
  - Done 2026-11-01: `docs/007-architecture.md` lists every new module and test; the numbered-document link order is unchanged.
- [x] T051 Update `specs/001-prime-runner-bridge/quickstart.md` with actual implemented local test, setup and cleanup commands and explicit operator authorization requirements (depends on T029, T035, T042, T047–T048).
  - Done 2026-11-01: `quickstart.md` sections 0 and 5 hold the verified commands, the implemented modules, the guard invocation, the cleanup rule, and the operator authorizations.
- [x] T052 Run focused test suites from `tests/prime-*.spec.ts` and the full `pnpm check` from `package.json`; record actual commands, exit codes and blockers in `specs/001-prime-runner-bridge/runner-report.md` (depends on T029, T035, T042–T048). The spike evidence lives in `specs/001-prime-runner-bridge/runtime-report.md` and is not overwritten by this report.
  - Done 2026-11-01: the commands and their exit codes are recorded in `runner-report.md` section 2.
- [x] T053 Run the operator-authorized isolated Linux namespace/cgroup and emergency-watcher tests specified in `specs/001-prime-runner-bridge/quickstart.md` without real credentials; record evidence and disable rollout on any unsupported or failed control in `specs/001-prime-runner-bridge/runner-report.md` (depends on T015, T040–T048). The host mechanisms this covers are already proven in `specs/001-prime-runner-bridge/runtime-report.md`; this task proves the implementation's own use of them. The implementation's cgroup path was wrong: it created a directory under the root-owned `/sys/fs/cgroup/prime-runner`, which no unprivileged account may write. The run's own user service unit now creates the cgroup under the delegated root, and `tests/prime-cgroup-delegation.spec.ts` proves the delegation, the kill file, and the empty process list that proves a stop.
- [ ] T054 MANUAL GATE — In `specs/001-prime-runner-bridge/runner-report.md`, obtain explicit operator approval for a disposable real-backend/GitHub smoke and signer-binding/branch-protection feasibility checks: identify host, accounts, credential categories, repository, quotas, irreversible actions and cleanup; never request or record secret values (depends on T052–T053). The proposal is `specs/001-prime-runner-bridge/t054-plan.md`: three separately authorized parts, the host and accounts named, the four irreversible actions named, the cleanup named, and the operator's decisions listed. Nothing of it has been started.
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
