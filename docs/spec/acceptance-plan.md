# Acceptance, traceability and TDD plan

Status: Draft 0.1. These are behavioral scenarios and a verification plan. The accepted interfaces now have automated behavior tests; see [implementation evidence](implementation-evidence.md) for results and outstanding physical qualification. No physical printer-control commands have been exercised.

## Proposed test seams

These public interfaces formed the test scope accepted with implementation. Interface details and route names can change without changing the product requirements.

| Seam | What tests can prove | What they cannot prove alone |
| --- | --- | --- |
| Inventory/configuration interface | Stable CI identity, reconciliation, baselines, retirement, exports and compatible aliases | A device's reported identity is physically truthful |
| Printer-state interface | Normalized readings, state separation, capability evidence and freshness | A simulated payload matches every physical firmware variant |
| Printer-command interface | Eligibility, target/job checks, deduplication and truthful outcomes | Physical execution without a corresponding device observation |
| Camera lifecycle interface | Sharing, viewer release, independent errors and bounded resources | A particular real codec/browser combination works |
| Browser/OBS presentation | Operator workflows, visible states, accessibility, target confirmation and compatibility URLs | Printer protocol correctness or unattended physical readiness |
| Operational-record interface | Links from events/commands/changes to CIs; persistence, gaps and recovery semantics | Complete history outside the dashboard's observation window |

Use real module interfaces with deterministic fake printers and clocks for behavior tests. Inject protocol failures at the connection interface. Use known protocol fixtures and worked examples as expected values; do not duplicate the implementation's calculations inside assertions or test private methods as the public contract.

## Requirement-to-scenario matrix

| Scenario | Requirements | Given / when / then |
| --- | --- | --- |
| AC-01 Fleet completeness | FR-01, FR-03 | Given eight enrolled printers and one offline machine, when the fleet loads, then eight identities remain represented; filtering does not delete the offline record or its last-known job. |
| AC-02 Desktop and phone workflow | FR-02, NFR-08 | Given the same fleet on desktop and phone, when selecting a card and returning, then detail and navigation remain usable, keyboard focus is sensible and layout preferences persist; state is not communicated only by color. |
| AC-03 Fresh versus cached | FR-03, NFR-02 | Given a five-second observation interval and last valid source observation at time zero, when the clock passes 15 seconds without another applicable observation, then the reading becomes stale. Cached responses at times 5/10 do not reset its age. |
| AC-04 Resin and unknown readings | FR-04 | Given a Saturn job with layers/progress and no nozzle or bed sensor, when rendering its detail, then it shows available resin-relevant data and no invented 0°C hotend/bed. Missing ETA differs from an estimate. |
| AC-05 Shared camera lifecycle | FR-05, NFR-03, NFR-04 | Given one shareable upstream camera and two viewers, when one viewer closes, then the other remains served without a second upstream connection; camera failure leaves printer status usable. |
| AC-06 Eligible actions | FR-06 | Given an offline, stale, maintenance-blocked, unsupported or identity-conflicted target, when requesting an ineligible operation, then it is rejected with a useful reason and no printer transmission. The policy states which restrictions apply to each action. |
| AC-07 Uncertain command | FR-07, NFR-06 | Given a pause whose response is lost, when no confirming state arrives, then the outcome is unknown, not successful; reconnect/restart does not silently resend it. A later attributable observation may resolve the outcome. |
| AC-08 Correct cancellation target | FR-06, FR-08 | Given a confirmation for job A, when job B is observed before dispatch or the selected printer changes, then the confirmation is invalidated. Repeated clicks produce one managed operation. Unavoidable protocol race limits are documented and tested at the supported interface. |
| AC-09 Discovery and identity | FR-09, FR-10 | Given a printer with matching verified vendor identity at a new address, when discovery runs, then reconciliation proposes updating its endpoint while retaining CI/OBS identity. A conflicting machine at its old address is not silently merged. |
| AC-10 Lifecycle and baseline | FR-10 | Given an active printer with history, when it is renamed, placed in maintenance and later retired, then its stable identity/history remain and each relevant change has provenance; none of those steps invents a physical job outcome. |
| AC-11 Service impact | FR-11, NFR-05 | Given a running autonomous print and dashboard-host interruption, when visibility is lost, then monitoring impact and an observation gap are shown after recovery; the application neither sends stop nor claims the print failed. A camera-only fault has narrower impact. |
| AC-12 Existing OBS continuity | FR-12 | Given representative existing status/twin URLs and orientation/theme settings, when the dashboard is introduced and configuration migrated, then those URLs select the same intended printer and their rendered behavior is preserved. |
| AC-13 Access and secrets | FR-13 | Given a network client without command permission, when invoking either new command routes or legacy proxy write paths, then no operation reaches the printer. Normal views/exports/logs do not contain access codes or camera passwords. |
| AC-14 P1 handoff | FR-14 | Given Photon Workshop owns the P1 session, when the dashboard encounters displacement/contention, then it exposes the reason and follows the defined handoff/backoff policy without a rapid reconnect contest or duplicate commands. |
| AC-15 Backup and restore | FR-15, NFR-06 | Given a reviewed non-secret inventory export and separately protected credential backup, when restoring to a clean deployment, then identities, aliases and relationships reconcile; missing secrets are reported; no printer is commanded by import. |
| AC-16 Update/failure isolation | NFR-01, NFR-03 | Given eight simulated printers and one hung/malformed source, when healthy source updates arrive, then healthy foreground cards update within the draft host-to-UI target and setup remains responsive. |
| AC-17 Resource behavior | NFR-04 | Given two dashboards and OBS, when cards scroll offscreen or tabs hide, then unneeded dashboard camera work reduces, OBS remains served and resource/connection counts remain bounded. |
| AC-18 Local operation | NFR-07 | Given valid local connection prerequisites and no dashboard-provider account, when the dashboard starts on the permitted LAN, then qualified local monitoring still works; optional integrations failing do not block it. |

For AC-06, maintenance is not a blanket ban on pausing/canceling an active job. The design must distinguish blocking new work from stopping or inspecting existing work. For AC-08, protocols that lack conditional job-specific actions need an explicit fresh-state recheck and declared residual race risk; do not claim an atomic guarantee the printer cannot provide. Disable a control if the validated design cannot meet its target-check policy.

## CMDB-specific verification

Test two printers sharing a model/name, multiple endpoints for one CI, a replacement board with continuity evidence, a replacement physical printer reusing an address, an expired camera relationship and a retired printer with retained job records. Verify service impact from the actual relationship graph rather than hard-coded printer names.

Check that discovery cannot overwrite intended ownership/location, that drift proposals contain source/time evidence and that a firmware change flags affected compatibility evidence for reassessment. Device-reported values, operator-approved values and historical 3DBrain notes must retain distinct provenance.

## TDD delivery rule

For each implementation increment: choose one accepted scenario and settled seam, write a failing behavioral test, record why it fails, implement the minimum behavior to pass, and run the relevant regressions. Review the resulting design and any refactoring before the next slice. Do not write an entire imagined test suite and then implement the whole dashboard underneath it.

Example first slice: expose an enrolled offline printer through the fleet interface and show it as offline in the overview. Follow with freshness, unknown resin readings, and preserved OBS lookup before adding controls. These are proposed sequencing choices, not existing passing tests.

## Verification layers and evidence

| Layer | Evidence to retain | Release interpretation |
| --- | --- | --- |
| Document review | Requirement/scenario/CI model consistency, unresolved decisions and revision | Scope/design readiness only |
| Automated behavior | Test identifier, requirement, red/green result and exact source revision | Specified behavior at the selected seam |
| Simulated integration | Recorded fixtures, timeouts/malformed data, reconnect and duplicate-command cases | Protocol behavior against defined simulations |
| Browser and OBS | Browser/OBS versions, viewport, steps and rendered result | Presentation and existing-source compatibility |
| Physical qualification | Printer CI/model/firmware, operator, exact capability/action, expected/actual result and recovery | Support for that capability in that recorded environment |
| Release/restore | Artifact and configuration baseline, backup, restore/rollback results and limitations | Operational readiness for the declared scope |

Physical checks progress from identity/readings to camera behavior, then to supervised commands on an appropriate test job. A simulation passing is never a substitute for observing the machine. Qualification must not interrupt an unrelated production print. This plan does not authorize executing physical checks now.

## Evidence record template

- Requirement and scenario IDs.
- Version/source revision and environment; actual CI, model and firmware for hardware.
- Preconditions, inputs and independently determined expected behavior.
- Observed result, timestamps and sanitized evidence location.
- Automated/simulated/physical status, reviewer/operator and limitations.
- Defect or change link; retest outcome and qualification scope.

## Definition of ready and done

A slice is ready when its user outcome, requirement, target CI/capability, accepted scenario, seam and failure behavior are clear. Unknown physical support is an explicit qualification task, not an invented assumption.

A slice is done for its declared level when the scenario passes at that level, relevant regressions pass, records/links are updated, imported source notices are retained, and known limitations are visible. A release claiming physical printer control additionally needs the matching physical qualification and deployment evidence. No new test or physical result is claimed by these draft documents.
