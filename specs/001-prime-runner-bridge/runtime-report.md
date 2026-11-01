# Runtime Report: Feasibility Spike (T005)

**Date**: 2026-11-01 | **Host**: ubuntu-8gb-nbg1-1 (Ubuntu, systemd 259.5, kernel 7.0.0-38)
**Operator**: authorized for a disposable-repository and disposable-host probe.

This file holds the spike evidence. The end-to-end run's own report uses
`runner-report.md`, as the task list names it.

## Summary

| Control | Result |
| --- | --- |
| (a) Human edit evidence bindable to an account | **Proven** |
| (b) Branch protection denies the controller merge | **Proven** |
| (c) Host isolation and provable empty-cgroup stop | **Proven with a stated limit** |
| (d) Installed Spec Kit skill behavior | **Proven, with two contract corrections** |

Every check ran read-only or against a transient artifact that was removed
afterwards. No production system, no credential, and no repository content was
changed by the probe.

## (a) Human edit evidence

A commit made through the GitHub web interface reports
`commit.verification.verified = true` with `reason = "valid"` and a `web-flow`
signature, its top-level `author` object names the acting GitHub account with
its immutable id and type `User`, and `committer` is `web-flow`. A commit pushed
from a machine reports `verified = false` with `reason = "unsigned"`.

The API therefore distinguishes an account's web edit from an unsigned push,
which is the binding the gate protocol needs. It proves that the account
performed the edit through GitHub. It does **not** prove the person's presence,
their second factor, or a personal signing key.

## (b) No-merge control

With the dedicated agent account `szocpaul-dsh-agent` (`write` access, no
`admin`, no `maintain`) on `szocpaul/dsh-superagent-prototype`:

- the agent opened a pull request; merging it was refused;
- merging with administrator privileges was refused: *"New changes require
  approval from someone other than the last pusher"*;
- the operator's merge was refused until the operator approved the pull
  request; the operator's approval and merge then succeeded.

The temporary pull requests were closed and their branches deleted. The probe
file was removed in a separate pull request, opened by the agent and merged by
the operator.

## (c) Host isolation

Proven on this host:

- A per-user systemd manager runs, and `systemd-run --user --scope` yields a
  transient unit with a **user-owned** cgroup.
- cgroup v2 is delegated to the unprivileged user: `mkdir` under
  `user@1000.service` succeeds, and `memory.max`, `pids.max` and
  `cgroup.freeze` are writable and enforced. `pids.max = 1` makes a fork fail
  with `EAGAIN`; `memory.max` clamps usage with the peak exactly at the cap.
- **`bubblewrap` provides real namespace isolation.** The sandbox's user, pid,
  mnt, ipc, uts, net and cgroup namespaces are all distinct from the host; the
  process list shows only the sandbox's own processes; `/proc` is private; all
  capability sets are empty.
- **A write outside the approved paths is blocked.** With the home directory
  masked by a `tmpfs` layer, the agent's and the operator's credential files
  and the host daemon directory are invisible; the approved workspace stays
  writable; a symlink that points into the masked area resolves to nothing.
- **The host daemon socket must be hidden.** The Prime daemon listens on
  `/tmp/prime-agent-1000/daemon.sock`. A sandbox that shares the host `/tmp`
  can see and reach it. An isolated `--tmpfs /tmp` hides it. The bridge must
  therefore run the runner against a **private daemon socket**, and the
  isolation profile must mask the host `/tmp`.
- **A whole process tree stops, provably.** In a delegated service cgroup, a
  nested tree of four processes was terminated by writing the cgroup's `kill`
  file: the cgroup's process list went from four entries to zero, and no
  survivor remained anywhere on the host. An empty cgroup is observable as an
  empty process list, `pids.current = 0`, `memory.current = 0` and
  `populated 0`.

Stated limits, which the design must record rather than hide:

- Raw unprivileged user namespaces are denied on this host by AppArmor
  (`apparmor_restrict_unprivileged_userns = 1`); `bubblewrap` is the one
  verified exemption, and its child profile strips every capability. Any
  isolation that does not use `bwrap` is unavailable to an unprivileged
  process here, and a plain process can create neither a mount namespace nor a
  private `/proc`.
- The login session's own cgroup is root-owned and its process list is not
  writable, so session-level containment is not available; the runner needs its
  own delegated service unit.
- The `memory.max` limit is enforced by reclaim. The out-of-memory kill path
  was not exercised.
- A systemd-created scope is reaped as soon as it empties, so an empty scope
  does not persist. The bridge therefore reads the scope's process list before
  it is removed, or owns the cgroup directly under the delegated user root.
- **Passwordless root escalation is available to this user account.** No
  sandbox built on namespaces and cgroups is a security boundary against this
  account, because anything running as `ubuntu` can escalate and bypass every
  restriction. The isolation protects the agent's own mistakes and the
  repository's integrity; it is not a defense against the operator's account.

## (d) Installed Spec Kit skills

The three skills are markdown prompt skills derived from the Spec Kit 1.1.1
core command templates. Only `check-prerequisites.sh` and `setup-tasks.sh` are
deterministic, and both are read-only with respect to the specification, plan
and task list.

- The active feature directory comes from `SPECIFY_FEATURE_DIRECTORY`, then
  `.specify/feature.json`, and otherwise the scripts fail. Setting the
  environment variable rewrites `feature.json` unless `SPECIFY_FEATURE_NO_PERSIST=1`
  or `--paths-only` is used. The bridge must set the directory per run and must
  not let a run rewrite the shared state.
- `/speckit-tasks` writes only `tasks.md`. `/speckit-converge` only appends a
  `## Phase N: Convergence` block to `tasks.md`, never rewriting it and never
  touching `spec.md` or `plan.md`. `/speckit-implement` writes every file path
  named in the task list, flips the task checkboxes to `[X]`, and **creates or
  verifies ignore files** (`.gitignore`, `.npmignore`, `.dockerignore` and
  others). Those writes fall outside the approved scope and must be part of the
  manifest or explicitly excluded.
- The checklist gate belongs to `/speckit-implement` only and is prose, not
  script logic: it scans `FEATURE_DIR/checklists/`, and if any item is
  unchecked it stops and asks a yes/no question. The current
  `requirements.md` is fully checked, so it passes silently. A future
  reviewer-owned checklist ships unchecked and would stop an unattended run.
- **The installed `speckit-converge` skill contains no manual-gate handling.**
  The gate discipline lives in the operator's `autonomous-spec-runner` skill,
  not in Spec Kit. The bridge must therefore implement the gate boundary
  itself, and must not rely on the installed skill to stop at one.
- **The Spec Kit CLI cannot run these steps headlessly here.** The project uses
  the generic integration, which does not support CLI dispatch, so
  `specify workflow run` fails with *"Cannot dispatch command
  'speckit.implement'"*. The skills are agent prompts and must be driven by an
  agent session.

## Consequences for the design

1. The isolation profile must be `bubblewrap` with a masked home, a masked
   `/tmp`, a private daemon socket, a private `/proc`, and separate network,
   pid, ipc and uts namespaces. The runner's service unit owns the delegated
   cgroup, and the stop path writes that cgroup's kill file and then verifies
   an empty process list.
2. The bridge's own watchdog must be able to stop the run without the
   controller, which the delegated cgroup makes possible.
3. The manifest must name the ignore files the implement skill may create, or
   the bridge must run the implementation step with those writes excluded.
4. The gate boundary belongs to the bridge, not to the Spec Kit skill.
5. The Spec Kit CLI workflow route is unavailable; the runner must be an agent
   session that invokes the skills.
6. The documentation must state the privilege boundary honestly: the isolation
   contains the agent's mistakes and protects the repository, but the operator's
   account holds passwordless root and is outside that boundary.

## Remaining

The live end-to-end run still needs the separately authorized disposable
GitHub smoke with a real model backend. This spike proves the mechanisms; it
does not prove a full autonomous run.
