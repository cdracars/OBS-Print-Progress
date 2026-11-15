# CSDM 5 and ITIL 4 reference for the printer dashboard

Research date: 2026-11-14. This is a terminology and interpretation reference, not a compliance assessment, ServiceNow implementation, or complete reproduction of either framework. Workshop examples are local modeling suggestions; requirements and acceptance criteria belong in the companion specification. Only ServiceNow and PeopleCert primary sources are used below.

## CSDM 5 distinctions

| Term | Framework distinction | Possible workshop mapping — local interpretation |
| --- | --- | --- |
| Business service | Consumer-facing service associated with business outcomes/capabilities. | Workshop printing: producing usable physical parts. |
| Business service offering | A defined variation with scope and service commitments. | Filament-part production versus resin-detail production, if their scope and commitments genuinely differ. A tile or printer model alone is not an offering. |
| Business application | Design/planning representation of software supporting capabilities; can span deployments/environments. | Printer Dashboard as an application in the workshop's software portfolio. |
| Service instance | Deployed/provisioned/configured service representation. CSDM 5 expands instances beyond application services. | The operational workshop-dashboard deployment, identified separately from the product/source repository. |
| Application service | A service-instance subtype representing a deployed application/system stack. | The dashboard deployment and its runtime dependencies. Not the physical printer. |
| Technology management service | Operational/administrative service managing underlying technology; previously Technical Service. | Printer connectivity and monitoring management, if maintained as an actual supporting service. |
| Technology management offering | A scoped variation of that management service, with technical commitments and support context. | Local workshop monitoring coverage and its operating/support arrangements. Not an adapter class or MQTT topic. |

Source for the distinctions: ServiceNow's [CSDM 5 white paper](https://www.servicenow.com/community/s/cgfwn76974/attachments/cgfwn76974/common-service-data-model-kb/744/3/CSDM%205%20w%20links.pdf), printed pp. 32, 37–43 and 45–46. Definitions are summarized; examples in the final column are ours.

Version detail: CSDM 5 relabels `cmdb_ci_service_auto` **Service Instance**; application-service subclasses remain alongside new instance types. These additions are optional when unnecessary locally. “Application service” has not vanished. Same source, printed pp. 37–40.

## Physical equipment and relationships

The white paper distinguishes equipment/operational technology from deployed applications. Our interpretation: model a physical printer as an **equipment/OT configuration item** with stable identity; separately maintained hosts and cameras may also be CIs. A multi-device production process could justify an operational-process service instance. Neither a printer nor a print job is therefore an application service. This does not prescribe a ServiceNow printer table.

ServiceNow's official [Service Delivery domain documentation](https://www.servicenow.com/docs/r/zurich/servicenow-platform/common-service-data-model-csdm/manage-tech-servs-domain.html), especially the relationship section, distinguishes deployed applications, infrastructure and service dependencies. If we reuse names such as `Depends on` or `Runs on`, document direction and meaning. A host dependency, camera association and operational ownership are different facts; a generic “related to” edge cannot support reliable impact assessment.

For this project, separate enduring configuration from activity:

- **CI:** the printer or deployed dashboard instance being managed.
- **CI relationship:** an evidenced association such as a dashboard deployment running on a host, with provenance and validity dates where needed.
- **Observation:** a timestamped report about a CI, such as temperature, network reachability or firmware discovered now. It can support reconciliation; it should not silently overwrite an operator-maintained identity or imply permanent topology.
- **Job:** a bounded production activity associated with a printer, file and material.
- **Command:** an operator/system request and its outcome, linked to its target, job and evidence.

Those last three record types are project design distinctions, not mandatory CSDM classes. Do not represent each sample, job or button click as a new CMDB CI/relationship. PeopleCert's [ITIL 4 Service Configuration Management](https://www.peoplecert.org/browse-certifications/it-governance-and-service-management/ITIL-1/itil-4-practitioner-service-configuration-management-3800) emphasizes dependable configuration information when needed; the value is trustworthy identity, configuration and relationships, rather than maximizing record counts.

## ITIL 4 operational distinctions

| Concept/practice | Sourced emphasis | Local example — interpretation |
| --- | --- | --- |
| Monitoring and event management | Observe service/components and respond to selected significant state changes. | A printer stops reporting, a job completes, or an error begins. A raw temperature sample need not create an event. |
| Incident management | Restore disrupted service; distinguish immediate restoration from investigation of underlying causes. | Restore lost monitoring needed to supervise a running job. An intentionally powered-off idle printer is not automatically an incident. |
| Problem management | Investigate/manage actual or potential causes and prevent recurrence; retain useful workarounds/known errors. | Repeated disconnects linked to a faulty switch, rather than one problem record per failed poll. |
| Change enablement | Assess risk, authorize changes and coordinate their timing to improve successful outcomes. | A firmware upgrade, host migration or change to connection/configuration behavior. |

Primary sources: PeopleCert [Monitoring and Event Management](https://www.peoplecert.org/professionals/certifications/browse-certifications/it-governance-and-service-management/ITIL-1/itil4-practices-monitoring-and-event-management-3686), [official incident/underlying-cause discussion](https://community.peoplecert.org/public/clubs/itil/blogs/the-culture-of-firefighting-in-itsm-2026-08-12), [Problem Management](https://www.peoplecert.org/browse-certifications/it-governance-and-service-management/ITIL-1/itil4-practices-problem-management-3688), and [Change Enablement](https://www.peoplecert.org/browse-certifications/it-governance-and-service-management/ITIL-1/itil-4-practitioner-change-enablement-3794).

Routine pause/resume/cancel requests are **operational commands in our local model**. Do not automatically open an incident or formal change record for each command. A command can be part of incident restoration or execution of an authorized change; those links are contextual. Conversely, do not classify every routine command as an ITIL “standard change” merely because it is familiar. Its treatment depends on the explicitly defined change scope, risk and authorization model.

## Proportionate application

For a single-owner workshop, the same person can own the service, maintain CIs, authorize changes and operate printers. This is a local operating choice, not a requirement to invent multiple teams. A small configuration register, event timeline, linked restoration/investigation notes, and risk-appropriate change records can express the distinctions without an enterprise ticketing deployment. Keep routine records lightweight; preserve decisions, evidence and uncertain outcomes.

Use **CSDM 5-informed** and **ITIL 4-informed** to describe the design. Do not claim certification, complete framework conformance or mandatory ServiceNow dependency. Although PeopleCert's current site also advertises newer ITIL qualifications, this reference deliberately retains the user's requested ITIL 4 scope. SDLC traceability, TDD gates and software-release acceptance are project governance choices to specify explicitly; they should not be attributed to these brief public framework summaries as prescribed implementations.
