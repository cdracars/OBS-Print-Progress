# Product and service requirements

Status: Draft 0.1. This is a target behavior specification, not a description of completed functionality. See the [package index](README.md) for authority and supporting documents.

## Purpose and outcomes

Give Cody one reliable place to understand and operate a mixed filament/resin fleet, primarily on a desktop with access from a phone. A useful dashboard answers: what is printing, what needs attention, how recent is that information, what can this machine do, and what happened when I requested an action?

The application supports Workshop Printing through Printer Fleet Operations. Loss of the dashboard must not become a new dependency that stops printers executing their autonomous jobs. Preserving existing OBS sources is part of continuity of service.

## Target fleet

| Printer | Technology/connection path | Current planning position |
| --- | --- | --- |
| Hoss, SV08 | Filament; Klipper/Moonraker | Existing configuration |
| Sam, SV06 Plus | Filament; Klipper/Moonraker | Existing configuration |
| pibeta | Filament; configured Klipper | Confirm physical model/identity |
| EightTrack | Filament; configured Klipper | Confirm physical model/identity |
| Lucee, Centauri Carbon | Filament; Elegoo SDCP | Existing configuration and prior live evidence; preserve known behavior |
| Prusa MINI | Filament; PrusaLink | Identified by user; enrollment/qualification pending |
| Saturn 4 Ultra | Resin; Elegoo SDCP | Identified by user; enrollment/qualification pending |
| Photon P1 | Resin; Anycubic LAN | Identified by user; new adapter and qualification needed |

This is a target inventory, not evidence that all eight are connected. Existing advertised printer families beyond this fleet must not be silently removed during migration; continued compatibility is assessed separately from newly qualified hardware.

## First usable release

Include the fleet overview, printer detail, basic CI inventory/relationships, setup, supported pause/resume/cancel commands, explicit support evidence, same-LAN access readiness, and preserved OBS views. Deliver capability increments; a monitoring preview must identify itself as such. Do not label an unqualified printer family fully supported just to call a release complete.

Include a small in-app attention/event view and records needed to explain configuration changes and command outcomes. Longer-term analytics, temperature-history storage, maintenance management, inventory integrations, theme editing and a combined OBS fleet view follow as separate increments.

Outside this first release: automatic file dispatch, print queues, multi-printer batch commands, unattended recovery, automatic failure-triggered stops, arbitrary remote G-code consoles, firmware management, cloud accounts, commerce and customer ordering. Preserve links to native advanced interfaces. A capability planned for later should not appear as a working control.

## User journeys

1. Open the dashboard and identify running jobs and degraded connections without visiting printer-specific sites.
2. Select a printer, inspect its camera/job/measurements, and perform a supported action with an understandable outcome.
3. Add or rediscover a printer, reconcile its identity, test connectivity, and see precisely which capabilities are available.
4. Follow an attention item to the affected printer and supporting equipment, distinguish a camera issue from a job failure, and record follow-up.
5. Copy an existing overlay URL or open native controls without breaking the fleet view or existing OBS setup.

## Functional requirements

| ID | Requirement | Evidence of acceptance |
| --- | --- | --- |
| FR-01 | Show every enrolled printer, including unavailable and partially supported items; filter by job/attention state and filament/resin | Fleet remains complete across disconnect/reconnect; filters preserve identity |
| FR-02 | Support full and compact cards plus printer detail; save local layout preferences; provide keyboard and phone access | Desktop and phone workflows operate without horizontal page scrolling |
| FR-03 | Display connection state, job state, age of observations and support evidence separately | Disconnected printing machine retains dated last-known job; no false idle/failed job |
| FR-04 | Show job identity/name, progress, elapsed/remaining estimates and relevant temperatures/layers only when available | Unknowns remain explicit; estimates are labeled; resin has no fictitious hotend/bed |
| FR-05 | Provide camera preview/detail with independent availability and a shared connection where supported | Multiple viewers do not unnecessarily multiply constrained upstream sessions |
| FR-06 | Expose only supported, currently permitted actions; validate the current target/job before sending pause/resume/cancel | Wrong-job, stale or unsupported requests are rejected before transmission |
| FR-07 | Track a command from request to confirmed effect or explicit failed/unknown outcome | Acceptance alone never becomes a success claim; no blind retry after uncertain delivery |
| FR-08 | Confirm cancellation using printer and job identity; protect against repeated clicks and observed target changes | A known replacement job invalidates the confirmation; protocol race limits have an explicit control policy |
| FR-09 | Add/edit/test/discover printers through setup and reconcile discoveries before enrollment | Changed address does not create another physical printer; ambiguous matches require review |
| FR-10 | Maintain CI identity, ownership, lifecycle, intended configuration and relevant dependency relationships | Rename/address change preserves CI/history/OBS mapping; retirement preserves evidence |
| FR-11 | Explain attention items and link events, command records and configuration changes to affected CIs | Camera degradation, host outage and failed print have distinguishable consequences |
| FR-12 | Preserve existing OBS routes, printer selection and configured appearance/camera preferences | Existing representative OBS URLs continue to resolve and display the intended printer |
| FR-13 | Gate network control through authenticated access and request validation, including legacy write paths | Unauthorized requests do not reach a printer; credentials stay out of ordinary responses/exports |
| FR-14 | Keep one managed connection owner where a protocol requires it; provide explicit connection handoff | P1 contention is visible; the application does not create a rapid reconnect contest |
| FR-15 | Export/import the non-secret inventory and configuration baseline with version/provenance information | A restore preserves identities and aliases; credential setup is handled separately |

## Quality requirements and draft targets

These targets are proposed for qualification, not availability commitments to a customer.

| ID | Requirement/target | Qualification context |
| --- | --- | --- |
| NFR-01 | A supported live card reflects a received host update within two seconds | Eight simulated printers, foreground desktop/phone; upstream printer delay measured separately |
| NFR-02 | Default stale threshold is the greater of 15 seconds and three expected observation intervals; silent sources age without browser refresh resetting them | Deterministic clock scenarios, including push connections; refine per capability during design |
| NFR-03 | One unavailable printer/camera must not block other cards, setup or commands | Inject slow, failed and malformed sources |
| NFR-04 | Bound connection/poll concurrency and active camera work; suspend unneeded dashboard previews in background | Test eight printers and two browser viewers plus OBS; report actual CPU/memory/bandwidth before fixing final limits |
| NFR-05 | Loss of the dashboard or camera helper must not issue a stop/restart to a printer | Process interruption and recovery scenarios |
| NFR-06 | Inventory, aliases and audit-relevant records survive restart; records expose observation gaps | Restart/restore scenarios; define retention before durable history work |
| NFR-07 | Core monitoring works on the LAN without a vendor dashboard account | Qualify each printer's own LAN prerequisites separately |
| NFR-08 | Initial browser qualification targets current desktop Chromium/Firefox, Android Chrome and iOS Safari, plus installed OBS browser source | Record exact versions in release evidence; validate phone layouts at 390px and desktop at 1440px, plus a 320px reflow check |

## Product presentation

Use normal language: Printers, Details, Attention, Equipment, Settings and OBS. CSDM/ITIL names belong in the specification and optional technical views. Printer identity and command outcome must be visible without opening debug information. State must be conveyed in text as well as color.

Use PF PrintFloor's fleet density/filtering and shared-camera ideas, Gantry's separation of fleet/maintenance/production, Printroom's freshness cues, and the HA card's compact-to-detail controls. Selected behavior is specified here; upstream UI/code changes do not silently change requirements. See [source review](../dashboard-makerwatch-candidates.md).

## Release acceptance

The first usable release requires traceable acceptance evidence for FR-01 through FR-15 and the qualified NFR targets. Record each printer/capability as unavailable, documented, simulated or physically verified. It is acceptable to release a clearly marked preview with declared gaps; it is not acceptable to advertise all-family controls without physical verification of those controls. See the [acceptance plan](acceptance-plan.md) for scenarios and the [operating model](operating-model.md) for release authority.
