# Exact Maker Watch dashboard candidates

Checked 2026-11-14 against the named upstream repositories, their current source and releases. This supplements the broader platform comparison. No external code was imported, installed or connected to printers.

## Decision

**PF PrintFloor is the best direct donor for the new dashboard**, while this repository remains the host and printer connection owner. Its MIT-licensed Python and plain browser-code approach fits much more closely than adopting a separate farm manager. Borrow selected presentation and connection-management behavior, not its entire application. Preserve our Prusa/Elegoo-resin paths, add Photon P1 deliberately, and retain OBS views.

Use **PrintForge for queue/recovery design**, **HA 3D Printer Card for compact/detail controls**, and **Gantry for desktop convenience and maintenance workflow ideas**. The evidence below explains the limits of each choice.

## PF PrintFloor — strongest code-reuse candidate

[PF PrintFloor](https://github.com/pomeroyfamily/pf-printfloor) explicitly monitors Bambu, Snapmaker U1/generic Klipper and original Centauri Carbon. It is status-only for print jobs; it also operates cameras and Govee plugs. It offers full/compact/list views, filters, grouping, camera wall, history and phone layouts. Prusa, Saturn and Photon P1 are not established in its supported-printer list; Kobra 3 is merely planned. [README](https://github.com/pomeroyfamily/pf-printfloor/blob/main/README.md)

The observed release list now includes [v0.1.4](https://github.com/pomeroyfamily/pf-printfloor/releases/tag/v0.1.4), published 2026-11-14, after v0.1.3 on November 11. It remains an early project, not a mature compatibility guarantee. [Releases](https://github.com/pomeroyfamily/pf-printfloor/releases)

### Reviewed reusable pieces

| Source | What the source actually does | Proposed use here |
| --- | --- | --- |
| [`app/models.py`](https://github.com/pomeroyfamily/pf-printfloor/blob/main/app/models.py) | Separate connection states (including authentication failure and connection slots full) from job states; optional temperatures, job fields and material slots; distinct `updated_at` and `last_seen_at`. | Adopt the distinction and field semantics in our shared status model. Add resin fields and command capabilities; do not substitute a full Pydantic migration just to copy a type. |
| [`app/static/app.js`](https://github.com/pomeroyfamily/pf-printfloor/blob/main/app/static/app.js) | Full/compact/list views, persistent local filters/sorting, state labels, formatting, detail/camera interactions, background camera suspension and `EventSource` updates. | Selectively adapt card/view/filter and visibility behavior into small dashboard modules that consume our hub. Do not copy its entire 2,300+ line script: it also includes cloud accounts, plug controls and automatic power cycling outside our first scope. |
| [`app/cameras.py`](https://github.com/pomeroyfamily/pf-printfloor/blob/main/app/cameras.py) | One upstream camera source shared across viewers; snapshot leases; delayed shutdown after the last viewer; source-specific MJPEG/JPEG/TLS handling. CC and stock U1 viewing sends camera-start commands. | Strong reference for reducing camera connections and bandwidth. Adapt sharing/lifecycle management to our current camera paths. Make camera activation explicit and retain direct-stream support. |
| [`app/web.py`](https://github.com/pomeroyfamily/pf-printfloor/blob/main/app/web.py) | REST routes, live SSE feed with heartbeat, streaming responses and disconnect checks. | Borrow one shared status feed/reconnect pattern, keeping OBS compatibility routes intact. Do not replace our server merely to get live updates. |

The repository's [MIT license](https://github.com/pomeroyfamily/pf-printfloor/blob/main/LICENSE) names Danny Pomeroy. Preserve that notice for copied or substantially adapted code. If reusing Bambu error tables, its [third-party notices](https://github.com/pomeroyfamily/pf-printfloor/blob/main/LICENSES-THIRD-PARTY.md) also preserve ha-bambulab attribution. The UI is a practical donor; smart-plug automation and its unauthenticated deployment defaults are not automatic requirements for our product.

Reviewed blob identifiers: models `d92fbe1e13a7bc61fab85b2f3c36221beaf78cb9`; browser script `f2277e3fd72771047c309e5f7136299faeef07b9`; camera module `6604341d1900974292048529153d6175125f1cad`. These identify the reviewed file versions, not a claim that code has been vendored.

## PrintForge — durable queue ideas, not our fleet backend

The exact candidate is [lloyd-kay/PrintForge](https://github.com/lloyd-kay/PrintForge), not another product sharing the name. [v0.2.0](https://github.com/lloyd-kay/PrintForge/releases/tag/v0.2.0) was published November 8, 2026, with a native Debian 13 installer integrating Spoolman and local Moonraker instances. [Releases](https://github.com/lloyd-kay/PrintForge/releases)

Its [README](https://github.com/lloyd-kay/PrintForge/blob/main/README.md) describes a self-hosted Klipper queue for already-sliced G-code, matching printer profiles and materials, and conservative filament reservations. Resin and belt printers are inventory-only. It is AGPL-3.0-or-later, so treat it as a design reference rather than copying implementation into this MIT project without a deliberate licensing decision.

Its [architecture](https://github.com/lloyd-kay/PrintForge/blob/main/docs/ARCHITECTURE.md) has several valuable contracts: one queue record per physical copy; reserve before sending; consume manual bed clearance per dispatch; never blindly repeat an uncertain start; retain ambiguous work for operator inspection; invalidate clearance after a disconnect, restart or external print. Profile compatibility is explicitly configured, not guessed from build volume. These are worth adopting if we later add a queue. Its [verification report](https://github.com/lloyd-kay/PrintForge/blob/main/docs/VERIFICATION.md) documents simulations and installer checks while explicitly leaving physical-printer acceptance pending. Do not treat the demo as a hardware-qualified scheduler.

## HA 3D Printer Card — compact controls and visual hierarchy

The exact [juju35/ha-3d-printer-card](https://github.com/juju35/ha-3d-printer-card) is MIT licensed and has full/mini cards, a progress ring, job thumbnail/camera, collapsible detail and confirmed pause/resume/stop controls. It sits above existing HA integrations; its supported families include Bambu, OctoPrint, Moonraker and PrusaLink, not verified Saturn or Photon P1 discovery. [README](https://github.com/juju35/ha-3d-printer-card/blob/main/README.md)

The reviewed [`src/3d-printer-card.js`](https://github.com/juju35/ha-3d-printer-card/blob/main/src/3d-printer-card.js) is a 3,256-line custom-element implementation with HA registry/entity resolution, state-dependent printer illustration, compact expansion and lifecycle cleanup. Copying it wholesale would import HA assumptions into our independent app. Prefer its compact-to-detail interaction, confirmation placement and restrained state animation; if extracting MIT helpers or artwork, preserve the applicable notices and review the exact assets first.

## Gantry — the correct named project

[parametryczny/Gantrybar](https://github.com/parametryczny/Gantrybar) is branded **Gantry**, distinct from similarly named repositories. Its current [README](https://github.com/parametryczny/Gantrybar/blob/main/README.md) advertises release 0.14.0, tray/full-window/edge views, job/filament/maintenance tools and optional web access. This has grown considerably beyond a desktop tray monitor. A local phone panel is read-only; optional hosted web access uses a generated website package and PHP/HTTPS hosting, with controls separately enabled.

Importantly, its more specific [SLA monitoring guide](https://github.com/parametryczny/Gantrybar/blob/main/docs/wiki/SLA-monitoring-EN.md) now lists **Saturn 4 Ultra and Photon P1**. These are experimental monitoring implementations checked with parsers/simulated connections; the document explicitly says physical printers were unavailable. Resin paths have no uploads, controls, Farm dispatch or built-in camera. P1 requires LAN mode and competes with Photon Workshop for a single MQTT identity. This makes Gantry a genuine mixed-fleet monitoring alternative, not evidence of verified resin control. Compare it in a later hands-on trial if adopting an external application becomes preferable.

Borrow the low-friction tray/portable-launcher idea and separation of monitoring, maintenance and production. The [Windows documentation](https://github.com/parametryczny/Gantrybar/blob/main/windows/README.md) describes a self-contained package, per-user installation, and Windows-protected local credentials. That is a useful end-user distribution reference. The inspected public `windows/` directory exposes a README rather than the implementation paths described inside it; do not promise reusable Windows source until the actual source availability is resolved. Its [contributing guidance](https://github.com/parametryczny/Gantrybar/blob/main/CONTRIBUTING.md) labels contributions MIT, but documentation is not a substitute for inspecting the specific code we would import.

## Implementation consequence

Start with PF PrintFloor-style fleet cards, filters and on-demand shared cameras, backed by our connections. Add the HA card's compact/detail control pattern, with controls advertised by each adapter. Keep queue work behind a later requirement and use PrintForge's uncertainty/recovery model when it is needed. Package a simple local launcher after the browser workflow works. This is a concrete borrowing strategy, not a recommendation to create another backend wrapper or replace all printer adapters.

## Printroom — exact source recovered

The exact candidate is [77kmp9jr2f-jpg/printroom](https://github.com/77kmp9jr2f-jpg/printroom), not a similarly named commercial product. Its [README](https://github.com/77kmp9jr2f-jpg/printroom/blob/main/README.md) labels v0.2.0-beta.1, MIT, a self-hosted Moonraker/Klipper dashboard with optional Spoolman and cameras. It reports qualification on two rooted K2 Plus machines; physical controls remain unqualified. It is not a replacement for our PrusaLink, Centauri Carbon, Saturn and Photon adapters.

Borrow source-age indicators and bounded camera/poll scheduling: its [compatibility guide](https://github.com/77kmp9jr2f-jpg/printroom/blob/main/docs/compatibility.md) documents non-overlapping per-printer polls, eight concurrent polls and four visible cameras per page, suspension offscreen/in background tabs, explicit unsupported features and separation of simulated fleet-size checks from physical validation. The exact numeric limits should be tuned for our app rather than copied as universal defaults. Its private-IPv4/direct-HTTP and single-primary-extruder limitations would narrow our existing connection support if adopted wholesale.

Its Node-based implementation is less direct a backend donor than PF PrintFloor's Python. [`web/ui-core.js`](https://github.com/77kmp9jr2f-jpg/printroom/blob/main/web/ui-core.js) is a useful candidate for reviewing standalone presentation calculations and freshness helpers before writing equivalents. Preserve MIT attribution if importing exact helpers. Prefer the operational honesty and fresh-data UI patterns, without imposing Printroom's adapter limitations on this app.
