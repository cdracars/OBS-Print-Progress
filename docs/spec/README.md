# Printer Dashboard specification

Status: Specification draft 0.1; first implementation preview available. Owner and decision authority: Cody Dracars. Updated: 2026-11-14.

This package turns the dashboard research into a service, configuration, operations and delivery specification. The selected direction is to evolve the current repository, retain its printer connections and OBS views, and selectively borrow from the exact Maker Watch candidates. Detailed requirements remain a draft. The first local implementation is available; see [implementation evidence](implementation-evidence.md) for tested behavior and remaining release gates. Physical qualification has not begun.

## Read in this order

1. [Product and service requirements](product-spec.md): outcomes, scope, user journeys, requirements and release boundaries.
2. [Service model and CMDB](service-model-cmdb.md): CSDM 5 mapping, identities, records, relationships, reconciliation and impact.
3. [Operating and delivery model](operating-model.md): ITIL 4 practices, ownership, SDLC stages and release evidence.
4. [Acceptance and TDD plan](acceptance-plan.md): traceability, proposed test seams and behavioral acceptance scenarios.
5. [Framework reference](framework-reference.md): primary-source terminology and the limits of this adaptation.

Use the root [glossary](../../GLOSSARY.md) for shared language. [Dashboard decision](../dashboard-decision.md) records the architecture/reuse choice; [Maker Watch index](../dashboard-makerwatch-index.md) preserves the exact research trail. This package governs proposed scope and acceptance where it is more specific than the earlier research notes.

## Framework use

| Lens | Purpose here | Practical artifact |
| --- | --- | --- |
| CSDM 5 | Connect user outcomes, services, application deployments and supporting equipment | Service map and ownership |
| CMDB | Preserve equipment identity, intended configuration, relationships and evidence | Logical record model and reconciliation rules |
| ITIL 4 | Define how the workshop observes, restores, changes and improves its services | Small operational workflows linked to CIs |
| SDLC | Establish what must be known and verified before each delivery stage | Readiness and exit criteria |
| TDD | Turn accepted behavior into executable evidence one vertical slice at a time | Requirement-to-scenario traceability and test seams |

These are deliberate adaptations for a small workshop. They do not require installing ServiceNow, creating a service desk organization, or claiming certification/compliance. Local relationship names are application vocabulary, not assertions about exact ServiceNow table relationships. Product screens should use ordinary workshop language.

## Decision register

| ID | Decision | Status |
| --- | --- | --- |
| D-01 | One application host shares connections across dashboard and existing OBS views | Selected direction |
| D-02 | PF PrintFloor is the primary source-reuse candidate; Gantry, Printroom, HA card and PrintForge provide specific workflow references | Selected direction |
| D-03 | Inventory identity and configuration are separate from live observations, print jobs and commands | Proposed specification baseline |
| D-04 | Printer support is qualified per capability, model and firmware; partial support remains visible | Proposed specification baseline |
| D-05 | Specification and acceptance design precede application changes; live printer-control validation is a separate supervised stage | Implemented preview; physical validation pending |
| D-06 | Same-LAN desktop/phone operation is the first access scope; off-site access and production scheduling are later work | Proposed release scope |

## Evidence still needed

- Confirm the actual models behind `pibeta` and `eighttrack`, without guessing from old names.
- Identify and enroll the Prusa MINI, Saturn 4 Ultra and Photon P1; record firmware, reachable interfaces and camera behavior.
- Establish the production host, backup destination and permitted LAN users.
- Complete the remaining acceptance scenarios and hardware qualification in the implementation evidence report.
- Measure achievable freshness, camera load and recovery behavior on the actual host/fleet; draft acceptance targets are not service guarantees.

These gaps do not prevent further specification work. They prevent unsupported claims about hardware or operational readiness.
