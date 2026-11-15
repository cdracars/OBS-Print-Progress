# Recovered earlier dashboard ideas

Recovered 2026-11-14 from the user's local Claude conversation export and 3DBrain notes. This records earlier suggestions, not a fresh validation of product capabilities, maintenance, pricing or printer compatibility. Some old responses contain speculative implementation examples and inaccurate product claims; do not implement those examples without verification.

## Earlier product comparisons

Conversation: **Dashboard for Managing Multiple OctoPrint Instances**. Created March 14, 2025; export ID `6e6d63a7-73a9-447d-b007-eaf9bc568913`.

The discussion initially suggested OctoFarm, PrintoidServer and a custom Node-RED dashboard. Cody tried OctoFarm on Windows, worked through Docker/MongoDB issues, reached the printer-add screen, then asked: "is there a newer setup than octofarm".

The subsequent alternatives were:

- **Obico**: remote monitoring, failure detection and a multi-printer view.
- **Mainsail / Fluidd with Moonraker**: Klipper control and monitoring.
- **OctoEverywhere**: remote access, notifications and monitoring.
- **RepetierServer**: centralized multi-printer control.

The original recommendation was RepetierServer or OctoEverywhere for the then-current firmware setup, Klipper/Mainsail/Fluidd if changing firmware, and Obico for failure detection. That recommendation concerned a much smaller MK3S+/SV06 Plus fleet; it does not establish suitability for today's mixed resin/filament fleet.

Conversation: **Setting Up Home Assistant with Multiple Klipper Printers**. Created March 2025; export ID `3b324c85-0de1-4b5b-9ea1-36d4621cf8ac`.

- **Home Assistant** with Moonraker integrations: a unified dashboard, camera/status/control cards and completion notifications.
- **Node-RED**: custom dashboard and automation flows.
- **Grafana**: metrics and monitoring across machines.
- Mainsail/Fluidd and OctoFarm also appeared.

## Earlier ideas specifically for this OBS project

Conversation: **Project deep dive and future possibilities**. Created December 6, 2025; export ID `4b1d8a8b-f33c-47e8-b0ef-01b5b76bd756`.

Ideas discussed:

- One grid showing multiple printers, including a combined OBS source.
- Print history and analytics: durations, completion rates and average time for repeated jobs.
- Temperature graphs, filament usage and camera-based failure detection.
- A theme editor in the UI, with presets, live preview and export.
- Printer setup in the UI.
- A packaged executable for ordinary users, separate from contributor setup, distributed from the same repository through releases.
- Shared normalized printer adapters; smaller modules for metadata, cameras and themes.
- Optional extension/plugin support and optional configuration/theme sync.

The conversation explored TypeScript/Vite/Vitest, Bun, embedded Python and Tauri, revising its advice as Cody clarified download size and ease of setup. These were alternatives, not a settled requirement to rewrite the current Python application.

## Saved infrastructure and fleet ideas

3DBrain's `knowledge/reference/minipc-service-node-plan.md` describes a shared mini PC for cameras, Spoolman and optional dashboard/queue/notification functions, while printer control remains independent on each printer's host.

3DBrain's `knowledge/reference/brain-automation.md`, section "Fleet board", documents an existing generated HTML fleet board: machine cards, open issues, maintenance history, knowledge gaps and documentation hygiene. Its input is saved notes, not live printer telemetry. This could inform a maintenance/history area in the future live dashboard.

## Source locations

- Claude export: `C:/Users/cdrac/Downloads/claude-export-2026-11-14/conversations-000/conversations.json`. Find the exact names or export IDs above. Do not copy the entire export into this repository; it contains unrelated private conversations and credentials.
- Infrastructure: `C:/Users/cdrac/code/3DBrain/knowledge/reference/minipc-service-node-plan.md`.
- Existing fleet board: `C:/Users/cdrac/code/3DBrain/knowledge/reference/brain-automation.md` and `tools/fleet_dashboard.py` in 3DBrain.

Today's initial comparison omitted several of these earlier candidates. Revisit Home Assistant, Node-RED, Obico, OctoEverywhere, RepetierServer and OctoFarm explicitly before treating today's proposed custom dashboard as the final decision. Confirm present support for Prusa MINI, Centauri Carbon, Saturn 4 Ultra and Photon P1 separately.
