# Printer dashboard references

Research date: 2026-11-14. These are primary-source feature checks, not hands-on evaluations. Recommendations below are design judgments. No third-party code or artwork has been imported.

Follow-up: [modern platform research](dashboard-modern-platforms.md) checks the recovered earlier alternatives, specific Photon P1 support and release evidence. The resulting choice is recorded in [dashboard decision](dashboard-decision.md); use those notes for the final direction and more precise FDM Monster support distinctions.

## Recommendation

Build a new dashboard experience in this repository, sharing its printer connections and data with the existing OBS views. Keep native printer dashboards available for advanced controls. Revisit adopting an existing farm manager if job dispatch, queues, maintenance scheduling, or several users become the main requirements.

The current project already documents a valuable mixed-printer foundation: Moonraker/Klipper and Snapmaker U1, Bambu LAN, Elegoo SDCP, and PrusaLink, with cameras, thumbnails and a live toolpath where supported. The README explicitly says the new connection paths have been tested with simulated printers rather than physical hardware. Preserve that distinction when planning validation. Sources: [local README](../README.md), [adapter implementation](../bridge/base.py).

## References and useful shapes

| Project | Verified scope | Shapes worth borrowing | Fit here |
| --- | --- | --- | --- |
| [Mainsail](https://github.com/mainsail-crew/mainsail) | Klipper web interface; multi-printer support, cameras, history, queue, G-code viewer, configurable dashboard. | A compact printer summary leading to detailed panels; rearrangeable/collapsible panels; separate mobile and desktop layouts. | Strong reference for the detailed printer page and a destination for advanced Klipper controls. Its broader interface assumes Klipper facilities that this project's emulated Moonraker subset does not necessarily implement. |
| [Fluidd](https://github.com/fluidd-core/fluidd) | Klipper interface with responsive UI, movable panels, themes, and multiple printers from one installation. | Consistent panel hierarchy and a useful phone layout; make layout customization optional. | Another good detailed-page reference; adopting its whole interface would carry the same Klipper-specific assumptions. |
| [FDM Monster](https://github.com/fdm-monster/fdm-monster) | Farm dashboard; current official site lists OctoPrint, Moonraker, Bambu and PrusaLink, live status/cameras, queues and group control. Repository README also describes a customizable printer grid and maintenance state. | Fleet overview grid, printer grouping, obvious maintenance/offline states, batch selection only when needed. | Closest existing alternative to building a multi-vendor dashboard. Worth a hands-on trial if production management matters. Elegoo SDCP support was not established by the reviewed sources. OBS overlays and this project's digital twin would still need separate integration. |
| [OctoPrint](https://github.com/OctoPrint/OctoPrint) | A printer-control web application with a plugin ecosystem; documented interfaces cover files, jobs, temperatures, controls, permissions and push updates. | Separate monitoring from controls; cohesive current-job panel; extensions for optional features. | Useful interaction and extensibility reference; it is not a replacement for the existing Bambu/Elegoo/Prusa connection code. Add an OctoPrint adapter only if an actual printer needs it. |
| [Spoolman](https://github.com/Donkie/Spoolman) | Self-hosted filament inventory with REST and WebSocket interfaces, material/vendor/spool records, usage updates, filtering and labels; integrates with Moonraker and OctoPrint. | Material cards with color, quantity and location; link a loaded spool to a printer. | A possible later integration rather than inventory storage we need to build immediately. It does not provide the overall printer dashboard. |

Feature sources: [Mainsail README](https://raw.githubusercontent.com/mainsail-crew/mainsail/develop/README.md), [Mainsail layout documentation](https://docs.mainsail.xyz/features/dashboard-organisation/), [Fluidd README](https://raw.githubusercontent.com/fluidd-core/fluidd/develop/README.md), [FDM Monster official site](https://docs.fdm-monster.net/), [FDM Monster README](https://raw.githubusercontent.com/fdm-monster/fdm-monster/develop/README.md), [OctoPrint README](https://raw.githubusercontent.com/OctoPrint/OctoPrint/master/README.md), [OctoPrint interface documentation](https://docs.octoprint.org/en/main/api/index.html), [Spoolman README](https://raw.githubusercontent.com/Donkie/Spoolman/master/README.md). The fetched FDM Monster README was older than its current official site; use the latter for the current advertised printer families, and verify release-specific capabilities before adoption.

## Architecture implications

These references suggest three levels: an all-printer overview, one printer's detailed workspace, and links to native advanced controls. Start with status, current job, camera, progress/finish estimate and attention states. Offer the 3D twin on demand instead of running one WebGL scene per fleet tile.

Use this project's existing connection layer, but give dashboard views a consistent printer summary plus explicit supported features. Missing temperatures, layers, browser cameras or commands should be represented as unavailable. A partial Moonraker facade must not be treated as full compatibility with Mainsail or Fluidd. This is an inference from the local adapter's limited routes and the substantially broader features documented by those projects: [adapter](../bridge/base.py), [Mainsail feature list](https://github.com/mainsail-crew/mainsail).

A first dashboard need not provide a queue, inventory database, configuration editor, firmware management or a plugin system. Decide those after identifying the actual daily workflow. Keep the OBS URLs working while dashboard screens evolve.

## Reuse and licenses

The local project is [MIT licensed](../LICENSE). The reviewed project licenses are [Mainsail: GPL-3.0](https://github.com/mainsail-crew/mainsail/blob/develop/LICENSE), [Fluidd: GPL-3.0](https://github.com/fluidd-core/fluidd/blob/develop/LICENSE), [FDM Monster: AGPL-3.0](https://github.com/fdm-monster/fdm-monster), [OctoPrint: AGPL-3.0](https://github.com/OctoPrint/OctoPrint), and [Spoolman: MIT](https://github.com/Donkie/Spoolman/blob/master/LICENSE). Treat these as design references first. Before importing implementation or assets, inspect the actual files and preserve their applicable license terms; integration through a separately running application's documented interface is a separate technical option from copying its code.
