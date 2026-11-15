# Operating and delivery model

Status: Draft 0.1. Local procedures inspired by ITIL 4; the workflow states and responsibilities below are workshop choices. See [framework reference](framework-reference.md) for primary sources.

## Responsibilities

| Responsibility | Initial accountable party | What accountability covers |
| --- | --- | --- |
| Product/service owner | Cody | Desired outcomes, scope, acceptance and service commitments |
| Configuration owner | Cody | Equipment identity, reconciliation, reviewed baselines and retirement |
| Operator/custodian | Cody or a specifically designated operator | Physical printer readiness, intended command target and supervised qualification |
| Delivery implementer | Assigned contributor or coding agent | Requirement traceability, test evidence, implementation and documented limitations |
| Release/change authority | Cody; routine changes may later have an explicit pre-authorized policy | Operational activation, impact tolerance, rollback and acceptance of residual risk |

One person may hold several responsibilities. Role separation here clarifies decisions; it does not invent staff. General authorization to research/specify is not standing authorization to exercise physical printer controls.

## ITIL 4 practice application

| Practice | Workshop application | Minimum useful evidence |
| --- | --- | --- |
| Service configuration management | Identify relevant CIs and reconcile configuration/relationships | Identity, baseline, provenance, conflicts and changes |
| Monitoring and event management | Observe significant state changes and group related noise | Source time, affected CI, severity, deduplication and recovery |
| Incident management | Restore an unexpectedly interrupted/degraded service | Impact, owner, action, restoration evidence and resolution |
| Problem management | Investigate recurring/important failures and maintain workarounds | Related incidents, cause hypothesis, evidence and follow-up |
| Change enablement | Assess changes proportional to their effect on printing and access | Scope, risk, authority, validation and rollback |
| Release and deployment management | Distinguish a releasable version from installing/activating it | Artifact/version, configuration baseline, compatibility and rollback |
| Service validation and testing | Verify the promised behavior and disclose qualification limits | Requirement/scenario evidence and exact environment |
| Knowledge management | Retain fixes, compatibility evidence and operating procedures | Source-linked notes; 3DBrain links where appropriate |
| Continual improvement | Use actual gaps and incident evidence to choose the next increment | Outcome, baseline, target, action and measured result |

## Event, incident and problem handling

Not every state change requires intervention. Completion is normally informational; a requested pause is expected. Failure severity is based on user/service impact and current context, not merely a device's status word.

Local event handling: observe -> classify -> correlate/deduplicate -> display/notify where configured -> acknowledge when action is needed -> record recovery. Acknowledging an item does not change printer state or erase the evidence. Prevent notification floods during reconnect loops.

Local incident handling: new -> acknowledged -> investigating -> restored -> resolved/closed. Record affected service/CI, impact, observations, current owner, steps taken and the evidence that service was restored. Mark a workaround separately from a permanent fix. A stale status alone must not assert that the physical printer stopped.

Local problem handling: identify recurring/material issue -> relate incidents -> investigate -> record known cause/workaround -> propose corrective change -> verify improvement. A first-release dashboard can expose linked follow-up records without implementing a full problem-management UI.

Example: one camera failure can be a monitoring incident. Repeated stream failures with a suspected single-client cause become a problem investigation. A validated camera-sharing update is a corrective change. Printer motion should not be interrupted merely to restore its camera view.

## Change handling

| Type of work | Required treatment |
| --- | --- |
| Routine requested pause/resume/cancel | Validate permission, target, job/state and outcome; retain command record. This does not automatically require a separate formal change record. |
| Printer address, identity, credential, capability or host configuration change | Record configuration delta, affected CIs, authority and verification; protect secrets and preserve baseline/rollback information |
| New adapter, camera helper, schema migration or network-control exposure | Document impact, test/qualification plan, compatibility, rollback and activation decision |
| Predefined repeatable low-risk operational change | Eligible for a standard-change policy only after its procedure and scope have been explicitly approved |
| Urgent restoration | Record reason/authority, minimal action and recovery evidence; review afterward. Urgency does not permit silently losing records or skipping target validation. |

Use a short record proportional to the risk. Do not make every theme preference a change-management workflow. Changes to live host/printer behavior remain distinct from reversible local document work.

## SDLC and stage criteria

| Stage | Entry/work | Exit evidence |
| --- | --- | --- |
| 0. Discover | Read code, fleet facts and exact Maker Watch sources | Research/decision notes with provenance and declared unknowns; completed |
| 1. Specify | Define service outcomes, CI model, user journeys, requirements and acceptance | Reviewed draft scope, terminology, priorities and unresolved decisions; current stage |
| 2. Design | Settle behavior contracts/test seams, interaction flows, identity migration and command safeguards | Agreed interfaces/scenarios, representative mockups, failure/recovery design; no implied physical qualification |
| 3. Build by vertical slice | One behavior through its selected interface; failing test, minimal implementation and reviewed improvements | Traceable red/green evidence, appropriate regression results and source notices |
| 4. Validate | Simulated failures, browser/OBS integration, restore/migration and controlled hardware checks | Capability/model/firmware matrix; resource/freshness results; known limitations |
| 5. Release and deploy | Package the version and plan activation against the actual baseline | Cody's activation decision, backup/rollback, smoke results and updated deployed-version record |
| 6. Operate and improve | Monitor behavior, reconcile drift, handle issues and measure outcomes | Useful incident/problem/improvement records feeding the next small slice |

Stages may repeat for an increment. They are not a requirement to finish every future feature before testing a first useful view. The current instruction is specification work; application changes and live tests are outside this stage.

## Change and release record contents

Use stable references to requirement/scenario, affected CIs, version/source revision, reason and expected outcome. Include risk/impact, evidence required, implementation steps, credential-free configuration delta, backup/rollback method, person/authority, timing, result and residual limitations.

Before a host or data-model change, identify whether ongoing monitoring will be interrupted and whether prints are autonomous or depend on the host being changed. Never assume a dashboard host and a printer-control host are the same machine. Back up protected configuration separately from shareable inventory exports.

## Measurements

Start with targets in the product spec and measure against actual evidence. Useful measures include inventory records with verified identity/owner/source, unresolved reconciliation conflicts, stale-observation duration, command unknown-outcome rate, repeated reconnects, time to restore dashboard capabilities and regression escapes. Count completed/failed jobs only over an identified observation window.

No uptime SLA, response-time support agreement or incident response staffing is committed by this draft. Retention, backup frequency and restoration objectives need values before durable records are released. Candidate local defaults for design review: daily protected backup, 90 days of detailed observation/command/event history and retained CI/change history until retirement policy permits removal. Validate storage and privacy needs before baselining these values.

## Operational readiness checklist

- Actual production host and its printer-control dependencies are identified.
- Inventory/alias migration and a tested restore path exist.
- Authorized LAN users and access behavior are defined; legacy write paths follow the same policy.
- Each advertised capability has exact model/firmware qualification evidence.
- Camera/P1 connection ownership and recovery are documented.
- Backup, retention, rollback and known limitations are recorded.
- Existing OBS sources have representative regression and rendered-view evidence.
- The deployed version and configuration baseline can be identified after restart.
