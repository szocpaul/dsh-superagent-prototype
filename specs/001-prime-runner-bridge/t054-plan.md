# T054 Plan: the Disposable Real-Backend and GitHub Smoke

**Status**: proposal for the operator's approval. Nothing here has been started.
**Date**: 2026-11-01

This is the gate before the first live run. It names everything the operator
approves: the host, the accounts, the credential categories, the repository, the
quotas, the irreversible actions, and the cleanup. It never contains a secret
value.

## What the smoke proves, and what it does not

The smoke exercises one bounded segment end to end against a real model backend
and a real GitHub repository. It proves that the manifest, the approval, the
launch, the isolation, the verification, the pull request and the cleanup work
together on this host.

It does **not** prove that the bridge is safe to leave running unattended, and it
does not merge anything. The pull request stays open and unmerged, and the
auto-merge check is a refusal, not a success.

## The three parts

### Part 1: The isolated verification of the host, without a model call

This part needs no credential beyond the agent account's own, and it is the part
that can fail harmlessly.

1. Install the DeepSeek Harness host (`@deepseek-ai/dsh`) and create the
   `superagent` profile, as `docs/006-deployment.md` describes.
2. Start the service with the operator's own account and the agent account's
   GitHub CLI.
3. Confirm that the service reaches the "ready" state, that the panel answers,
   and that `scripts/dsh-superagent status` exits 0.

**Reversible**: yes. `scripts/dsh-superagent stop` and removing the profile
restores the machine.

### Part 2: The manifest, the approval and the launch, against the real backend

This part spends model tokens and creates GitHub branches.

1. Prepare a disposable feature in the working repository: a `spec.md`, a
   `plan.md` and a `tasks.md` with one trivial automatable task and one human
   gate. The check is a shell command that exits 0 and prints one line.
2. The controller builds the manifest from that baseline and presents its digest
   and the environment summary.
3. The operator, as the allowlisted human, approves that digest in the original
   issue conversation, exactly as the contract names it.
4. The controller preflights, launches the runner, and the runner performs the
   single automatable task.

**Credential categories involved**: the model provider's key for the runner only,
and the agent account's GitHub token for the controller only. The runner receives
no GitHub write token; the controller receives no model key.

**Quota**: the run is bounded by the approved limits, and the external guard
warns and stops at the approved thresholds. The thresholds are set from the
measured burn rate, not from a default.

### Part 3: The gate, the stop, and the recovery

1. The runner stops at the human gate and leaves it unchecked.
2. The controller opens a draft pull request with the evidence and asks one
   question in the original conversation.
3. The operator edits exactly the gate's checkbox on the Ticket branch through
   the GitHub web interface, and posts the gate decision naming the commit.
4. The controller resumes the next segment, which has no work left, and the
   verification runs the approved check against the exact revision.
5. The controller opens the review-ready pull request. The operator does **not**
   merge it during the smoke.
6. A separate stop test: the operator stops the Ticket, and the controller proves
   the cgroup is empty and the reservation and the guard are released.

## The host, the accounts, and the repository

| Item | Value |
| --- | --- |
| Host | `ubuntu-8gb-nbg1-1`, the same machine, one dedicated DSH profile |
| DSH profile | `superagent`, separate from any other profile, port 3082 |
| Controller identity | the agent account `szocpaul-dsh-agent`, `push` access only |
| Human identity | the operator's own account `szocpaul`, the only allowlisted account |
| Repository | the operator's fork `szocpaul/dsh-superagent-prototype`, on the feature branch only |
| Model | the same provider and model the current session uses, with a scoped key |
| Quota thresholds | set from the measured burn rate, with the external guard installed before the work starts |

## The irreversible actions, named

Only these change anything outside the machine:

1. A branch is pushed to the operator's fork.
2. A pull request is opened against the fork's `main`, which stays protected.
3. A pull request comment is written on the issue.
4. The gate's checkbox is edited on the branch by the operator.

**Nothing is merged.** The protected `main` refuses a merge by the agent account,
and the smoke verifies that refusal rather than assuming it.

## The cleanup

Every item is the run's own, and none is touched if it belongs to something else:

- the run's user service unit, and its cgroup, after the empty process list is
  proven;
- the run's private Prime daemon socket and tmux server;
- the run's cron entry for the quota guard;
- the run's scratch workspace;
- the feature branch and the pull request, which the operator closes or deletes
  afterwards.

The operator's own sessions, cron entries and repositories are never touched. The
cleanup checklist in `runner-report.md` records what was removed.

## What the operator decides

1. Whether to run this at all, and whether the three parts may run separately.
2. The model provider and model, and the quota thresholds.
3. The disposable feature's content: one trivial task and one human gate.
4. Whether the pull request may be opened against the fork, given that the fork's
   `main` is protected and nothing is merged.
5. Whether the smoke may spend model tokens at the measured rate, roughly 0.5 USD
   per hour.

## The failure paths

- If the DSH host does not start, the smoke stops there. Part 1 is the cheapest
  check, and it is the reason the parts are ordered this way.
- If the manifest cannot be approved, or the approval does not verify, no runner
  starts. The bridge blocks itself.
- If the verification cannot run, no pull request is opened. The adapter throws
  today, so this is the expected outcome until it is implemented.
- If the runner cannot be confined, or the cgroup cannot be created, the launch
  fails before the runner does any work.
- If the quota guard cannot be installed, the launch does not happen.
