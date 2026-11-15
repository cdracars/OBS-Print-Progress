# Modern platform alternatives for the mixed printer fleet

Research checked 2026-11-14. Primary-source inspection only; no software installed, printer connections opened, or physical controls tested. Features below distinguish advertised support, source implementation and our design judgment.

## Recommendation

Keep the current printer connection layer and build the responsive dashboard in this repository. Home Assistant is a credible alternative covering every printer family through separate integrations; it should not be dismissed as Klipper-only. However, using it as our required host adds another application plus multiple integrations, while OBS and the digital twin still need this project. The Photon P1 also needs one connection owner, whether that owner is this app or Home Assistant. Treat Home Assistant as an optional future automation consumer of our hub rather than a second direct connection to the same P1. This recommendation is an engineering judgment based on the following evidence.

## Home Assistant: strongest existing mixed-fleet alternative

| Fleet member | Verified integration evidence | Practical consequence |
| --- | --- | --- |
| Four Klipper printers | [Moonraker Home Assistant integration](https://github.com/marcolivierarsenault/moonraker-home-assistant), MIT, publishes sensors and controls. Its [release history](https://github.com/marcolivierarsenault/moonraker-home-assistant/releases) has stable 1.13.4 and a 1.14.0b0 prerelease; the latter includes command-error reporting, missing-data fixes and connection reconfiguration. | Good precedent for resilient capability handling and human-readable command failures. |
| Prusa MINI | Built-in [PrusaLink integration](https://www.home-assistant.io/integrations/prusalink/) explicitly supports MINI/MINI+ with firmware 5.1.0 or newer and local polling. Its documentation describes monitoring; it does not establish full job-control parity. | Monitoring is a credible route; inspect actual control support before promising equivalent buttons. |
| Centauri Carbon and Saturn 4 Ultra | [Elegoo Home Assistant integration](https://github.com/danielcherubini/elegoo-homeassistant) explicitly lists Centauri Carbon and Saturn 4 Ultra, monitoring, thumbnails and printer controls. Its [README](https://raw.githubusercontent.com/danielcherubini/elegoo-homeassistant/main/README.md) describes SDCP WebSocket/MQTT families, connection-limit handling and model/firmware limitations. | Strong protocol and interaction reference. Support in another integration does not prove every command works on Cody's firmware. |
| Photon P1 resin | Specific [Photon P1 integration](https://github.com/modrzew/hass-anycubic-photon-p1), not a Kobra-only project. [README](https://raw.githubusercontent.com/modrzew/hass-anycubic-photon-p1/main/README.md): local HTTP/MQTT, no cloud account, MIT. Only one MQTT client can connect: Photon Workshop and the integration disconnect each other. | This substantially reduces protocol uncertainty but makes shared ownership essential. Do not run competing HA and dashboard clients. |

The P1 integration is early-stage: [manifest](https://raw.githubusercontent.com/modrzew/hass-anycubic-photon-p1/main/custom_components/anycubic_photon_p1/manifest.json) reports version 0.1.0, local-push behavior and FFmpeg/Paho MQTT/PyCryptodome dependencies. The [release page](https://github.com/modrzew/hass-anycubic-photon-p1/releases) has no published releases. This is a useful implementation reference, not evidence of mature, universal firmware compatibility.

Its [sensor implementation](https://raw.githubusercontent.com/modrzew/hass-anycubic-photon-p1/main/custom_components/anycubic_photon_p1/sensor.py) maps job state, progress, layers, remaining/elapsed minutes, filename, resin usage, resin temperature and release-film counters. These are useful resin-specific dashboard fields; keep unknown values explicit instead of substituting filament metrics.

### Important P1 source inconsistency

The detailed [protocol notes](https://raw.githubusercontent.com/modrzew/hass-anycubic-photon-p1/main/docs/protocol.md) document HTTP discovery/authentication, MQTT status/control and an HTTP-FLV camera that requires a capture command. Their handshake description orders the signing inputs as token-hash + nonce + timestamp. The actual [HTTP implementation](https://raw.githubusercontent.com/modrzew/hass-anycubic-photon-p1/main/custom_components/anycubic_photon_p1/api.py) orders them as token-hash + timestamp + nonce, matching this repository's existing probe. Do not change the local signer merely to match the prose. Resolve behavior with a controlled hardware capture later. Likewise, a camera preview may actively enable capture; monitoring should not silently promise to be command-free.

The Elegoo project's [release history](https://github.com/danielcherubini/elegoo-homeassistant/releases) provides a related caution: its v2.16.0-beta.2 notes distinguish a file-cleanup command that was implemented from one that actually succeeded on a CC2. Source presence is not sufficient validation of a physical printer command.

## Node-RED: modern replacement identified

Use [FlowFuse Dashboard](https://dashboard.flowfuse.com/), package `@flowfuse/node-red-dashboard`, if choosing Node-RED. The original `node-red-dashboard` was deprecated in June 2024. The replacement is Apache-2.0, works without a FlowFuse account in self-managed Node-RED, supports responsive breakpoints and installation on a phone. Its [release history](https://github.com/FlowFuse/node-red-dashboard/releases) shows v1.36.1 dated 2026-11-10.

Judgment: excellent for personal automation and rapid forms/charts; weaker as this project's mandatory foundation. We would still build printer-specific connections and command handling, then additionally maintain Node-RED flows and a separate runtime. Borrow configurable groups, clear controls and responsive layouts; expose hub events for optional Node-RED automation later.

## Farm dashboards

| Platform | Current primary-source findings | Decision |
| --- | --- | --- |
| [FDM Monster](https://docs.fdm-monster.net/docs/faq) | FAQ lists OctoPrint, Moonraker and PrusaLink as full support and Bambu as work in progress. It now uses built-in SQLite; MongoDB is no longer supported after v2.0. Linux, Docker, MonsterPi and Unraid are documented. No reviewed source establishes Centauri Carbon, Saturn or Photon P1 support. [Releases](https://github.com/fdm-monster/fdm-monster/releases) show stable 2.1.1 and 2.1.0, the latter adding scoped user-managed keys. | Best farm-grid/operations reference. Not a complete mixed-fleet replacement. Its AGPL licensing also means copying implementation needs separate license review. |
| [OctoFarm](https://github.com/OctoFarm/OctoFarm) | Explicitly aggregates OctoPrint instances; the README documents MongoDB configuration. The top [published release](https://github.com/OctoFarm/OctoFarm/releases) is v1.8.0-beta.11 dated 2022-12-28. This is observed release age, not proof that every form of development stopped. | Do not restart the earlier Windows/MongoDB adoption path for this fleet. Borrow fleet history and summary views only. AGPL-3.0. |
| [SimplyPrint](https://simplyprint.io/compatibility) | Its compatibility page explicitly says only FDM can connect: resin machines cannot connect or be sliced, though virtual-machine records can log their work. The platform advertises queues, cameras and fleet control; supported-printer labels distinguish verified from expected compatibility. | Useful reference for printer-capability labels and an approachable setup flow. Cannot unify live control of the Saturn and Photon P1. |

## What to borrow

1. **FDM Monster:** an all-printer grid with operational state and clear maintenance/attention filters.
2. **Home Assistant integrations:** a stable per-printer identity, explicit unknown/unavailable values, supported entities and useful state-change notifications. Use family-specific resin fields and deliberate command outcomes.
3. **Photon P1 integration:** reviewed protocol knowledge and field mappings, with attribution if MIT code is actually incorporated. Keep exactly one printer-session owner.
4. **FlowFuse Dashboard:** responsive grouped panels and controls that retain a consistent hierarchy on a phone.
5. **SimplyPrint:** explicit compatibility confidence and a guided path from discovery to a useful first screen.

Retain the existing OBS URLs and on-demand 3D twin. Do not use a web frame per printer as the main architecture: it would keep independent polling, streams and controls hidden inside several applications. A single shared hub can serve the overview, detail view, OBS and optional automation consumers consistently. No third-party code has been copied by this research.
