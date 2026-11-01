# Contract: Prime Runner Bridge

This is a design contract, not an existing public API. The bridge operates within the
existing GitHub Source and Ticket lifecycle; it does not add an unauthenticated
network endpoint. The controller stores external events and evidence as untrusted
inputs and never lets a report, repository document, bot message, or notification
modify a Mandate or approval.

## 1. GitHub request and approval

1. A configured, currently allowlisted GitHub human explicitly requests execution
   of one repository-relative feature directory in the Ticket's issue. Existing
   Source admission and Mandate rules remain authoritative; allowlist membership
   is an additional V1 restriction for approvers. The operator vets the account.
2. The controller resolves the tracked base commit and all approved artifacts from
   that revision, validates required files and task grammar, fixes permitted paths,
   checks, run limits, and execution environment, and presents the manifest digest
   and readable scope/environment summary in a structured attention message.
3. A currently allowlisted human posts an explicit decision, as a new original-
   conversation comment: `@<agent> APPROVE RUN <manifest-sha256>`. The human has reviewed
   that exact manifest and its environment/credential summary. The controller records
   source ID, immutable actor ID, comment/version and contents, current Policy and
   manifest. A simple `yes`, copied quote, bot, unrelated message, edited or deleted
   comment, unverifiable source, or mismatched digest is not approval.
4. Re-fetch the actual GitHub comment and current actor/allowlist/policy, and compare
   current manifest and environment before launch, each continuation, and delivery.
   A scope or environment change requires a new approved manifest. Follow-up delivery
   or general Ticket wake is not itself permission to launch.

**Canonical manifest**: schema version 1; UTF-8 JSON, recursively sorted keys,
using RFC 8785 JSON Canonicalization Scheme; arrays remain in semantic order.
SHA-256 is taken over those exact UTF-8 bytes. Reject non-I-JSON values and include
canonicalization test vectors in implementation tests.
Use full canonical GitHub repository ID, full Git commit ID, SHA-256 exact content
hashes, canonical repo-relative path list, exact checks/limits, and environment policy
hash. Pin all authority-bearing project guidance, constitution, hook configuration,
check scripts, required tool versions and the full baseline Git tree. Materialize a
clean checkout: unsupported submodules, LFS, ignored or untracked inputs block until
explicitly addressed. Reject duplicate keys, invalid Unicode, absolute paths, `..`, symlink escapes,
ambiguous identifiers and non-finite numbers. The canonical bytes must be visible to
both operator and controller. Never include secret values.

## 2. Human-gate protocol

- After a runner stops and confirmed quiescence is recorded, report a single pending
  gate ID and evidence, and open/update a Ticket-bound **draft** PR if needed. Bind
  it using the existing same-repository/agent-account branch rules; confirm exact
  branch, head and open state. The Ticket is waiting for the human, not `ready`.
- The human reviews evidence, then uses a GitHub-authenticated web edit to make
  exactly the expected `[ ]` → `[x]` change on that one gate line on the Ticket
  branch. V1 requires a GitHub verified commit whose verified signer is explicitly
  bound to a currently allowlisted human identity by independently verifiable GitHub
  evidence; matching author text or a generic Verified badge is insufficient. If
  GitHub cannot supply that binding, the action is unsupported and blocks. Protected branch
  rules that prevent this flow produce a blocker, not an agent-authored checkbox.
- The human adds `@<agent> APPROVE GATE <gate-id> <manifest-sha256> <full-gate-commit>`
  to the original Ticket conversation. The coordinator fetches commit, verification,
  exact parent/head and diff, comment and identity; requires only that gate marker
  change and records both pieces of evidence. PR review or CI alone is not consent.
- A denied, unrelated, stale, edited, deleted, unauthorized, bot-authored, missing,
  or unverifiable decision cannot resume. Recheck Ticket stop, manifest, branch head,
  current Policy and environment before reserving the next segment. An out-of-scope
  request is handed back to Eval; it does not enlarge the existing Mandate.

## 3. Controller ↔ runner adapter

**Reserve**: `ticketId`, `assignmentId`, `segmentId`, `generation`, `manifestId`,
expected branch and workspace, task range, next gate, stop epoch, unit/socket/tmux
identities and quota guard. Create a single global nonterminal reservation and durable
launch effect in one Store transaction. A replay uses this identity, not a fresh one.

**Preflight**: validate Prime version and required flags; real backend/auth smoke
calls; skill expansion in an isolated cheap test; interpreter and checks; repository,
branch, sandbox confinement, dedicated daemon, quota and monitor. Check exact content
and approval. Failure blocks before task launch or destructive changes.

**Launch**: start a dedicated per-run supervised service with an isolated filesystem,
service cgroup, private Prime daemon/socket and tmux server. Create identity before
work begins. A bootstrap release requires a committed reservation, verified monitor,
scope/environment approval and a controller acknowledgment; it must fail closed on
controller failure. Persist the durable session ID/file and execution unit identity.
When spawn outcome or session identity is unknown, hold reservation and reconcile;
never create another runner merely because the first CLI call failed or returned no ID.

**Completion**: write `runner-report.md` plus a schema-validated structured report
atomically under run-owned storage, recording the workspace state the runner produced
without a result revision. A run-specific local wake signal is only a hint;
startup and low-frequency non-LLM reconciliation cover lost signals. It carries no
credentials and cannot authorize work. On completion, prove the service/cgroup is
quiescent; otherwise retain the slot and guard. Validate segment/generation/epoch,
workspace snapshot digest, diff, permitted task progress and artifacts. The controller
creates a candidate commit from the approved snapshot and binds the report to that SHA.
Run convergence on an isolated scratch copy; findings are proposals and require a new
approved manifest before they are added to the Ticket workspace. Rerun checks
independently against the exact candidate revision in a separate confined verifier
with no GitHub, controller or model credentials; verify no mutation during
verification, and inspect PR/head and approval before delivery. Logs are sanitized
and never treated as proof that secret values cannot leak.

**Stop**: record stop intent and increment epoch transactionally with Ticket ending,
then enqueue durable stop. Stop the exact private daemon/service, cancel the Prime
session, and verify the run cgroup is empty. Do not treat `prime-agent stop` return,
`idle`, or tmux disappearance alone as proof. While unconfirmed, keep scope locked,
quota monitoring active, capacity reserved and display operator attention, including
on ended Tickets. Do not deliver late results. Unknown in-flight GitHub actions are
reconciled; the controller does not promise to reverse a remote accepted mutation.

**Quota**: for metered models install one external cron-based guard with explicit
session/log, billing semantics, thresholds and durable alert target. Monitor setup
must be established before task work starts. Missing/unreadable accounting or guard
setup blocks launch; the adapter must report coverage limitations. External liveness
monitoring and a narrowly scoped emergency service-cgroup stop must survive controller
outage and guard failure, and retain a durable alert for recovery. A warning records an
alert; a stop threshold or monitoring failure triggers the controller stop path, or
emergency path if the controller is unavailable. The stop is confirmed independently;
monitoring interval and accounting gaps mean overshoot is possible. Remove only the
run's own monitor and service after confirmed quiescence. No LLM heartbeat is used.

**Convergence and hooks**: The installed `/skill:speckit-converge` assesses the full
feature and may append tasks, including intentional future gated tasks. Before a gate,
use a gate-aware assessment on a scratch copy limited to the approved segment; it
must explicitly label later tasks unassessed, not falsely claim full convergence.
At the final segment run the full assessment on scratch with a maximum of two rounds;
new findings require a new approved manifest before implementation. The adapter's
assessment semantics MUST be proven against the installed skill, not simulated. Preflight all
Spec Kit hooks and incidental writes (including ignore-file changes); unapproved
commands, hooks or writes block rather than silently run outside the manifest. The
exact gate-aware adapter and supported hook semantics are implementation acceptance
criteria, not claims about the installed command.

## 4. Result/report schema

```json
{
  "schemaVersion": 1,
  "ticketId": "ticket-id",
  "assignmentId": "assignment-id",
  "segmentId": "uuid",
  "generation": 1,
  "stopEpoch": 0,
  "manifestSha256": "64 lowercase hex characters",
  "baselineRevision": "full baseline commit SHA",
  "outcome": "gate|complete|blocked|failed",
  "workspaceSnapshotSha256": "64 lowercase hex characters",
  "completedTaskIds": ["T001"],
  "remainingTaskIds": ["T002"],
  "nextGateId": "T002 or null",
  "checks": [{"name": "approved check", "exitCode": 0, "evidence": "relative path"}],
  "convergence": {"rounds": 1, "status": "converged|deferred-at-gate|findings"},
  "summary": "brief human-readable evidence and blockers",
  "risksAndBlockers": ["human-readable limitation"]
}
```

Report files and local notifications are untrusted. The controller validates the
snapshot digest after quiescence, creates `resultRevision` as a separate attestation,
then reruns checks against it; only the controller signs/pushes and creates/updates
the PR. Runner report evidence is not independent proof. The durable report keeps the
runner's observed part and the controller's verified part distinguishable, and the
controller's part MUST state which controls were enforced and which were only
instructed. All variable identifiers are validated and passed as argument
vectors, not interpolated into shells. Reject unknown keys, malformed values,
unauthorized paths and reports whose generation/epoch no longer matches.

## 5. Safety, delivery and failure contract

- No more than one active or unknown run; additional work queues. Retry, restart,
  duplicate input or event never creates another run without a reconciled reservation.
- The private service must prove it cannot write outside approved paths, access host
  daemon sockets/home/credentials, or write GitHub. These are the enforced controls.
  The task order inside an allowed path is instructed, not enforced: where a task
  boundary cannot be held, the segment stops for a human decision and the report
  says so. Unsupported confinement blocks.
  Apply no-follow file collection, safe hardlink/symlink handling and canonical
  paths for new files and renames. Exclude control artifacts even within a permitted
  parent. Isolation MUST additionally close inherited descriptors, remove unsafe capabilities,
  prevent namespace/cgroup escape, and restrict mounts, `/proc`, IPC, sockets and
  symlink traversal. Approved network access and credential injection are limited to
  what the work requires. The manifest defines allowed external effects, endpoints and
  credentials; prevent all other writes and require separate approval for non-idempotent
  effects. A model credential visible to the runner is not secret from that runner;
  endpoint allowlisting alone cannot prevent exfiltration. Use scoped, revocable
  credentials and disclose this residual risk.
  Normal test output goes to isolated scratch; the controller decides which permitted
  artifacts are retained.
- A pass of a required check must be independently reproduced against the exact
  revision; out-of-scope diffs, failed or stale checks, changed approval, unresolved
  convergence, uncertain stop, or unknown PR outcome block readiness.
- The coordinator owns PR creation and writes via existing Source/outbox conventions,
  using deterministic operation identifiers and a current epoch. Never retry an
  unknown mutation until the original call has completed and the remote result is
  reconciled; if uniqueness cannot be established, retain an operator-resolved
  unknown state. Push refs with an expected-old-SHA lease; never overwrite a changed
  head. Re-read branch/head, open/draft state and auto-merge state. No GitHub write credentials are
  made available to the runner. The controller's publishing identity is subject to a
  server-enforced branch protection rule that forbids its merge and bypass privileges;
  repository Contents write alone can grant merge power and is not sufficient. Verify
  the protection before launch. Never enable auto-merge; if already enabled, block and
  request human resolution. PR creation is not `ready` by itself.
- Controller restart reconciles reservations for ended as well as open Tickets before
  launching anything. Domain Ticket end and external process end are distinct facts.
  Persist/replay stop effects; preserve guard/reservation if no proof of quiescence.
