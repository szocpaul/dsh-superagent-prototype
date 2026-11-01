# Feature Specification: Smoke Fixture

**Feature Branch**: `001-prime-runner-bridge`

**Created**: 2026-11-01

**Status**: Approved for the disposable smoke of the Prime Runner Bridge.

**Input**: A disposable fixture that proves the bridge's mechanics. It exists to
exercise the manifest, the approval, the launch, the isolation, the verification
and the delivery, and to produce nothing useful.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Produce the fixture behaviour (Priority: P1)

An operator runs the disposable smoke. The agent creates one exported function
and the check that verifies it, and the controller verifies the result against
the exact revision.

**Why this priority**: Without a result to verify, the bridge's verification
never runs.

**Independent Test**: The approved check exits 0 against the exact revision the
agent produced.

**Acceptance Scenarios**:

1. **Given** the approved scope, **When** the agent creates the function and the
   check, **Then** both files exist and the check passes.
2. **Given** the agent's report, **When** the controller verifies it, **Then** the
   check is rerun against the controller's own commit of the result.

---

### User Story 2 - Stop at the human gate (Priority: P1)

The same fixture, with a human gate between the work and the check. The agent
must stop at the gate and must not run the later task.

**Why this priority**: The gate is the boundary the whole design protects.

**Independent Test**: The gate stays unchecked and the later task does not run
until an authorized human decision.

**Acceptance Scenarios**:

1. **Given** a segment that ends at a human gate, **When** the agent finishes the
   earlier work, **Then** it leaves the gate unchecked and reports what it needs.
2. **Given** an authorized human decision bound to the gate and the manifest,
   **When** it is recorded, **Then** the next segment runs the remaining task.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: `src/smoke.ts` MUST export a function that returns the string
  `smoke`.
- **FR-002**: `tests/smoke.spec.ts` MUST verify that function.
- **FR-003**: The approved check `pnpm exec vitest run tests/smoke.spec.ts` MUST
  exit with code 0 against the exact revision the controller created.
- **FR-004**: Only `src/smoke.ts` and `tests/smoke.spec.ts` may change.

### Key Entities

- **Fixture function**: the exported behaviour, `src/smoke.ts`.
- **Fixture check**: the test that verifies it, `tests/smoke.spec.ts`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The check passes against the exact revision the controller created.
- **SC-002**: The controller finds no write outside the two approved paths.
- **SC-003**: The pull request stays open for review and is never merged by the
  agent.

## Assumptions

- The fixture is disposable and may be deleted afterwards.
- The repository's own toolchain is available in the runner's environment.
- The check is the only objective evidence the verification needs.
