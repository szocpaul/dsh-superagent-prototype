# Tasks: Smoke Fixture

**Input**: Design documents from `/specs/002-smoke-fixture/`

**Prerequisites**: plan.md, spec.md

**Tests**: The approved check is `pnpm exec vitest run tests/smoke.spec.ts`.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Nothing to set up; the fixture uses the repository's own toolchain.

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The approved scope and the check that verify it.

- [ ] T001 [P] Complete `src/smoke.ts` with the exported function and the `SMOKE_VERSION` constant
- [ ] T002 Complete `tests/smoke.spec.ts` with the check
- [x] T003 MANUAL GATE - Review the fixture change and record the decision
- [ ] T004 [P] Run `pnpm exec vitest run tests/smoke.spec.ts` and record the result

## Phase 3: Polish

- [ ] T005 Record the evidence in the runner report

**Checkpoint**: The gate at T003 stops the segment; the later tasks run only after
an authorized human decision.

## Dependencies & Execution Order

- T001 and T002 are independent and may run in parallel.
- T003 is a human gate: the agent must stop there and must not perform it.
- T004 and T005 follow the gate.
