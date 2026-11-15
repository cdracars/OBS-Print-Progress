# Printer dashboard direction

Assessment: 2026-11-14. This initial proposal is superseded by the researched choice in [dashboard-decision.md](dashboard-decision.md). This is not an implemented dashboard.

## Intended use

Cody wants to watch and control prints in one place, primarily in a desktop browser with phone access. Retain OBS overlays as another way to view the same printers.

The configured fleet currently contains Hoss (SV08), Sam (SV06 Plus), pibeta and EightTrack on Klipper, plus Lucee (Centauri Carbon). Cody also identified a Prusa MINI, Saturn 4 Ultra and Anycubic P1, and confirmed the Anycubic is a resin printer. Treat it as the Photon P1, consistent with the existing probe. Do not assume the three additions are already configured.

## Recommended approach

Build a new dashboard in this repository, sharing the existing Python printer connections. Keep the OBS views as separate presentations. There is no need for a second process or a wrapper around the whole application to achieve that separation.

The reusable investment is the printer connection code, discovery, configuration, camera handling, thumbnails, G-code parser and WebGL renderer. The setup screen and the overlay's screen-specific code are not a suitable foundation for all dashboard interactions.

Use a consistent printer status and control interface for the new dashboard. Keep the Moonraker-compatible interface for the existing overlays. The dashboard should not need to pretend every printer is a Klipper printer.

## Existing code and gaps

| Area | Current implementation | Implication |
| --- | --- | --- |
| Local host | `server.py`, standard-library threaded HTTP server | Reuse initially; `/` currently redirects to setup. |
| Connections | `Hub` owns one running adapter per configured printer | Share these connections between dashboard and overlays. Some streams or file requests still create their own upstream work. |
| Shared status | `bridge/base.py` summary; normalized state in `bridge/facade.py` | Summary omits time estimates, target temperatures, chamber data and freshness. Extend deliberately. |
| Klipper | `bridge/moonraker.py` polls a small status set and proxies HTTP/WebSocket requests | Dashboard summary needs richer data even though direct overlay queries already obtain more. Existing proxy access is not a common control interface. |
| Other printer families | Bambu, Elegoo FDM/resin, PrusaLink adapters | Monitoring is implemented; shared pause/resume/cancel commands are not. Physical validation remains necessary. |
| Anycubic | Discovery plus `tools/anycubic_probe.py` | No registered adapter. LAN handshake/protocol investigation is groundwork, not working dashboard support. |
| Setup | `setup.html`, `setup.js`, `setup.css` | Reuse connection workflows, move emphasis toward settings. Currently polls printer list every three seconds. |
| Native controls | `dashboard-links.js` | Destinations are hard-coded to named printers and addresses. Move toward saved, validated per-printer destinations. |
| Status overlay | `print-progress.js` | Data fetching, calculations and DOM updates are coupled in one closure. Extract reusable behavior when dashboard needs it; avoid importing it wholesale. |
| Digital twin | `gcode-toolpath.js`, `toolpath-renderer.js`, `toolpath.js` | Parser and renderer already have reusable interfaces. Load the full twin on demand, rather than for every overview card. |

## First dashboard scope

1. Fleet overview: printer cards with connection/freshness, current job, progress, finish estimate, relevant temperatures, camera preview where available, and clear attention states. Filters for printing, idle and needs attention.
2. Printer detail: larger camera, current-job information and supported pause/resume/cancel controls. Expose temperature controls only where implemented and verified. Retain native dashboard links for advanced operations.
3. Settings: add/edit/test/discover printers and manage names, addresses, camera orientation and native dashboard links.
4. OBS: retain current URLs and put overlay links in a dedicated area of the dashboard.

For each printer, report capabilities explicitly: job controls, temperatures, browser-playable camera, layers and live toolpath. Distinguish unsupported features from temporary connection failures and unknown readings. Resin printers should not show fictitious nozzle or bed temperatures, or a G-code twin.

Commands need current-state checks, explicit acknowledgements/failures and per-printer implementations. Do not retry a command blindly after a timeout. Confirm cancel in the UI. Remote phone use on the same LAN and off-site access are separate deployment requirements; the current server defaults to localhost and `--lan` does not add user authentication.

Defer queue scheduling, file dispatch/start, inventory, history, multi-user access and batch commands until the daily control workflow is agreed. These require additional persistent state or protocol work; they are not implied by the existing status bridges.

## Suggested build order

1. Validate monitoring on the actual Prusa MINI and Saturn; establish Photon P1 connectivity and message format. Keep unknown printers visible with honest support states.
2. Define and test the shared status/capability/control interface against fake printers. Preserve the current OBS responses and routes.
3. Build the responsive fleet overview and printer detail screen, starting with available monitoring and adding verified controls per printer family.
4. Move setup and OBS-specific tasks into their own areas. Validate desktop and phone workflows and test representative physical printers before calling their controls supported.

Keep the initial deployment simple. A frontend framework or heavier Python host can be chosen when implementation needs justify it; neither is required to decide this architecture.

## Baseline verification

All six JavaScript test files passed. Python discovery ran 56 tests: 52 passed and four were skipped. The skipped tests are Bambu integration tests gated on an available OpenSSL executable. Some Python HTTP tests emitted resource warnings. These results validate the simulated baseline, not operation on physical printers; several overlay calculation tests restate calculations rather than executing the full browser application.

See [dashboard research](dashboard-research.md) for primary-source comparisons of Mainsail, Fluidd, FDM Monster, OctoPrint and Spoolman. No application code or printer configuration was changed during this assessment.
