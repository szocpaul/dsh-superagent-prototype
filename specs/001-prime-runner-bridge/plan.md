# Implementation Plan: Prime Runner Bridge

**Branch**: `001-prime-runner-bridge` | **Date**: 2026-11-01 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification in `specs/001-prime-runner-bridge/spec.md`.
The setup script returned `001-prime-runner-bridge` as the feature identifier; it
is not the current Git branch.

## Summary

Connect an explicitly authorized dsh-superagent GitHub Ticket to one supervised,
resident Prime Agent runner for an already approved Spec Kit feature. The host owns
a durable single-run reservation, authorization, human gates, stop and recovery,
independent verification, and PR delivery. Prime executes the bounded automatable
segment in an isolated Linux environment; the controller, not the runner, owns
GitHub publication. This design is proposed, not implemented or validated.

## Technical Context

**Language/Version**: TypeScript with Node.js `^22.19.0 || >=24.0.0` per
`package.json`; POSIX shell for controlled bootstrap/guard integration.

**Primary Dependencies**: Existing DSH bundle and `@deepseek-ai` peer packages,
Zod, Git/GitHub CLI; installed Prime Agent CLI (locally observed 0.10.1), tmux,
Linux user service/cgroup and filesystem-namespace isolation, cron quota guard.
The runtime must verify actual flags, model backend, CLI, privileges and isolation.

**Storage**: Existing SQLite Store and durable Effects queue for controller records,
with run-owned report/evidence files. Per-run Prime session files and service runtime
state must be recoverable. No credentials in stored records or reports.

**Testing**: Vitest/TypeScript tests; existing `pnpm check` (typecheck, test, build);
adapter fake tests, controlled Linux process/cgroup integration, adversarial scope
and authorization tests, and separately authorized real-backend/GitHub smoke tests.

**Target Platform**: Initial Linux host with available user services, cgroups,
namespace confinement, cron, and same-host DSH/Prime. Unsupported or unverifiable
capabilities block the feature; no assumption that installed binaries imply working
isolation or service authorization. Gate continuation also requires an operator-
vetted human signer whose identity can be independently bound to a GitHub commit;
this has not been verified on the target repository.

**Project Type**: Existing DSH server bundle with GitHub Source and web panel.

**Performance Goals**: One unresolved active/unknown runner maximum; no repeated
LLM polling; use event wakeups and low-frequency non-LLM reconciliation. No latency
SLA is implied. Define an operator-visible bounded timeout for an unavailable local
wake and explicitly report monitoring failure rather than claiming success.

**Constraints**: One repository, explicit requests, approved spec/plan/tasks,
manual merge, no shared daemon, scoped filesystem writes, no GitHub write or merge
credentials in runner, human-only manual-gate completion, durable stop and unknown-
state reservation. Initial adapter use requires an operator-approved deployment.

**Scale/Scope**: One active runner across the configured deployment at a time;
queue other eligible Tickets. V1 excludes autonomous specification creation,
proactive intake, multiple concurrent runners, auto-merge and multi-repository work.

## Constitution Check

| Gate | Before research | Post-design |
|------|-----------------|-------------|
| Authorized work | PASS: require host admission, exact approved manifest and scope | PASS as design: verify actor/Policy, recheck at launch, gate and delivery; out-of-scope requires new Eval |
| Human control and honest status | PASS: gate remains human-owned; no auto-merge | PASS as design: verify human gate action, independent checks and unconfirmed stop; draft is not ready |
| Minimal attention and simple design | PASS: one actionable question and quiet progress | PASS as design: extend existing Engine/Effects/Outbox, one coordinator, one slot, no parallel product |
| Security and lifecycle | PASS conditionally: a real enforceable boundary is required | PASS conditionally: isolated service and explicit stop/recovery are required; failed confinement blocks rollout |
| Verifiable changes and docs | PASS: test observable behavior and update documentation | PASS as plan: focused and adversarial tests, `pnpm check`, separately authorized live smoke; failures are disclosed |

The post-design result is conditional on proving the containment and lifecycle
contract in tests. No existing implementation is claimed to satisfy these gates.
Security mechanisms must restrict writable paths and process/network access, not
just detect a final diff. If the selected host cannot provide a genuine boundary,
stop implementation and revise the spec with the operator rather than weakening it.

## Project Structure

### Documentation (this feature)

```text
specs/001-prime-runner-bridge/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── checklists/requirements.md
├── contracts/bridge.md
└── tasks.md                 # generated by /speckit-tasks, not this phase
```

### Source Code (repository root)

```text
src/
├── core/                    # Ticket/Mandate rules and durable stop event wiring
├── app/                     # Store, Effects, source-derived approval, lifecycle
│   └── tools/               # worker handoff tools and role-scoped integration
├── executor/                # Prime adapter, preflight, reporting and supervision
├── sources/                 # GitHub evidence and idempotent PR/source operations
└── infra/                   # typed subprocess, sandbox and guard interfaces
scripts/                     # only project-owned, narrowly scoped launch/guard helpers
prompts/                     # bridge use and no-auto-merge guidance
skills/                      # bundled runtime instructions only if required

tests/                       # focused unit, contract, lifecycle and integration tests
docs/                        # operator setup, security limits, operations and recovery
```

**Structure Decision**: Extend the existing single TypeScript bundle rather than
introduce a separate service or database. The Prime runner and its private daemon are
external processes supervised by a narrowly scoped adapter. Store approval/segment
records and enqueue durable effects inside Store transactions; keep Engine as the
single writer of domain Tickets. Exact file names may be refined in tasks after
inspecting existing boundaries; do not put a new policy decision in an LLM prompt.

## Design Sequence

1. Add canonical manifest validation and human evidence handling, constrained to one
   repository and current allowlisted GitHub humans. Create a documented normal form
   for task checkbox progress; changed scope and convergence additions need a new
   approval. Treat an unverified person/commit/source as a blocker.
2. Add transactional reservation and launch/stop records using Store and Effects.
   Include ended Tickets in reconciliation. Record generation/epoch before launch,
   stop and publication; no stale effect or report can create a later action.
3. Implement a contained adapter with a private Prime daemon/socket and service
   cgroup. Establish a bootstrap barrier before work, verify process identity and
   confinement, and install an external guard before release. Unknown identity or
   unconfirmed stop retains reservation and guard. Do not rely on sibling messaging.
4. Map gated reports to the existing attention/outbox path; publish at most a draft
   evidence PR for manual gates. Require the explicitly authenticated human action
   and decision before a separately authorized new segment. Never mark `ready` at a
   gate or use an agent-authored checkbox. Reports state which controls were
   enforced and which were only instructed.
5. Independently verify revision, approved paths, tasks, required checks and
   convergence before ready. Run project checks in a separately confined, credential-
   free verifier. Re-read approval, PR and stop state; after a stop, initiate no new
   external action and reconcile already accepted operations, reporting an uncertain
   or completed-after-stop outcome honestly without claiming a remote rollback. Withhold runner write credentials; use server-enforced branch
   protection to prohibit controller merges and refuse already enabled auto-merge.
   Keep PR open for human review and merge.
6. Cover failure windows with deterministic fakes and real isolated-process tests;
   document environment restrictions and perform a separately authorized live smoke.

See [research.md](research.md), [data-model.md](data-model.md),
[contracts/bridge.md](contracts/bridge.md), and [quickstart.md](quickstart.md).

## Complexity Tracking

No constitution violation is proposed. The dedicated supervised process boundary is
necessary for the spec's enforceable write scope and stop/restart guarantees. It is a
conditional design: if a deployment cannot prove those guarantees, the bridge remains
disabled rather than claiming isolation.
