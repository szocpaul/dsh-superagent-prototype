# Feature Specification: Prime Runner Bridge

**Feature Branch**: `001-prime-runner-bridge` (created in the operator's fork
`szocpaul/dsh-superagent-prototype`; the upstream repository is
`deepseek-ai/dsh-superagent-prototype`).

**Created**: 2026-11-01

**Status**: Draft

**Input**: Connect a dsh-superagent Ticket to a Prime Agent autonomous spec runner so an authorized GitHub request can execute an already approved specification, stop at human gates, and deliver a verified result for review.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Run an approved specification (Priority: P1)

An authorized operator asks the agent in a GitHub issue to implement a named,
already approved specification. The agent verifies the requested scope, delegates
its automatable work to one runner, and makes the result available for human review.
The operator can see which specification was used, what was completed, and which
checks passed or remain incomplete.

**Why this priority**: This is the smallest useful end-to-end path from an authorized
request to a reviewable result.

**Independent Test**: Submit an authorized request against an approved test
specification with no human gate. Verify one runner is started, the specified work
is performed and checked, and a reviewable pull request and evidence are delivered.

**Acceptance Scenarios**:

1. **Given** an authorized GitHub request and an available approved specification
   with a plan and task list, **When** preflight succeeds, **Then** exactly one
   runner is associated with the Ticket and works only within the approved scope.
2. **Given** all required automatable work and checks finish successfully,
   **When** the result is independently verified for delivery, **Then** the agent
   provides a pull request and accurately reports the verification evidence.
3. **Given** a missing, inaccessible, ambiguous, or unapproved specification, or
   a failed prerequisite, **When** a run is requested, **Then** no work starts and
   the operator is told what is needed.
4. **Given** a request outside the Ticket's authority, **When** it arrives,
   **Then** it is routed for a fresh authorization decision rather than expanding
   the existing run.

---

### User Story 2 - Review an explicit human gate (Priority: P1)

When work reaches a human gate or an unresolved decision, the runner stops at that
boundary. The operator receives one concrete question in the original conversation,
reviews the evidence, and can authorize continuation or stop the work.

**Why this priority**: Long autonomous work must not bypass a person's decision.

**Independent Test**: Use a specification with an explicit manual gate and a later
task. Verify that the runner stops before the gate, the later task is untouched, and
an authorized response can lead to a separately bounded continuation.

**Acceptance Scenarios**:

1. **Given** the next task is marked as a human gate, **When** the runner reaches
   it, **Then** it leaves the gate unchecked, stops subsequent work, records the
   completed work and evidence, and reports the exact decision needed. A draft pull
   request may present this evidence without claiming readiness.
2. **Given** a run is waiting at a human gate, **When** an authorized person
   approves continuation for the unchanged approved scope, **Then** the system
   records the decision and starts or resumes only the next authorized work segment.
   Only the human reviewer marks the manual gate complete.
3. **Given** the approval is denied, ambiguous, from an unauthorized sender, or
   refers to changed scope, **When** the response is received, **Then** the system
   does not continue the work without a new valid decision.
4. **Given** work before a gate is complete, **When** the runner reports that its
   bounded segment succeeded, **Then** the overall feature remains incomplete.

---

### User Story 3 - Stop and recover long-running work (Priority: P1)

An operator can stop the Ticket and trust that the associated runner no longer
continues the work. After an interruption or restart, the system identifies the
existing work and its actual state before it resumes, reports, or starts anything.

**Why this priority**: A separately running agent must remain under the Ticket's
control, including across interruptions.

**Independent Test**: Start a controlled long-running test job, stop the Ticket,
and check that its runner is confirmed stopped. Separately interrupt and restart
the controlling service and verify that the existing job is reconciled without a
duplicate or repeated external action.

**Acceptance Scenarios**:

1. **Given** a runner is active, **When** an authorized person stops its Ticket,
   **Then** the system requests that the runner stop, prevents new work for that
   Ticket, and reports whether stopping was confirmed.
2. **Given** the runner cannot be confirmed stopped, **When** stop handling ends,
   **Then** the Ticket is shown as needing operator attention and no replacement
   runner is launched.
3. **Given** the controller restarts or a completion notification is lost,
   **When** work is reconciled, **Then** the system checks retained run information,
   the runner's actual state, and existing results before deciding what to do next.
4. **Given** an existing runner or its state cannot be identified reliably,
   **When** a retry is requested, **Then** no replacement starts until an operator
   resolves the uncertainty.

---

### User Story 4 - Understand failures and protect resources (Priority: P2)

When work cannot safely start or complete, the operator receives an accurate,
actionable report rather than a false success. Long runs have the resource and
cleanup safeguards of the autonomous runner workflow.

**Why this priority**: Reliable handoff requires clear failure reporting and bounded
resource use, even when no result is ready.

**Independent Test**: Simulate a failed preflight, an unavailable dependency, a failed
check, and a quota alert. Verify that each produces the correct stopped or blocked
outcome, preserves evidence, and does not claim completion.

**Acceptance Scenarios**:

1. **Given** a required backend, credential, tool, or configured check is unusable,
   **When** preflight or execution detects it, **Then** work stops and the report
   names the failed prerequisite and the next action.
2. **Given** a required check fails, a dependency becomes unavailable, or a quota
   limit blocks work, **When** the run ends, **Then** the operator can distinguish
   the cause and no ready result is reported.
3. **Given** monitoring is configured for a metered provider, **When** the runner
   is confirmed stopped or finished, **Then** its monitoring is cleaned up without
   disrupting unrelated runs. If stop is unconfirmed, monitoring remains active and
   the operator is alerted.

### Edge Cases

- A duplicate request, retry, delayed report, or repeated completion notification
  MUST NOT create a second active runner or repeat delivery for the same work.
- If scope-bearing specification, plan, or task content changes before start or
  continuation, the system MUST require fresh authorization. Recorded progress on
  approved tasks alone does not expand the scope.
- If the runner terminates without a usable report, the Ticket MUST remain blocked
  or failed; a notification alone MUST NOT be treated as evidence of success.
- If the target repository, branch, or working directory cannot be identified
  unambiguously, the run MUST NOT start or write to another work item.
- If a human stops the Ticket while the runner is completing or reporting, stop
  takes precedence: no later report or event may restart the work or initiate a new
  external action without a fresh authorization. The operator MUST see any uncertain
  outcome, including an external operation that completed after the stop.
- If a required human gate cannot be reached or the report cannot be delivered,
  completed work and evidence MUST remain available for recovery.
- If an existing pull request is closed, merged, or changed externally during a
  run, the system MUST inspect its current state before attempting delivery.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST accept a request to implement a named existing
  specification only through the dsh-superagent's current authorization rules.
- **FR-002**: Before execution, the system MUST identify the specification, plan,
  tasks, permitted scope, and an identifiable version approved by an authorized
  person. The approval MUST identify the approver, repository, feature, baseline
  revision of the specification, plan and tasks, and permitted work. The system
  MUST validate it before each segment and before delivery. If any is missing,
  ambiguous, invalid, or cannot be verified, work MUST stop and the system MUST
  explain what is needed.
- **FR-003**: The system MUST bind one Ticket to at most one active runner and
  retain enough information to identify the runner, its workspace, approved scope,
  current state, and report after an interruption. The system MUST reserve each
  segment before launch so simultaneous requests cannot start duplicate runners.
- **FR-004**: A runner MUST operate in the Ticket's assigned workspace and branch
  and MUST NOT change files outside the approved scope. The system MUST enforce this
  with an actual boundary over the writable paths, process access and network, not
  only through instructions to the runner. No other agent may edit that workspace
  while the runner can write to it; external changes detected before delivery MUST
  be reconciled before proceeding.
- **FR-005**: Before launch or a destructive setup action, the system MUST verify
  required runner tools and supported options, skill invocation, the environment,
  backend connectivity and credentials through minimal real checks, and the
  availability of required checks. A failed preflight MUST prevent launch.
- **FR-006**: The system MUST delegate work with a bounded objective ending no later
  than the next human gate, and MUST apply the autonomous runner's scope, waiting,
  dependency, and manual-gate constraints. One run segment MUST cover exactly one
  authorized scope segment. The system MUST distinguish the controls it enforces,
  such as the writable paths, the network, the credentials and the stop behavior,
  from the constraints it only instructs, such as the task order inside an allowed
  path. Where a task boundary cannot be enforced, the segment MUST stop for a human
  decision instead of claiming the boundary was held.
- **FR-007**: The runner MUST follow the approved task order, mark only completed
  automatable tasks, run required objective checks, and record their actual results.
- **FR-008**: After each segment's automatable work, the system MUST assess the
  implementation against the approved specification, plan, and tasks, with at most
  two convergence rounds. Before a human gate, the assessment MUST cover only the
  authorized segment and MUST record the later tasks as not assessed; it MUST NOT
  claim coverage of work that waits for a person. After the last segment, the
  assessment MUST cover the whole approved scope. Assessment MUST run on an
  isolated copy and its findings MUST remain proposals: they MUST NOT change the
  approved scope, and new work needs a new approved specification. Findings left
  after the second round MUST be reported for human decision, not presented as
  ready. Any other incomplete assessment prevents a ready claim.
- **FR-009**: At an explicit human gate or required decision, the runner MUST stop
  before the gate and subsequent tasks, preserve its report, and leave the gate
  unchecked until a person performs the required review.
- **FR-010**: The system MUST relay one concrete decision request through the
  Ticket's original conversation and record the specific decision of an authorized
  person before allowing continuation. Only a human reviewer may mark a manual gate
  complete. Changes to scope-bearing content require renewed authorization; task
  progress alone does not change the approved scope.
- **FR-011**: The system MUST produce one durable report that identifies the approved
  baseline, the result revision, completed and remaining tasks, checks and their
  results, risks or blockers, and the next human decision where applicable. The
  report MUST keep separate what the runner observed, including the workspace state
  it produced, and what the system verified, including the result revision it
  created and the checks it reran; neither part may be presented as the other's
  evidence. Notifications MUST NOT be the sole record of outcome.
- **FR-012**: The system MUST independently verify the reported artifacts and
  repository state and rerun the required checks against the exact result revision
  before presenting it as ready for review. It MUST recheck the authorized scope,
  stop state, and current delivery target before publishing. Missing, unrepeatable,
  stale, or failed evidence MUST prevent a ready claim.
- **FR-013**: The system MUST deliver an eligible result through the Ticket's pull
  request with a summary of changes, actual checks, and material limitations. A
  draft pull request MAY be opened or updated to provide gate-review evidence, but
  this MUST NOT mark the Ticket or feature ready or complete. If the original
  conversation cannot be reached, the decision request and evidence MUST remain
  available to the operator and continuation MUST remain blocked.
- **FR-014**: The system MUST NOT merge a pull request or enable automatic merge in
  this first version; merging remains a human decision.
- **FR-015**: An authorized stop MUST prevent continuation and request shutdown of
  the associated runner. The system MUST distinguish confirmed stop from an
  unconfirmed stop and MUST NOT claim the runner has stopped without evidence. After
  the stop, the system MUST NOT initiate a new external action for that Ticket, and
  a late result MUST NOT restart or publish stopped work. An external operation that
  was already accepted before the stop MAY complete afterwards; the system MUST
  reconcile its outcome, report it honestly as uncertain or completed after the stop,
  and MUST NOT claim that it rolled the remote action back.
- **FR-016**: After interruption, restart, lost notification, or retry, the system
  MUST reconcile persisted run identity, actual runner state, artifacts, and
  external delivery state before launching or repeating work. Unknown state MUST
  block a replacement until resolved.
- **FR-017**: The system MUST prevent duplicate active runners and duplicate delivery
  for the same Ticket segment, including under repeated requests and notifications.
- **FR-018**: The system MUST report failed prerequisites, unavailable dependencies,
  failed checks, quota limits, and runner errors distinctly, with actionable evidence;
  it MUST NOT silently substitute a missing dependency.
- **FR-019**: For metered providers, each run MUST have the autonomous runner's
  external quota guard and configured warning/stop thresholds. The guard MUST remain
  active while the runner may still be running. After a confirmed stop or completion,
  the system MUST clean up run-owned monitoring and other resources without affecting
  unrelated runs.
- **FR-020**: The system MUST define and document the runner's operating identity,
  accessible credentials, effective privileges, and actual isolation. The operator
  MUST approve the execution environment and its credential access before launch.
  Credentials MUST NOT appear in reports, project artifacts, or conversations.
  Reports and notifications are untrusted inputs and MUST NOT change authorization.
  The Ticket's workspace, credential wrappers, and prompt instructions MUST NOT be
  presented as a security sandbox.
- **FR-021**: The first version MUST handle one configured repository and at most one
  active runner at a time. Additional eligible requests MUST wait without launching
  another runner.
- **FR-022**: Project artifacts produced by this feature MUST be in English; replies
  to operators MUST follow the conversation's language.

### Key Entities

- **Ticket**: The authorized work item and its scope, origin, status, and associated
  review conversation.
- **Approved specification**: The identified specification, technical plan, task
  list, and approved version that define the permitted work.
- **Run segment**: One bounded period of autonomous work for a Ticket, ending at a
  human gate, successful delivery, stop, or failure; linked to one runner identity.
- **Human gate**: A decision or manual check that a person must perform before later
  work can proceed.
- **Run report**: Durable evidence of completed work, checks, remaining work,
  blockers, and the required next action.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In an end-to-end acceptance test, an authorized request for a prepared
  specification produces one reviewable pull request with the actual test evidence;
  zero duplicate runners or pull requests are created.
- **SC-002**: In all tested human-gate scenarios, the gate stays unchecked and no
  later task is started by the runner before an authorized human decision, and the
  report states which controls were enforced and which were only instructed.
- **SC-003**: In all tested stop, restart, duplicate-event, and lost-notification
  scenarios, no unverified stop is reported as confirmed and no replacement runner
  starts while the prior runner's state is unknown.
- **SC-004**: In all tested missing-prerequisite, failed-check, quota, and missing-
  report scenarios, no result is presented as ready and the operator receives a
  report identifying the blocker.
- **SC-005**: In all tested successful or gated runs, the operator can identify the
  approved specification version, the completed work, the actual checks, and the
  next action from the retained report and Ticket conversation.

## Assumptions

- The first version is for one configured GitHub repository, one active runner at a
  time, explicit authorized requests, and manual pull-request merging.
- The target repository already contains an approved specification, plan, task list,
  project constitution, and runnable checks. Approval is a verifiable decision by an
  authorized person tied to the repository, feature, revision, and permitted work;
  the technical representation of that record is a planning decision.
- The operator can provide a controlled environment, the required credentials and
  model access, and quota-monitoring configuration. Credentials are not requested in
  the GitHub conversation.
- The dsh-superagent and Prime Agent can run on the same host for the initial version.
  The integration does not claim a sandbox beyond the isolation actually configured.
- An authorized person performs manual review and can communicate decisions on the
  Ticket's conversation. No automatic acceptance of human gates is permitted.
- Creation of new specifications and plans, proactive autonomous intake, multiple
  concurrent runners, automatic merge, and multi-repository orchestration are outside
  this first version.
