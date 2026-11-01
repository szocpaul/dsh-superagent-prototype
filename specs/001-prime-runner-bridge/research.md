# Research: Prime Runner Bridge

## 1. Ownership and durable side effects

**Decision**: Add a host-owned bridge coordinator with a small Prime adapter. Keep
Ticket admission, Mandates, and replies in the existing Engine. Persist approval,
segment reservation, stop intent, and effects in the existing SQLite Store. Run
external side effects only after commit and make effect handlers reconcile before
retry. At most one unresolved segment may hold the global runner reservation.

**Rationale**: `src/core/ports.ts` requires Executor operations to enqueue work;
`src/app/store.ts` provides `atomic` savepoints; `src/app/effects.ts` implements a
persistent at-least-once queue. `DshExecutor` background jobs and in-memory worker
slots do not track or limit independently daemonized Prime sessions. SQLite commits
cannot atomically commit a remote operation or process creation. Unknown outcomes
must stay reserved and blocked, not be retried as if nothing happened.

**Alternatives considered**: Prompt-only delegation, a DSH background shell, and
using the existing worker-slot count. They do not survive or control Prime's separate
lifecycle; DSH shell jobs are time-limited and its worker slots have an extra human
follow-up slot. A separate orchestration service duplicates Ticket ownership.

## 2. Authority, approval and allowed scope

**Decision**: Require a currently allowlisted GitHub human for this first-version
approval protocol, in addition to normal host admission. Bind a source-verified
explicit approval to a canonical manifest containing repository identity, feature,
base commit, exact spec/plan/tasks hashes, explicit allowed paths, checks, limits,
and an environment descriptor including identity and credential access. Present the
manifest digest to the human before accepting approval. Re-fetch and revalidate the
source evidence and current Policy at launch, continuation, and delivery; failure to
verify blocks. Changed scope, baseline, environment, or approvals need a new decision.
The default is deliberately narrower than DSH's optional unlisted-explicit admission.

**Rationale**: A Trigger is context, not authorization; a Ticket Mandate is scoped to
its original acceptance and does not prove that a later comment approves an exact
manifest. Current admission allows configured unlisted users and automatic wake on a
human follow-up. Operator-selected allowlisting supplies a concrete approver predicate.
The GitHub User/bot distinction is not a proof of personhood: the operator owns
allowlist vetting and must not add bot-controlled ordinary accounts.

**Alternatives considered**: Trusting arbitrary follow-ups, LLM interpretation of a
report, any valid Mandate, or a repository text file asserting approval. None binds a
human decision and current permissions to an immutable baseline. Using every explicit
admission cell as approval would broaden the first version without an operator choice.

**Operator decision, 2026-11-01**: accepted as a conditional design. The approval,
gate-signer binding, dedicated Linux isolation, restricted network and separately
enforced no-merge branch protection are approved in principle, subject to the
feasibility spike in task T005. A control that the spike cannot prove blocks the
affected story; the implementation does not weaken the protocol to keep it running.
The approved manifest digest covers the environment and credential summary, so
approving the digest approves that environment for that run.

**Identities, operator decision 2026-11-01**: the controller uses a dedicated GitHub
agent account with its own CLI configuration, separate from the human approver.
This follows the upstream deployment guide: the agent acts under its own account,
the operator merges. A GitHub App cannot be the agent, because dsh-superagent
reads the account's notifications.

The separation is also required by the source's own filtering: the GitHub Source
drops the messages of the agent account and treats them as not written by a
person. Sharing one account would therefore hide the operator's requests and
approval, not only weaken the audit trail.

The working repository is the operator's fork `szocpaul/dsh-superagent-prototype`
with the upstream kept as `upstream`. The fork's `main` is protected so that the
agent account cannot merge: a pull request and one approval are required, the
rule applies to administrators, and the last pusher cannot approve its own pull
request. Merge remains a human action on a different account. See
[operator-steps.md](operator-steps.md).

## 3. Task progress and gate decisions

**Decision**: Pin exact `spec.md`, `plan.md`, and `tasks.md` bytes at the approved
commit. For V1 accept only uniquely identified, ordered task lines with stable IDs;
validate current task text by allowing solely authorized, recorded checkbox changes.
Run convergence against an isolated scratch copy of the approved artifacts and result.
Before a human gate, assess only the authorized segment and record the later tasks as
not assessed; after the last segment, assess the whole approved scope. Unmet findings
are proposals only: no new task is applied to the Ticket workspace without new
authorization and an approved manifest. Revalidate the original worktree and task
progress after assessment.

**Operator decision, 2026-11-01**: accepted. The runner records the workspace state it
produced; the system creates the result revision, records it in the same durable
report, and reruns the checks against it. The two parts stay distinguishable. The
segment-limited assessment and the proposal-only findings are written into the
specification.
For a manual gate, publish the verified pre-gate work as a draft PR, wait for the
runner to be confirmed stopped, then require a signed commit whose signer is
independently bound to an allowlisted human and that changes only the pending gate
checkbox on the Ticket branch, plus an
explicit allowlisted human comment identifying the gate and that commit. Record and
recheck both. Unsupported task syntax, unavailable verification, or a protected
branch that prevents this workflow blocks with an actionable message.

**Observed GitHub evidence, 2026-11-01 (read-only API inspection)**: a commit created
through the GitHub web interface reports `commit.verification.verified = true` with
`reason = "valid"` and a `web-flow` signature, its top-level `author` object names the
acting GitHub account (login, immutable id, type `User`), and `committer` is `web-flow`.
Commits pushed from a machine with an unlinked author email report `verified = false`
with `reason = "unsigned"`. The API therefore distinguishes an account's web edit from
an unsigned push, which is the binding the gate protocol needs. It proves that the
account performed the edit through GitHub; it does not prove the person's presence,
their second factor, or a personal signing key. The spike must confirm the same
signals in the target repository and must fail closed when GitHub does not supply them.

**Rationale**: Checkbox progress is not a scope change, whereas an appended task is.
Git author text is forgeable; a verified signature must be independently bound to the
allowlisted human, in addition to the explicit decision and exact diff, to provide
evidence for the spec's human-only checkbox rule. If that binding is not verifiable,
this protocol is unavailable and blocks; a generic verified badge is insufficient. A draft PR
provides material for review without `ready` ending a Ticket. The deterministic
parser is intentionally narrow; it fails closed instead of inferring semantic
agreement from arbitrary Markdown. Gate decisions are distinct from a whole-PR
approval and do not confer broader scope.

**Alternatives considered**: A free-form `yes`, a model checking the checkbox, or a
commit with only a matching author name. They do not establish the required decision
or human action. Auto-accepting convergence tasks changes the approved scope. The
signed-commit workflow is an initial design assumption requiring operator review.

## 4. Runner lifecycle and containment

**Decision**: Run one resident Prime session in a dedicated per-run Linux user service
and isolated execution environment, with a dedicated Prime daemon/socket and tmux
server inside that service's cgroup. Deny access to the host daemon, unapproved host
files, and GitHub/merge credentials. Bind approved source paths read-only except the
explicit approved writable paths; writable runtime scratch and runner report locations
are separate. The controller owns Git staging, PR, and publication. Disallow unsupported
scope shapes that cannot be confined. Require a real startup confinement and cgroup
probe; fail closed if unavailable. The runner receives only approved model credentials
and network access needed for the task and objective checks.

**Operator decision, 2026-11-01**: accepted with an explicit limit. The enforced
controls are the writable paths, the process and network boundary, the credentials and
the stop behavior. The task order inside an allowed path is instructed, not
enforced; the system therefore states both in its reports and stops for a human
decision where a task boundary cannot be held. The specification distinguishes
enforced controls from instructed constraints.

**Rationale**: DSH workers have `danger-full-access`, and worktrees, path shims, and
prompts are not security boundaries (`docs/003-execution.md`, `docs/006-deployment.md`).
FR-004 requires more than post-run diff checking: filesystem isolation must prevent
writes outside the approved scope. A dedicated per-run daemon avoids silently using
a shared host daemon outside the cgroup. The user service's actual child/daemon
containment and termination semantics must be proven by integration tests, including
attempted escape; a CLI success or `idle` status is insufficient evidence. Confinement
must restrict inherited file descriptors, namespace and mount privileges, `/proc`,
IPC, sockets, Linux capabilities, symlinks, network destinations and cgroup delegation.
Model credentials visible to the agent cannot be guaranteed secret from the agent:
use scoped, revocable credentials and network controls and document residual risk.

**Alternatives considered**: Shared Prime daemon, arbitrary worker shell, prompt-only
scope limits, or checking only the final diff. None establishes that no out-of-scope
write or orphan process occurs. Containerization is an alternative only if it satisfies
the same documented contract and tests; V1 selects a Linux user service plus filesystem
namespace and fails closed where that environment cannot be provided.

## 5. Launch, stop, and reconciliation

**Decision**: Generate a unique segment ID and deterministic service, tmux, socket,
workspace, and monitor identities before launch; atomically persist the reservation
and launch effect. A bootstrap barrier prevents the agent prompt from running until
the exact session identity, quota monitor, approved manifest, and controller state
are verified. Reconcile both open and ended Tickets before dispatching effects after
restart. Stop commits an epoch/tombstone and durable stop effect in the same Ticket
ending transaction; exact-unit/session cancellation plus empty cgroup verification
establishes quiescence. Unknown launch or stop keeps the reservation and guard.

**Rationale**: `src/core/tickets.ts` ends Tickets transactionally but existing
`DshExecutor.stop()` uses non-durable `afterCommit` cleanup for DSH-owned work only.
`prime-agent list --json` exposes durable and active IDs, but idle is not proof of
termination; `prime-agent stop` acknowledgement does not prove descendants exited.
A crash can occur between spawn and identification. Unknown state must not be
converted into a new launch or success.

**Alternatives considered**: `prime-agent stop` alone, a tmux name alone, or retrying
launch on CLI failure. These do not prove no daemon child remains and can duplicate
work. Assuming a stable identity from an active session ID alone breaks on restart.

## 6. Notifications, evidence and GitHub delivery

**Decision**: The runner writes an atomic structured report and the normal durable
`runner-report.md` in run-owned storage, identifying the baseline and an untrusted
workspace snapshot rather than a result commit it cannot create. After the runner is
confirmed stopped, the coordinator validates scope, snapshots and stages the result,
creates the candidate commit, binds the report to that exact SHA, and independently
reruns exit-code checks against it in the approved environment. A local event is only
a wake-up hint; a non-LLM bounded reconciliation timer recovers missing hints. It then
uses the existing report, PR-claim, outbox and attention rules, with checks before
committing state and initiating external GitHub operations. The runner has no GitHub
write credentials. Disable auto-merge and merge by capability for bridge runs, not
by prompt alone.

**Rationale**: Prime sibling messages cannot directly address a DSH Session and can
be lost; the current skill references a stale `agent_message.list_agents` API. DSH
already has `orchestrator_report`, `claimPull`, and durable outbox receipts. A runner
report is untrusted: it does not prove checks, review, or permission. Current default
Delivery requirements permit auto-merge under conditions, while FR-014 forbids it.

**Alternatives considered**: Relying on `agent_message` delivery, a ready report
without a PR, or a prompt saying no merge. Ready without a PR can end a Ticket;
messages and prompt limits are not durable authority or capability boundaries.

**Publication race and spec review**: Serialize stop and start of delivery through a
persisted epoch. FR-015 requires that no late result causes new publication and that
no new external action starts after the stop, but an operation sent to GitHub before
a stop may complete after the stop and cannot be atomically recalled. Record and
reconcile this uncertain or delivered-after-stop outcome before any new delivery;
do not claim rollback. **Operator decision, 2026-11-01**: accepted. The bridge stops
initiating external actions after a stop, reconciles already accepted operations and
reports their outcome honestly, and never claims a remote rollback. The
specification states this guarantee explicitly.

## 7. Metered usage and operational validation

**Decision**: Keep the existing runner's bounded goal, turn/token/wall limits,
wait discipline, exit-code checks, maximum two converge rounds, and mandatory
external cron guard for metered providers. The bridge owns a per-run guard entry,
explicit limits, session identity, durable alert and cancellation effects. Keep the
guard active until quiescence is confirmed. Validate CLI flags and skill expansion,
real backend/auth access, working interpreter, quota configuration, and containment
before running the task. Monitor accounting coverage and fail closed when guard data
is unavailable.

**Rationale**: `--autonomous-max-tokens` does not guarantee billed cache-read limits.
The locally installed `/home/ubuntu/scripts/quota_watch_guard.sh` defaults to a
hardcoded Prime session name, ignores stop/send errors, exits zero, and counts one
session file; it is not a reliable DSH controller or account-wide budget. Use a
project-owned guard adapter whose exact metering scope is reported, not this script
as an authoritative stop. No recurring LLM heartbeat is used for burn monitoring.

**Alternatives considered**: In-agent heartbeats, per-turn polling, or blindly
reusing the installed guard. These either consume LLM context repeatedly or cannot
prove correct targeting, alert delivery, accounting, and stop.

## Research limits

Read-only inspection established interfaces and local CLI help (Prime Agent 0.10.1),
not a successful integration. Service/cgroup behavior, namespace restrictions,
source evidence, CLI/skill expansion, and quota watcher behavior require controlled
integration and real-backend smoke tests during implementation. Fail preflight on
unsupported flags, backend access, or containment; do not infer compatibility from
this document.
