# Data Model: Prime Runner Bridge

All names below describe proposed records and are not claims about the existing
implementation. Use the current Store transaction and durable Effects queue. The
Engine remains the authority for Tickets and Mandates; bridge records reference it.

## Approved manifest

- `manifestId`: SHA-256 of a versioned canonical encoding; the encoded bytes are
  retained. Exact canonical JSON encoding and path normalization are specified in
  [contracts/bridge.md](contracts/bridge.md).
- `repository`: stable GitHub repository ID and canonical owner/name.
- `featureDir`: normalized repository-relative feature path.
- `baselineCommit`: full immutable commit SHA; `specHash`, `planHash`, `tasksHash`:
  SHA-256 of exact baseline bytes from that commit.
- `allowedPaths`: unique normalized repository-relative files or directories that
  can be mounted writable in the selected isolation backend. The specification,
  plan, constitution, approval data, and `.git` metadata are never writable by the
  runner; only authorized task checkbox edits are allowed in `tasks.md` and verified
  immediately after each segment. If file-level task edits cannot be isolated from
  unauthorized edits during execution, the segment cannot start until a safe staging
  arrangement is available.
- `tasks`: ordered task IDs, dependency/order, type (`automated` or `human`), and
  original line/marker; IDs and gate markers must be unambiguous and unique.
- `checks`: exact operator-approved commands, cwd, timeout/limits and required
  dependencies; commands are stored as argument vectors, not untrusted shell text.
  Pin the baseline Git tree, constitution, repository guidance, hook configuration,
  check scripts, selected tool versions, and authorized external effects. Reject
  unsupported submodules, LFS, ignored or untracked inputs; never persist secrets.
- `environment`: stable deployment identity, runner and model identity, allowed
  credential categories (never values), isolation policy, network access, quota
  thresholds and limits; its digest is part of the manifest.

**Validation**: repository ID and path resolve within the configured repository;
no path escapes or symlinks to outside, broad writable root, `.git`, operator home,
or control state. Verify actual mounts and credentials, not merely manifest text.
Manifest and approval evidence are immutable; a changed manifest needs a new approval.

## Approval

- `approvalId`, `manifestId`, `ticketId`, originating `triggerId`, policy version,
  GitHub repository ID, comment/review URL, comment ID and version/content digest,
  actor stable GitHub ID/login, timestamp, approved manifest digest, and decision.
- `environmentApproved`: explicit acknowledgement of the named environment,
  isolation limits, and credential categories, included in the same decision.

**Validation**: exact approval protocol and actor current allowlist membership;
GitHub-authenticated identity must resolve to the same human account, and the source
must still contain the matching unedited affirmative. Current Policy and Mandate must
permit the work; no unlisted, bot, copied, deleted, altered, stale, or ambiguous
approval. On verification failure, block without launching.

## Segment reservation and runner

- `segmentId`: immutable random UUID; `ticketId`, `assignmentId`, monotonic
  `generation`, approved `manifestId`, segment start and next gate IDs.
- `phase`: `reserved`, `preflight`, `launching`, `running`, `stopping`, `stopped`,
  `gate_wait`, `verifying`, `ready`, `blocked`, `failed`, or `unknown`.
- `stopEpoch` / cancellation intent; deterministic service-unit, cgroup, tmux server,
  socket, Prime durable session ID and session-file identity; workspace path and
  ticket branch; monitor ownership; timestamps and current revision.
- `reportId`, `snapshotDigest`, controller-created `resultRevision`, check evidence,
  `prNumber`, publication state, reconciliation findings, and exact current
  Policy/version as observed.

**Invariants**: A durable transactional reservation owns the single capacity slot
before any process starts; `unknown` or unconfirmed stop retains it. Duplicate
requests and effects are idempotent. A completed gate can release capacity only after
runner quiescence; later segments use new generations. Stale callbacks must compare
segment ID, assignment, generation and stop epoch. A running external mutation is a
separate in-flight effect whose unknown outcome blocks retry or claims of rollback.

## Gate decision

- `gateId`, `segmentId`, `manifestId`, exact question, expected task line,
  pre-gate branch/revision, confirmed runner stop, `draftPrNumber` and evidence.
- Human's gate-only commit, resulting revision and signature with independently
  verified binding to the allowlisted human; explicit decision comment ID/version
  and authorized actor; time. A generic Verified badge or author text is insufficient.

**Validation**: Gate commit changes only the matching marker, verifies as a GitHub-
associated allowlisted human, and is on the exact expected branch/head. Approval
comment identifies gate, manifest and commit; unrelated approvals or plain `yes` do
not count. Require successful validation again before next segment. If source, status,
review evidence, original conversation, commit verification or permissions cannot
be fetched, remain blocked. A stop invalidates pending continuation.

## Run report and verification

- Runner report: `segmentId`, manifest, baseline revision, generation and stop epoch,
  workspace snapshot digest and timestamps; completed and remaining task IDs; pending
  gate/decision; converge results; checks, exit codes and evidence paths; limitations.
- Controller-owned verification: report hash, scope audit, controller-created result
  revision, independently re-run checks against it, current head, approval and Ticket
  epoch, PR state, verification start/end revisions, and final decision.

**Validation**: The report is data, not authority. Validate its strict schema and
run identity; reject stale/malformed reports and evidence outside owned directories.
Do not mark ready unless independently verified revision remains unchanged, the
approved paths and progress match, convergence is valid, the Ticket is live and
unstopped, approval remains valid, and a same-repo Ticket PR is open, reviewable and
not auto-merge-enabled. Fail closed when evidence is unavailable.

## State transitions

```text
request → manifest awaiting approval → approved
  → reserved → preflight → launching → running
  → stopping → stopped → gate_wait → [human action] → next reserved
  → verifying → ready (PR open for review)
  → blocked/failed [operator action and reconciliation]
  → unknown [reservation and guard retained; operator resolves]
```

Any state may receive a stop intent. A stop fences publication and launch at the
transaction boundary; termination and confirmation are asynchronous durable effects.
A GitHub operation already in flight is reconciled, not presumed rolled back. A new
segment is possible only after a valid gate decision, a live authorized Ticket and
confirmed prior stop; a stopped Ticket needs new authorization rather than automatic
continuation. No automatic merge is permitted.
