# Dashboard implementation evidence

Updated 2026-11-14. Status: local implementation preview, not a physically qualified release. The product specification remains the acceptance baseline; this report does not reduce its requirements.

## First live monitoring check

The saved five-printer fleet was connected through a separate local host on port 8786. Hoss, Sam, pibeta, EightTrack and Lucee each returned live source observations. Hoss and Lucee showed changing progress/temperature readings; EightTrack transitioned from printing to complete during observation. These are device/API reports, not independent confirmation of physical identity or command execution. Sam later timed out; the dashboard retained its dated last-known printing state rather than declaring the job failed.

Hoss's camera stream and snapshot addresses advertised by Moonraker both returned HTTP 502 directly from the upstream web service. Camera failure feedback now persists through dashboard refreshes and offers an explicit retry, independently of live printer status. Browser inspection verified the error remained visible after refresh cycles. Camera availability is still not qualified.

The browser was left open on the live fleet. All dashboard controls remained disabled and no pause/resume/cancel or printer-settings commands were sent. The existing service on port 8001 was left running. The Prusa MINI, Saturn 4 Ultra and Photon P1 are not in the saved connection configuration and were not contacted.

## Delivered architecture

The existing Python host and adapters now serve Print Desk at the root. Plain browser JavaScript renders the fleet without a new build system or hosted service. SQLite owns equipment identities, metadata revisions, events and command outcomes; live observations remain adapter-owned. Existing setup, status overlays and toolpath views remain accessible. No production config was modified or live service restarted during development.

The simulation uses separate adapters and storage and opens no printer connections. UI verification used an empty private configuration on port 8765. No physical printers were commanded.

## Acceptance status

| Scenarios | Evidence delivered | Remaining qualification |
| --- | --- | --- |
| AC-01, AC-03, AC-04 | Stable/offline identities, cached observation aging, unknown readings and resin semantics have behavior tests. Eight simulated printers render together. | Mixed live fleet and real failure/recovery observations. |
| AC-02 | Desktop preview and 390px phone layout inspected; no horizontal overflow. Detail navigation and simulated pause checked in browser; no console errors observed. Compact preference persists locally. | 320px reflow, keyboard/screen-reader audit and required browser/OBS version matrix. |
| AC-05 | Two leases share one fake JPEG upstream; closing one preserves the other. Passive HTTP camera sources capped at four. | Physical camera formats, source-failure UI and concurrent OBS/dashboard load; resin transcoding helper is absent. |
| AC-06, AC-07, AC-08 | Tests block stale and replaced-job commands, prevent duplicate uncertain dispatch, preserve unknown outcomes and revoke controls after target changes. Family-specific Moonraker/Prusa requests and correlated SDCP ACKs tested. Browser pause displayed confirmed only after a new simulated observation. | Physical pause/resume/cancel on each intended model/firmware. Current-job-only protocols cannot eliminate the final observation-to-command race; supervised use only. Prusa pins the vendor job ID. |
| AC-09 | Existing setup/discovery retained. Name edits preserve aliases. Connection target fingerprint changes revoke controls while keeping CI identity. | Verified vendor-identity reconciliation at changed addresses and ambiguous-discovery review are not implemented. Enroll/change connections manually after review. |
| AC-10 | Stable equipment identity, owner/location/evidence/lifecycle, explicit typed relationships, revisions and durable metadata tested. | Intended configuration baselines beyond metadata/target fingerprint, relationship removal UI and complete provenance diffs. |
| AC-11 | Attention view and CI-linked command/configuration/state-change activity implemented. Camera errors do not assert a failed print. | Incident/problem workflow, persisted host-outage gaps and computed dependency impact are not implemented. Service overview includes illustrative concepts, separately from explicitly recorded relationships. |
| AC-12 | Existing overlay navigation, URL selection, thumbnail, toolpath and appearance-related regression tests retained. Generic writes/WebSockets blocked; supported clients use read polling. | Installed OBS rendering and sustained behavior against the real fleet. |
| AC-13 | HTTP tests require LAN sessions and block legacy writes/WebSockets and cross-origin requests. Inventory/card tests exclude credentials. Sessions use HttpOnly/SameSite cookies. | Host TLS deployment and per-user roles are outside this preview; trusted LAN only, one workshop access level. OBS contexts on remote devices must authenticate separately. |
| AC-14 | Experimental P1 handshake/MQTT implementation, explicit release/reconnect and no automatic reconnect contest after connection loss. Resin status normalization ignores unrelated ACKs and preserves documented units. | Full handshake/broker integration fixture and physical single-client contention/firmware tests. P1 video conversion is not delivered. |
| AC-15 | Metadata export/import preserves identities and typed relationships, rejects conflicts, resets control permissions and contains no credentials. | Whole-deployment recovery drill with separately protected configuration and SQLite backup. Automatic backups and retention/pruning are absent. |
| AC-16, AC-17 | Eight-printer simulation, per-adapter workers, non-overlapping browser polling, background/offscreen preview suspension and bounded shared camera sources. | Measured host-to-UI latency, fault injection, CPU/memory/bandwidth and two dashboards plus OBS endurance tests. |
| AC-18 | No dashboard vendor account or new Python package is required. | Verify each actual printer's LAN prerequisites and offline operation. |

## Verification commands

Latest run: 69 Python tests completed successfully (65 passed, four OpenSSL-dependent cases skipped); all six JavaScript test files passed. Controller/setup syntax checks and `git diff --check` passed. Browser verification used the local simulated fleet at desktop size and 390px width, including a confirmed simulated pause. The isolated preview server was stopped after verification.

`python -m unittest discover -s tests` runs the Python contracts and existing fake-printer regressions. Four existing Bambu TLS integration cases require an OpenSSL executable and are skipped on this host. Resource warnings in legacy HTTP/socket fixtures remain visible; they are not test failures.

`node --test tests/*.test.js` runs the six JavaScript test files, including fleet stale-state/search/unknown presentation and existing overlay behavior. `node --check dashboard.js` checks the controller syntax.

## Release gates

Keep controls disabled by default until the actual model, firmware, endpoint and supervised observations are recorded. An operator enable is permission for supervised use, not evidence that automated qualification passed. Bambu has monitoring/OBS support but no dashboard command implementation.

Before treating this preview as the specification's release, finish the pending acceptance evidence above, choose a protected backup destination and history retention, qualify browsers/OBS and perform a supervised hardware check. See [protocol source notes](protocol-implementation-notes.md) and [the operating model](operating-model.md).

## Camera startup follow-up

The operator observed that some cameras eventually loaded but took a long time to start. The earlier HTTP 502 observations establish a temporary upstream failure rather than permanent camera unavailability. Measure first-frame timing per camera, expose a loading state, and review the first-frame timeout before claiming camera readiness. No printer camera service was restarted during this check.
