# The Disposable Feature of the T054 Smoke

This is the feature the second and third parts of the smoke run. It exists to
exercise the bridge's mechanics, not to produce anything useful.

## Where it lives

A new feature directory in the working repository:

```text
specs/002-smoke-fixture/
├── spec.md
├── plan.md
├── tasks.md
└── src/smoke.ts        # the only writable path
```

The feature is committed to the branch `001-prime-runner-bridge` before the
smoke, so its baseline commit is real and its digests are real.

## The specification

```markdown
# Feature Specification: Smoke Fixture

## Requirements

- FR-1: `src/smoke.ts` exports a function that returns the string `smoke`.
- FR-2: The approved check `pnpm exec vitest run tests/smoke.spec.ts` exits
  with code 0.

## Success Criteria

- SC-1: The check passes against the exact revision the runner produced.
```

## The plan

```markdown
# Implementation Plan: Smoke Fixture

**Language**: TypeScript
**Structure**: `src/smoke.ts` holds the behaviour; `tests/smoke.spec.ts` holds its check.

## Scope

Only `src/smoke.ts` and `tests/smoke.spec.ts` may change. Everything else in
the repository is out of scope.
```

## The tasks

Two variants; the smoke runs the first, and the second proves the gate.

### The no-gate variant, used for the second part

```markdown
# Tasks: Smoke Fixture

**Input**: A disposable fixture that proves the bridge's mechanics.

- [ ] T001 [P] Create `src/smoke.ts` with the exported function
- [ ] T002 Create `tests/smoke.spec.ts` with the check
- [ ] T003 [P] Run `pnpm exec vitest run tests/smoke.spec.ts` and record the result
- [ ] T004 Record the evidence in the runner report
```

### The gate variant, used for the third part

```markdown
# Tasks: Smoke Fixture with a gate

**Input**: A disposable fixture whose third task is a human gate.

- [ ] T001 [P] Create `src/smoke.ts` with the exported function
- [ ] T002 Create `tests/smoke.spec.ts` with the check
- [ ] T003 MANUAL GATE - Review the fixture change and record the decision
- [ ] T004 [P] Run `pnpm exec vitest run tests/smoke.spec.ts` and record the result
```

## Why this feature, and not another

It is the smallest thing that still proves every mechanism:

- it **writes a file**, so the writable-path binding and the scope audit have
  something to check;
- it **runs a real check**, so the verification has an exit code to reproduce
  against the exact revision;
- it **touches nothing else**, so a scope violation would be visible and any
  other change would be the agent's mistake;
- the **gate variant** puts the human gate between two pieces of work, so the
  runner has to stop in the middle, and the later task proves it did not run.

The fixture files under `tests/fixtures/prime-bridge/` are the same shape and
already have their digests recorded, so the smoke's feature is the fixture
turned into a real commit.

## What the operator does in the third part

1. Reviews the draft pull request the bridge opened.
2. Edits exactly the gate's checkbox, `[ ]` to `[x]`, on the Ticket branch,
   through the GitHub web interface.
3. Commits that edit. The commit's signer must be bound to the operator's
   allowlisted account, or the flow stays blocked.
4. Posts `@<agent login> APPROVE GATE T003 <manifest-sha256> <full commit sha>`
   in the original issue conversation.

The bridge then reserves the next segment, which runs the remaining task, and
opens the review-ready pull request. The operator does not merge it.

## The approved scope and the check

| Item | Value |
| --- | --- |
| Allowed paths | `src/smoke.ts`, `tests/smoke.spec.ts` |
| Approved check | `pnpm exec vitest run tests/smoke.spec.ts` |
| Check timeout | 60 seconds |
| Baseline | the commit that adds the feature |

Two writable paths are deliberate: one file cannot show whether the scope audit
distinguishes a permitted write from a forbidden one, and the check must live
beside the behaviour it checks.
