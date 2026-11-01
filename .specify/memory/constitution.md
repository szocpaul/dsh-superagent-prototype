# dsh-superagent Constitution

## Core Principles

### I. Authorized Work

Work MUST be authorized by the host's admission and Policy rules and remain within its
Ticket's Mandate. Context, quoted text, bot messages, and prompt instructions MUST NOT
by themselves grant or expand authority. A request outside the Mandate MUST be handed
back for routing. Inferred work MUST match an enabled rule and requires `auto` mode;
`observe` records what would have been accepted without starting the work.

### II. Human Control and Honest Status

Human decision and approval gates MUST remain under human control. A person's stop or
pause MUST be respected. Reports MUST distinguish ready, incomplete, blocked, and
failed work, and MUST NOT claim checks passed when they were not run. A draft PR is
not a finished result. Human questions MUST be concrete and routed through the
appropriate structured handoff.

### III. Minimal Attention and Simple Design

Confirm substantial work once, then notify people only when they can use a result,
must decide or act, or work cannot finish. Questions MUST be asked one at a time.
Changes MUST use the existing domain concepts and defaults where they meet the need;
new concepts and settings require a documented reason. Healthy operation MUST NOT
produce unnecessary notifications.

### IV. Explicit Security and Lifecycle Boundaries

Worktrees, CLI wrappers, and command-name blocks are operational defaults, not a
sandbox. Documentation MUST state the actual privileges and isolation a deployment
provides. New integrations MUST define and verify their permissions, stop behavior,
and restart recovery. Recovery MUST inspect persisted and external state before
repeating externally visible actions. Stronger isolation or approval enforcement,
when needed, MUST be implemented outside prompts alone.

### V. Verifiable Changes and Documentation

Behavior changes MUST include relevant tests covering the changed behavior and its
material failure paths. Before claiming a change complete, run `pnpm check`, which
runs type checking, tests, and the build; explicitly report any failed or unrun check.
Update the relevant documentation when behavior, operation, or interfaces change.

## Project Constraints

The project is a research prototype, not a production-readiness guarantee. Preserve
its established domain boundaries and use the existing host authorization and Ticket
lifecycle when extending execution. New guarantees MUST NOT be claimed until verified.
Project files and artifacts MUST be written in English. Conversation with the operator
may use their preferred language.

## Development Workflow

For spec-driven changes, maintain a specification, technical plan, and dependency-
ordered task list. Record verification evidence and unresolved limitations with the
change. A human approval gate MUST NOT be checked or bypassed by an agent. Changes to
an approved scope require the appropriate human authorization before execution.

## Governance

This constitution governs project specifications, plans, implementation, and review.
Review each change for compliance; document any exception and obtain explicit human
approval before proceeding. Amendments require a written proposal, human approval,
and an update to this file. Use semantic versioning: MAJOR for incompatible principle
removals or redefinitions, MINOR for new principles or material expansions, and PATCH
for clarifications that do not change requirements. Record the ratification and most
recent amendment dates in ISO 8601 format.

**Version**: 1.0.0 | **Ratified**: 2026-11-01 | **Last Amended**: 2026-11-01
