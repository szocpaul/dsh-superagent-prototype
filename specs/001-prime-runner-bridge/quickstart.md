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

## 1. Run existing checks

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

## Evidence to retain

Record the manifest digest, Ticket and segment IDs, GitHub approval IDs, baseline and
result revisions, actual checks and exit codes, containment test results, guard scope,
stop confirmation, PR URL and any unavailable checks. Store no secrets. The exact
implementation-specific commands for bridge setup and invocation must be added to
this guide and operator documentation when the interfaces exist.
