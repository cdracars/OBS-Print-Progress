# Printer protocol implementation source notes

Checked 2026-11-14. Research only: no physical printer connection or command was made. Source implementations and specifications are not hardware qualification. Treat the local command lifecycle, job guards and capability rollout as project requirements distinct from upstream behavior.

## Pinned sources

| Source | Reviewed commit |
| --- | --- |
| [modrzew/hass-anycubic-photon-p1](https://github.com/modrzew/hass-anycubic-photon-p1/tree/f33ceb5bc47388412a7a378ed58649736a5a6834) | `f33ceb5bc47388412a7a378ed58649736a5a6834` |
| [Official SDCP v3](https://github.com/cbd-tech/SDCP-Smart-Device-Control-Protocol-V3.0.0/tree/f977215761ee2e8c6d02ab06a68dc4d2b710a255) | `f977215761ee2e8c6d02ab06a68dc4d2b710a255` |
| [Prusa-Link-Web OpenAPI](https://github.com/prusa3d/Prusa-Link-Web/blob/a67f306bc878009be0e27864a01a1837e5c4cf06/spec/openapi.yaml) | `a67f306bc878009be0e27864a01a1837e5c4cf06` |

## Photon P1 source inventory

The retrieved repository tree contains `api.py`, `const.py`, `coordinator.py`, `sensor.py`, `button.py`, `camera.py`, `light.py`, `switch.py`, `config_flow.py`, entity/setup files, translations, manifest and protocol notes under `custom_components/anycubic_photon_p1/` and `docs/`. There is no `mqtt.py`: MQTT behavior lives in `coordinator.py`.

### HTTP handshake and decryption

Pinned [`api.py`](https://github.com/modrzew/hass-anycubic-photon-p1/blob/f33ceb5bc47388412a7a378ed58649736a5a6834/custom_components/anycubic_photon_p1/api.py):

1. `GET http://host:18910/info`; require HTTP 200 and JSON `code == 0`. Read `token`, `modelId`, `cn` and identity fields.
2. Generate decimal millisecond timestamp `ts`, 15-character UUID-hex nonce and nonempty client identifier `did`.
3. Implementation computes `h = md5(token[:16].encode()).hexdigest()`, then `sign = md5((h + ts + nonce).encode()).hexdigest()`.
4. `POST /ctrl?ts=...&nonce=...&did=...&sign=...`; require HTTP 200 and JSON `code == 200`.
5. Restore missing Base64 `=` padding on `data.info`; decrypt AES-128-CBC with key `token[16:32]` bytes and IV `data.token` bytes.
6. Decrypted content contains JSON followed by null/padding bytes; upstream strips nulls and scans for the closing JSON brace, rather than performing strict PKCS#7 unpadding. Result fields include `username`, `password`, `clientId`, `deviceId`, optional `broker`, `mac`.

The upstream prose orders nonce/timestamp differently from its code. Keep this discrepancy explicit; our existing probe matches the code. Do not alter the signature based on prose alone. Improvement proposed locally: strict bounds and a real JSON decoder's consumed-prefix operation instead of upstream's brace counter, which is not string-aware. Do not log ephemeral tokens or decrypted credentials.

### MQTT topics and message lifecycle

Pinned [`const.py`](https://github.com/modrzew/hass-anycubic-photon-p1/blob/f33ceb5bc47388412a7a378ed58649736a5a6834/custom_components/anycubic_photon_p1/const.py) defines:

- Subscribe: `anycubic/anycubicCloud/v1/printer/+/{model_id}/{device_id}/+/report`.
- Publish: `anycubic/anycubicCloud/v1/pc/printer/{model_id}/{device_id}/{subtopic}`.
- Use the `/info` model identifier and decrypted credential device identifier, not a guessed name/MAC.
- Query `status` and `print`; the `lanInfo` query uses the **status topic** with JSON `type: lanInfo`. Topic suffix and JSON type are distinct.

Pinned [`coordinator.py`](https://github.com/modrzew/hass-anycubic-photon-p1/blob/f33ceb5bc47388412a7a378ed58649736a5a6834/custom_components/anycubic_photon_p1/coordinator.py) connects to TLS MQTT port 8883 with the exact credential `clientId`, username and password. It waits for successful subscription acknowledgment before querying. Outgoing JSON always contains `type`, `action`, UUID `msgid`, millisecond `timestamp`, and `data` (including explicit null).

Incoming data is merged by payload `type`, falling back to topic segment 7. Dictionary `data` updates are merged; null/list payloads do not erase print progress. State is top-level and context-dependent. Upstream maps `free` to `idle`; it recognizes `busy`, `printing`, `paused`, `stopping`, `complete`, `monitoring`, `error`. Do not let unrelated message states overwrite job state locally without checking message type. The upstream reconnects after 30 seconds with exponential delay capped at 300 seconds and repeats the HTTP handshake.

### Status field mapping and job identity

Pinned [protocol schema](https://github.com/modrzew/hass-anycubic-photon-p1/blob/f33ceb5bc47388412a7a378ed58649736a5a6834/docs/protocol.md), “Print Job Data” / “Properties Data”, and [sensor mappings](https://github.com/modrzew/hass-anycubic-photon-p1/blob/f33ceb5bc47388412a7a378ed58649736a5a6834/custom_components/anycubic_photon_p1/sensor.py):

| Raw field | Meaning / normalization |
| --- | --- |
| `print.data.progress` | Percent 0–100; divide by 100 for our existing normalized fraction. |
| `curr_layer`, `total_layers` | Layer values as reported; the sample starts at current layer 0. Do not silently assume one-based indexing. |
| `remain_time`, `print_time` | Minutes; multiply by 60 for normalized seconds. |
| `filename`, `taskid` | Reported job attributes. Sample `taskid` is the string `"0"`; uniqueness is not established. |
| `supplies_usage` | Resin mL, not filament grams. |
| `model_hight`, `z_thick` | Model height and layer thickness in mm; spelling reflects firmware. |
| `properties.data.resin_temp` | Resin temperature; no fictitious nozzle/bed readings. |

The source does not establish a robust remote run identifier. Treat `taskid: "0"`/missing IDs as insufficient by themselves to guard a command against a new run of the same filename. A local run/session identity may help, but it cannot manufacture atomic remote targeting the protocol lacks.

### Controls, outcomes and session handoff

Pinned [`button.py`](https://github.com/modrzew/hass-anycubic-photon-p1/blob/f33ceb5bc47388412a7a378ed58649736a5a6834/custom_components/anycubic_photon_p1/button.py) sends `print` actions `pause`, `resume`, `stop`. Each has `data: null`; no job identifier appears in these command payloads. The coordinator publishes without waiting for a correlated printer response or state transition. That code is not an adequate success contract for this dashboard.

Local consequence: a successful socket/MQTT write proves only sending. A timeout/disconnect leaves an uncertain outcome; never replay the physical action blindly. Fresh relevant job/state evidence is needed for observed completion, and firmware-specific acknowledgment correlation needs validation rather than an invented guarantee.

The pinned [protocol notes](https://github.com/modrzew/hass-anycubic-photon-p1/blob/f33ceb5bc47388412a7a378ed58649736a5a6834/docs/protocol.md) explain that the broker accepts the returned fixed client identifier; another client with it disconnects the current client. Changing `did` does not solve this. A dashboard and Photon Workshop must coordinate ownership or use one shared upstream multiplexer. A deliberate yield mode should stop reconnect attempts, not fight the slicer. Connection/handoff permission is separate from job-command permission.

Upstream automatically sends `video/startCapture` after subscribing. **Do not copy that side effect into ordinary monitoring.** FLV camera activation and stop should be separate explicit behavior.

## SDCP v3 job controls

The [official pinned English spec](https://github.com/cbd-tech/SDCP-Smart-Device-Control-Protocol-V3.0.0/blob/f977215761ee2e8c6d02ab06a68dc4d2b710a255/SDCP%28Smart%20Device%20Control%20Protocol%29_V3.0.0_EN.md) confirms:

- Pause `Cmd:129`; stop `130`; continue/resume `131`.
- Request outer fields: `Id`, `Data`, `Topic: sdcp/request/{MainboardID}`. Inner `Data`: `Cmd`, `Data:{}`, unique `RequestID`, actual `MainboardID`, `TimeStamp`, `From`.
- Timestamp examples use epoch **seconds**, unlike P1's milliseconds. Preserve the printer-family envelope instead of sharing an undifferentiated builder.
- Response topic `sdcp/response/{MainboardID}` carries matching `Cmd`, `RequestID`, board identity and inner `Data.Ack:0` for the shown success response. Correlate all relevant identifiers; do not mistake unsolicited status for acknowledgment.
- These commands carry no job identity. A board/task/state guard before sending reduces races but cannot make the wire command atomically target a particular job.

This specification does not independently qualify original Centauri Carbon and Saturn firmware behavior. Keep acknowledgment, sent state and observed physical/job transition distinct.

## PrusaLink v1 actions

The [pinned OpenAPI](https://github.com/prusa3d/Prusa-Link-Web/blob/a67f306bc878009be0e27864a01a1837e5c4cf06/spec/openapi.yaml) specifies `GET /api/v1/job`: 200 with current job, or 204 without content. Job `id` is an integer. Use the actual latest printer-reported ID:

| Action | Method/path |
| --- | --- |
| Pause | `PUT /api/v1/job/{id}/pause` |
| Resume | `PUT /api/v1/job/{id}/resume` |
| Cancel/stop | `DELETE /api/v1/job/{id}` |

Successful actions return 204, **not JSON**. Listed failure responses include 401, 404 and 409. Preserve authentication support already in the adapter. Do not substitute filename or a local ID in the path, do not retry using a newer ID after conflict, and re-observe to distinguish accepted action from completed transition. The job schema uses progress percent and seconds for elapsed/remaining time.

## Attribution if code is incorporated

P1 source is MIT: pinned [LICENSE.md](https://github.com/modrzew/hass-anycubic-photon-p1/blob/f33ceb5bc47388412a7a378ed58649736a5a6834/LICENSE.md), copyright **2026 Tomek Modrzyński**. Any copied/substantially adapted implementation must retain that actual notice and the full license permission/warranty text; fetch that pinned file verbatim into the chosen third-party-notice location rather than reconstructing it from memory. Protocol facts can guide an independent implementation, but record source and revision regardless. No upstream code or license file was vendored by this research-only task.
