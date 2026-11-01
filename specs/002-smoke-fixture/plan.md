# Implementation Plan: Smoke Fixture

**Branch**: `001-prime-runner-bridge` | **Date**: 2026-11-01 | **Spec**: [spec.md](spec.md)

## Summary

Create one exported function and the check that verifies it. Nothing else changes.

## Technical Context

**Language/Version**: TypeScript with the repository's own toolchain
**Primary Dependencies**: the repository's existing test runner
**Storage**: none beyond the two files
**Testing**: `pnpm exec vitest run tests/smoke.spec.ts`
**Target Platform**: the repository's own environment
**Project Type**: library
**Performance Goals**: none; the fixture is trivial
**Constraints**: only `src/smoke.ts` and `tests/smoke.spec.ts` may change
**Scale/Scope**: two files, one function, one test

## Constitution Check

| Gate | Result |
| --- | --- |
| Authorized work | PASS: the scope names the two files; the check verifies the result |
| Human control and honest status | PASS: the gate variant stops at a human decision |
| Minimal attention and simple design | PASS: two files, no new concept |
| Security and lifecycle boundaries | PASS: the write scope is exact and audited |
| Verifiable changes and documentation | PASS: one check, rerun against the exact revision |

## Project Structure

### Documentation (this feature)

```text
specs/002-smoke-fixture/
├── spec.md
├── plan.md
└── tasks.md
```

### Source Code (repository root)

```text
src/smoke.ts          # the exported behaviour
tests/smoke.spec.ts   # the check
```

**Structure Decision**: The fixture lives beside the repository's own sources, so
the check runs with the repository's toolchain and needs no separate setup.

## Complexity Tracking

No constitution violation. The fixture is deliberately the smallest thing that
still proves every mechanism.
