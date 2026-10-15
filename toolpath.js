/**
 * Live Toolpath overlay - a real-time 3D "digital twin" of the current print.
 *
 * Streams the printing G-code file from Moonraker, rebuilds its toolpath in
 * WebGL, and grows it in sync with the printer:
 *   - Moonraker websocket subscription (falls back to HTTP polling)
 *   - virtual_sdcard.file_position -> printed segment (binary search)
 *   - motion_report.live_position refines that to the nozzle's actual
 *     segment, compensating for Klipper's lookahead
 *   - display progress is smoothed between updates so the bead "draws"
 *     continuously instead of jumping every poll
 *
 * URL options (all optional):
 *   ?printer=<id>         printer from printers.json (same as printer.html)
 *   ?ip= &name=           override / no printers.json needed
 *   ?demo=1               simulated print, no printer required
 *   ?color=height|feature|speed
 *   ?spin=8  ?pitch=26  ?zoom=1   camera (deg/s, degrees, factor)
 *   ?trail=300            length of the glowing "hot" trail, in segments
 *   ?width=0.45           bead width (mm)
 *   ?ghost=0              hide the holographic unprinted remainder
 *   ?hud=0                canvas only
 *   ?glow=0               disable the CSS glow
 *   ?fps=60               frame cap
 *   ?demoDuration=150     seconds for one simulated print
 */

(async function () {
    'use strict';

    const {
        ToolpathParser, FEATURES, SEG_FLOATS, SEG_ATTRS,
        segmentIndexAtOffset, refineIndexByPosition, layerIndexAt
    } = window.GcodeToolpath;

    const query = new URLSearchParams(location.search);
    const flag = (name, fallback) => {
        const v = query.get(name);
        if (v === null) return fallback;
        return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
    };
    const num = (name, fallback) => {
        const v = Number(query.get(name));
        return query.get(name) !== null && Number.isFinite(v) ? v : fallback;
    };

    const opts = {
        demo: flag('demo', false),
        color: ['height', 'feature', 'speed'].includes(query.get('color')) ? query.get('color') : 'height',
        spin: num('spin', 8),
        pitch: num('pitch', 26),
        zoom: num('zoom', 1),
        trail: num('trail', 300),
        width: num('width', 0.45),
        ghost: flag('ghost', true),
        hud: flag('hud', true),
        glow: flag('glow', true),
        fps: num('fps', 60),
        demoDuration: num('demoDuration', 150),
        debug: flag('debug', false)
    };

    // In a regular browser tab give the page a backdrop; in OBS stay transparent.
    if (!window.obsstudio && !flag('transparent', false)) document.body.classList.add('standalone');
    if (!opts.hud) document.body.classList.add('no-hud');
    if (!opts.glow) document.body.classList.add('no-glow');

    // ============================================================
    // HUD
    // ============================================================

    const $ = id => document.getElementById(id);
    const hud = {
        name: $('tpName'), status: $('tpStatus'), layer: $('tpLayer'), z: $('tpZ'),
        pct: $('tpPercent'), feature: $('tpFeature'), swatch: $('tpSwatch'),
        loading: $('tpLoading'), loadingText: $('tpLoadingText'), loadingBar: $('tpLoadingBar'),
        message: $('tpMessage'), legend: $('tpLegend'), bar: $('tpProgressFill')
    };

    function setStatus(text, kind) {
        hud.status.textContent = text;
        hud.status.className = `tp-pill ${kind || 'idle'}`;
    }

    function setMessage(text) {
        hud.message.textContent = text || '';
        hud.message.classList.toggle('hidden', !text);
    }

    function setLoading(fraction, bytes) {
        if (fraction === null) { hud.loading.classList.add('hidden'); return; }
        hud.loading.classList.remove('hidden');
        const mb = (bytes / 1048576).toFixed(1);
        hud.loadingText.textContent = fraction > 0
            ? `Building digital twin · ${Math.round(fraction * 100)}% · ${mb} MB`
            : `Building digital twin · ${mb} MB`;
        hud.loadingBar.style.width = `${Math.round(Math.min(1, fraction) * 100)}%`;
    }

    function cssColor(name, fallback) {
        const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
        return parseColor(v) || parseColor(fallback);
    }

    function parseColor(v) {
        if (!v) return null;
        if (v.startsWith('#')) return ToolpathRenderer.hexToRgb(v);
        const m = v.match(/rgba?\(([^)]+)\)/);
        if (!m) return null;
        const p = m[1].split(',').map(s => parseFloat(s));
        return [p[0] / 255, p[1] / 255, p[2] / 255];
    }

    function readTheme() {
        const primary = cssColor('--theme-primary', '#3A86FF');
        const secondary = cssColor('--theme-secondary', '#1E5ED9');
        const hot = cssColor('--toolpath-hot', '#ffb35c');
        const mixWhite = (c, t) => c.map(v => v + (1 - v) * t);
        return {
            low: mixWhite(secondary, 0.12),
            high: mixWhite(primary, 0.6),
            ghost: primary,
            grid: primary,
            hot
        };
    }

    function renderLegend(model) {
        hud.legend.innerHTML = '';
        if (!model) return;
        if (opts.color === 'feature') {
            FEATURES.forEach((f, i) => {
                if (!model.featureCounts[i] || i === 0) return;
                const row = document.createElement('div');
                row.className = 'tp-legend-row';
                row.innerHTML = `<span class="tp-swatch" style="background:${f.color}"></span>${f.label}`;
                hud.legend.appendChild(row);
            });
        } else if (opts.color === 'speed') {
            const max = Math.max(20, model.speedPercentile(0.999));
            hud.legend.innerHTML = `<div class="tp-ramp"></div><div class="tp-ramp-labels"><span>0</span><span>${Math.round(max)} mm/s</span></div>`;
        }
    }

    // ============================================================
    // RENDERER
    // ============================================================

    let renderer;
    try {
        renderer = new ToolpathRenderer($('tpCanvas'), {
            mode: opts.color, width: opts.width, trail: opts.trail, ghost: opts.ghost,
            spin: opts.spin, pitch: opts.pitch, zoom: opts.zoom
        });
    } catch (err) {
        setStatus('WebGL2 unavailable', 'error');
        setMessage('This overlay needs WebGL2. In OBS, enable "Use hardware acceleration" (Settings → Advanced → Sources).');
        console.error(err);
        return;
    }
    renderer.setTheme(readTheme());

    // Same optional theme override as printer.html
    (function loadCustomTheme() {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = 'theme-custom.css';
        link.onload = () => renderer.setTheme(readTheme());
        link.onerror = () => link.remove();
        document.head.appendChild(link);
    })();

    // ============================================================
    // PRINT STATE -> PROGRESS
    // ============================================================

    const live = {
        model: null,
        filename: null,
        state: 'standby',
        target: 0,          // segment progress we are heading to
        display: 0,         // smoothed segment progress drawn
        nozzle: null,       // smoothed nozzle position
        nozzleTarget: null,
        zBias: 0,           // live Z minus G-code Z (z-offset, mesh)
        rate: 0,            // estimated segments per second
        approx: 0,          // segments Klipper has read (upper bound)
        onPath: false,      // nozzle currently on an extrusion segment
        updatedAt: 0,
        layerNum: 0,        // layer-based sync (printers without file_position)
        layerSince: 0,
        layerRate: 0,
        percent: 0,
        replayStart: 0
    };

    function onStatus(status) {
        const ps = status.print_stats || {};
        const vsd = status.virtual_sdcard || {};
        const mr = status.motion_report || {};
        const th = status.toolhead || {};

        if (th.axis_minimum && th.axis_maximum) {
            renderer.setBed(th.axis_minimum[0], th.axis_minimum[1], th.axis_maximum[0], th.axis_maximum[1]);
        }

        const state = ps.state || 'standby';
        if (state !== live.state) {
            if (state === 'complete') live.replayStart = performance.now();
            live.state = state;
        }

        const labels = { printing: 'Printing', paused: 'Paused', complete: 'Complete', cancelled: 'Cancelled', error: 'Error', standby: 'Standby' };
        const kinds = { printing: 'ok', paused: 'warn', complete: 'ok', cancelled: 'error', error: 'error' };
        setStatus(labels[state] || state, kinds[state] || 'idle');

        const filename = ps.filename || '';
        if (filename && filename !== live.filename) {
            live.filename = filename;
            loadModel(filename, vsd.file_size);
        }

        live.percent = typeof vsd.progress === 'number' ? vsd.progress : live.percent;

        const pos = mr.live_position || th.position;
        if (pos) live.nozzleTarget = [pos[0], pos[1], pos[2]];

        const model = live.model;
        if (!model || !model.count) return;

        if ((state === 'printing' || state === 'paused') && typeof vsd.file_position !== 'number') {
            syncByLayer(model, ps, state);
        } else if (state === 'printing' || state === 'paused') {
            const approx = segmentIndexAtOffset(model.offsets, model.count, vsd.file_position || 0);
            let target = null;
            if (pos) {
                target = refineIndexByPosition(model.positions, model.count, approx, pos[0], pos[1], pos[2] - live.zBias);
                if (target !== null) {
                    // Track printing speed in segments/s so the frame loop
                    // can extrapolate smoothly between updates.
                    const now = performance.now();
                    const dtU = (now - live.updatedAt) / 1000;
                    if (live.onPath && state === 'printing' && dtU > 0.05 && dtU < 2 && target >= live.target) {
                        live.rate += ((target - live.target) / dtU - live.rate) * 0.35;
                    }
                    const i = Math.floor(target) * SEG_FLOATS;
                    const segZ = model.positions[i + 5];
                    live.zBias += ((pos[2] - segZ) - live.zBias) * 0.2;
                }
            }
            live.onPath = target !== null && state === 'printing';
            if (!live.onPath) {
                live.rate = 0;
                // Travelling: hold position unless the file moved far ahead
                // (just started, resumed, or a missed update).
                target = (approx - live.target > 3000 || approx < live.target - 5) ? approx : live.target;
            }
            live.target = Math.min(target, approx);
            live.approx = approx;
            live.updatedAt = performance.now();
        } else if (state === 'cancelled' || state === 'error') {
            // freeze where it stopped
        } else if (state !== 'complete') {
            live.target = live.display;
        }
    }

    /**
     * Printers that only report the current layer (Bambu Lab, Elegoo via
     * server.py): jump to the start of that layer, then advance through it at
     * the speed measured on the previous layer (or the print's average).
     */
    function syncByLayer(model, ps, state) {
        const info = ps.info || {};
        const layers = model.layers;
        let layer = Number(info.current_layer) || 0;
        const reported = Number(info.total_layer) || 0;
        if (!layers.length || layer <= 0) {
            live.onPath = false;
            live.rate = 0;
            return;
        }
        // The printer's layer count can differ slightly from the file's markers.
        if (reported && reported !== layers.length) layer = Math.round(layer * layers.length / reported);
        layer = Math.min(Math.max(layer, 1), layers.length);

        const now = performance.now();
        const start = layers[layer - 1].start;
        const end = layer < layers.length ? layers[layer].start : model.count;
        if (layer !== live.layerNum) {
            if (live.layerNum && layer === live.layerNum + 1 && live.layerSince) {
                const secs = (now - live.layerSince) / 1000;
                if (secs > 1) live.layerRate = (start - layers[layer - 2].start) / secs;
            }
            live.layerNum = layer;
            live.layerSince = now;
        }
        const duration = Number(ps.print_duration) || 0;
        const rate = live.layerRate || (duration > 0 ? start / duration : 0) || (end - start) / 30;
        const inLayer = (now - live.layerSince) / 1000;
        const estimate = state === 'printing' ? start + rate * inLayer : live.display; // hold while paused

        live.target = Math.max(start, Math.min(end - 1, estimate));
        live.rate = state === 'printing' ? rate : 0;
        live.approx = end - 1;
        live.onPath = state === 'printing';
        live.updatedAt = now;
    }

    // ============================================================
    // MODEL LOADING
    // ============================================================

    let loadToken = 0;

    function encodePath(p) {
        return p.split('/').map(encodeURIComponent).join('/');
    }

    async function loadModel(filename, sizeHint) {
        const token = ++loadToken;
        const expected = sizeHint ? Math.round(sizeHint / 30) : 0;
        const model = new ToolpathParser({ expectedSegments: expected });
        live.filename = filename;
        live.model = model;
        live.target = live.display = 0;
        live.layerNum = live.layerRate = 0;
        renderer.setModel(model);
        renderer.invalidateSpeedRange();
        renderLegend(null);
        setMessage('');
        setLoading(0, 0);

        try {
            const source = opts.demo ? demoSource.stream() : await fetchStream(filename);
            const total = source.total || sizeHint || 0;
            for await (const chunk of source.chunks) {
                if (token !== loadToken) return;
                model.push(chunk);
                setLoading(total ? model.bytesParsed / total : 0, model.bytesParsed);
            }
            model.finish();
            if (token !== loadToken) return;
            renderer.invalidateSpeedRange();
            renderLegend(model);
            setLoading(null);
            if (opts.debug) console.log('[Toolpath] loaded', filename, { segments: model.count, layers: model.layers.length, bounds: model.getBounds() });
        } catch (err) {
            if (token !== loadToken) return;
            console.error('[Toolpath] load failed', err);
            setLoading(null);
            setMessage(`Could not download ${filename} from Moonraker (${err.message}). Check CORS settings — see README.`);
        }
    }

    async function fetchStream(filename) {
        const url = `http://${printer.ip}/server/files/gcodes/${encodePath(filename)}`;
        const resp = await fetch(url, { cache: 'no-store' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const total = Number(resp.headers.get('content-length')) || 0;
        const reader = resp.body.getReader();
        return {
            total,
            chunks: (async function* () {
                try {
                    for (;;) {
                        const { done, value } = await reader.read();
                        if (done) return;
                        yield value;
                    }
                } finally {
                    reader.cancel().catch(() => {});
                }
            })()
        };
    }

    // ============================================================
    // MOONRAKER FEED
    // ============================================================

    const SUBSCRIBE = {
        print_stats: ['filename', 'state', 'print_duration', 'info'],
        virtual_sdcard: ['file_position', 'progress', 'file_size', 'is_active'],
        motion_report: ['live_position', 'live_velocity'],
        toolhead: ['position', 'axis_minimum', 'axis_maximum']
    };

    function mergeStatus(target, delta) {
        for (const [obj, fields] of Object.entries(delta || {})) {
            target[obj] = Object.assign(target[obj] || {}, fields);
        }
        return target;
    }

    function startMoonraker(host) {
        const status = {};
        let opened = false;
        let failures = 0;
        let pollTimer = null;

        const poll = async () => {
            try {
                const q = Object.keys(SUBSCRIBE).join('&');
                const resp = await fetch(`http://${host}/printer/objects/query?${q}`, { cache: 'no-store' });
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const json = await resp.json();
                mergeStatus(status, json.result.status);
                onStatus(status);
            } catch {
                setStatus(`Unreachable: ${host}`, 'error');
            }
        };

        const startPolling = () => {
            if (pollTimer) return;
            if (opts.debug) console.log('[Toolpath] websocket unavailable, polling over HTTP');
            poll();
            pollTimer = setInterval(poll, Math.max(250, Number(printer.updateInterval) || 500));
        };

        const connect = () => {
            let ws;
            try { ws = new WebSocket(`ws://${host}/websocket`); } catch { startPolling(); return; }
            const subscribe = () => ws.send(JSON.stringify({
                jsonrpc: '2.0', method: 'printer.objects.subscribe', params: { objects: SUBSCRIBE }, id: 1
            }));
            ws.onopen = () => { opened = true; failures = 0; subscribe(); };
            ws.onmessage = ev => {
                let msg;
                try { msg = JSON.parse(ev.data); } catch { return; }
                if (msg.id === 1 && msg.result) { mergeStatus(status, msg.result.status); onStatus(status); }
                else if (msg.method === 'notify_status_update') { mergeStatus(status, msg.params[0]); onStatus(status); }
                else if (msg.method === 'notify_klippy_ready') subscribe();
                else if (msg.method === 'notify_klippy_disconnected' || msg.method === 'notify_klippy_shutdown') setStatus('Klipper offline', 'error');
            };
            ws.onclose = () => {
                failures++;
                if (!opened && failures >= 2) { startPolling(); return; }
                setStatus('Reconnecting…', 'warn');
                setTimeout(connect, Math.min(15000, 1000 * Math.pow(2, failures - 1)));
            };
        };

        setStatus('Connecting…', 'idle');
        if (printer.websocket === false) startPolling();
        else connect();
    }

    // ============================================================
    // DEMO SOURCE (simulated printer)
    // ============================================================

    const demoSource = {
        bytes: null,
        stream() {
            if (!this.bytes) this.bytes = new TextEncoder().encode(ToolpathDemo.generateDemoGcode());
            const bytes = this.bytes;
            return {
                total: bytes.length,
                chunks: (async function* () {
                    const size = 96 * 1024;
                    for (let i = 0; i < bytes.length; i += size) {
                        yield bytes.subarray(i, i + size);
                        await new Promise(r => setTimeout(r, 30)); // visible "materialize"
                    }
                })()
            };
        },
        start() {
            setStatus('Demo', 'ok');
            const filename = 'demo/twisted-star-tower.gcode';
            const sim = { times: null, t0: 0, phase: 'loading' };

            const prepare = () => {
                const m = live.model;
                if (!m || m.count === 0 || m._carry) return false;
                // Simulated time per segment from length / feedrate.
                const times = new Float64Array(m.count + 1);
                for (let i = 0; i < m.count; i++) {
                    const p = i * SEG_FLOATS;
                    const len = Math.hypot(m.positions[p + 3] - m.positions[p], m.positions[p + 4] - m.positions[p + 1], m.positions[p + 5] - m.positions[p + 2]);
                    const speed = Math.max(5, m.attrs[i * SEG_ATTRS + 1] * 2);
                    times[i + 1] = times[i] + len / speed;
                }
                sim.times = times;
                return true;
            };

            const tick = () => {
                const now = performance.now();
                const m = live.model;
                const status = {
                    print_stats: { filename, state: 'printing', print_duration: 0 },
                    virtual_sdcard: { file_position: 0, progress: 0, file_size: demoSource.bytes ? demoSource.bytes.length : 0 },
                    motion_report: {},
                    toolhead: { axis_minimum: [0, 0, 0], axis_maximum: [220, 220, 250] }
                };

                if (sim.phase === 'loading') {
                    if (loadToken > 0 && setLoadingDone() && prepare()) { sim.phase = 'printing'; sim.t0 = now; }
                } else if (sim.phase === 'printing') {
                    const total = sim.times[m.count];
                    const simT = ((now - sim.t0) / 1000) * (total / opts.demoDuration);
                    if (simT >= total) {
                        sim.phase = 'complete'; sim.t0 = now;
                    } else {
                        let lo = 0, hi = m.count;
                        while (lo < hi) { const mid = (lo + hi) >>> 1; if (sim.times[mid + 1] <= simT) lo = mid + 1; else hi = mid; }
                        const seg = lo;
                        const t = (simT - sim.times[seg]) / Math.max(1e-9, sim.times[seg + 1] - sim.times[seg]);
                        const p = seg * SEG_FLOATS;
                        const P = m.positions;
                        // Klipper reads ahead of the nozzle: emulate a lookahead queue.
                        const ahead = Math.min(m.count - 1, seg + 60);
                        status.virtual_sdcard.file_position = m.offsets[ahead];
                        status.virtual_sdcard.progress = m.offsets[ahead] / demoSource.bytes.length;
                        status.motion_report.live_position = [
                            P[p] + (P[p + 3] - P[p]) * t,
                            P[p + 1] + (P[p + 4] - P[p + 1]) * t,
                            P[p + 2] + (P[p + 5] - P[p + 2]) * t + 0.05,
                            0
                        ];
                        status.print_stats.print_duration = simT;
                    }
                }
                if (sim.phase === 'complete') {
                    status.print_stats.state = 'complete';
                    status.virtual_sdcard.progress = 1;
                    if (now - sim.t0 > 16000) { sim.phase = 'printing'; sim.t0 = now; live.target = live.display = 0; }
                }
                onStatus(status);
            };

            const setLoadingDone = () => live.model && hud.loading.classList.contains('hidden');
            setInterval(tick, 250);
            tick();
        }
    };

    // ============================================================
    // CONFIG
    // ============================================================

    async function loadPrinterConfig() {
        const key = (query.get('printer') || query.get('id') || '').toLowerCase();
        let list = null;
        for (const path of ['printers.json', 'printers.json.example']) {
            try {
                const resp = await fetch(path, { cache: 'no-store' });
                if (!resp.ok) continue;
                const json = await resp.json();
                list = Array.isArray(json) ? json : json.printers;
                if (Array.isArray(list) && list.length) break;
            } catch { /* try next */ }
        }
        const found = list && (list.find(p => String(p.id || '').toLowerCase() === key) || (!key ? list[0] : null));
        const cfg = { ...(found || {}) };
        if (query.get('ip') || query.get('host')) cfg.ip = query.get('ip') || query.get('host');
        if (query.get('name')) cfg.name = query.get('name');
        return cfg.ip ? cfg : null;
    }

    const printer = opts.demo ? { name: 'Demo Printer', ip: 'demo' } : await loadPrinterConfig();
    if (!printer) {
        setStatus('No printer', 'error');
        setMessage('No printer configured. Add ?printer=<id> (from printers.json) or ?ip=<host> — or try ?demo=1');
        renderer.setBed(0, 0, 220, 220);
    } else {
        hud.name.textContent = printer.name || printer.ip;
        document.title = `Live Toolpath · ${printer.name || printer.ip}`;
        renderer.setBed(0, 0, 220, 220);
        if (opts.demo) {
            loadModel('demo/twisted-star-tower.gcode', 0);
            demoSource.start();
        } else {
            startMoonraker(printer.ip);
            setMessage('Waiting for a print…');
        }
    }

    // ============================================================
    // FRAME LOOP
    // ============================================================

    let last = performance.now();
    let lastFrame = 0;
    const minFrameMs = 1000 / Math.max(10, Math.min(144, opts.fps));

    function frame(now) {
        requestAnimationFrame(frame);
        if (now - lastFrame < minFrameMs - 1) return;
        lastFrame = now;
        const dt = Math.min(0.1, (now - last) / 1000);
        last = now;

        const model = live.model;
        const count = model ? model.count : 0;

        if (live.state === 'complete' && count) {
            // Victory lap: replay the whole build, then hold.
            const t = Math.min(1, (now - live.replayStart) / 7000);
            const eased = t < 1 ? 1 - Math.pow(1 - t, 3) : 1;
            live.display = eased * count;
            live.target = count;
            renderer.nozzleIntensity = t < 1 ? 1 : Math.max(0, renderer.nozzleIntensity - dt);
            const s = Math.floor(Math.min(count - 1, live.display)) * SEG_FLOATS;
            renderer.setNozzle(t < 1 ? [model.positions[s + 3], model.positions[s + 4], model.positions[s + 5]] : null);
        } else {
            // Extrapolate along the toolpath at the measured rate, but never
            // past what Klipper has actually read from the file.
            let goal = live.target;
            if (live.onPath && live.rate > 0) {
                const ahead = Math.min(0.6, (now - live.updatedAt) / 1000);
                goal = Math.min(live.approx, live.target + live.rate * ahead);
            }
            if (goal < live.display - 50) live.display = goal; // restart / new file
            else if (goal > live.display) live.display += (goal - live.display) * (1 - Math.exp(-dt * 14));

            // The nozzle rides the tip of the bead while extruding and
            // follows the reported position while travelling.
            let nozzleGoal = null;
            if (live.onPath && count) nozzleGoal = pointAt(model, live.display);
            else if (live.nozzleTarget) nozzleGoal = [live.nozzleTarget[0], live.nozzleTarget[1], live.nozzleTarget[2] - live.zBias];
            if (nozzleGoal) {
                if (!live.nozzle) live.nozzle = nozzleGoal.slice();
                const k = 1 - Math.exp(-dt * 20);
                for (let i = 0; i < 3; i++) live.nozzle[i] += (nozzleGoal[i] - live.nozzle[i]) * k;
                renderer.setNozzle(live.nozzle.slice());
            }
            renderer.nozzleIntensity = live.state === 'paused' ? 0.55 + 0.45 * Math.sin(now / 300) : (live.state === 'printing' ? 1 : 0.4);
        }

        renderer.ghostPulse = live.state === 'paused' ? 0.6 + 0.4 * Math.sin(now / 400) : 1;
        renderer.nozzleColor = live.state === 'paused' ? [1, 0.8, 0.2] : [1, 0.75, 0.4];
        renderer.setProgress(live.display);
        renderer.render(now, dt);
        updateHud(model);
    }

    function pointAt(model, progress) {
        const seg = Math.max(0, Math.min(model.count - 1, Math.floor(progress)));
        const t = Math.max(0, Math.min(1, progress - seg));
        const p = seg * SEG_FLOATS, P = model.positions;
        return [P[p] + (P[p + 3] - P[p]) * t, P[p + 1] + (P[p + 4] - P[p + 1]) * t, P[p + 2] + (P[p + 5] - P[p + 2]) * t];
    }

    let hudKey = '';
    function updateHud(model) {
        if (!opts.hud || !model || !model.count) return;
        const seg = Math.max(0, Math.min(model.count - 1, Math.floor(live.display)));
        const layerIdx = layerIndexAt(model.layers, seg);
        const layerTxt = `${Math.max(0, layerIdx + 1)} / ${model.layers.length}`;
        const z = model.positions[seg * SEG_FLOATS + 5];
        const pct = live.state === 'complete' ? 100 : Math.round((live.percent || 0) * 100);
        const feature = FEATURES[model.attrs[seg * SEG_ATTRS]] || FEATURES[0];
        const key = `${layerTxt}|${z.toFixed(2)}|${pct}|${feature.id}`;
        if (key === hudKey) return;
        hudKey = key;
        hud.layer.textContent = layerTxt;
        hud.z.textContent = `${z.toFixed(2)} mm`;
        hud.pct.textContent = `${pct}%`;
        hud.bar.style.width = `${pct}%`;
        hud.feature.textContent = live.display > 0 ? feature.label : '--';
        hud.swatch.style.background = feature.color;
        if (live.state === 'printing' || live.state === 'complete') setMessage('');
    }

    requestAnimationFrame(frame);
})();
