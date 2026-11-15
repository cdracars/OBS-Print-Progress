/* Setup page for the OBS Print Progress server (server.py). */
(function () {
    'use strict';

    const $ = id => document.getElementById(id);
    const TYPE_LABELS = { klipper: 'Klipper', bambu: 'Bambu Lab', 'elegoo-cc': 'Centauri Carbon', 'elegoo-resin': 'Elegoo resin', prusalink: 'Prusa', 'snapmaker-u1': 'Snapmaker U1', anycubic: 'Anycubic', 'anycubic-p1': 'Photon P1 (experimental)' };
    const RTSP_MODELS = /X1|P2S|H2/i;

    const HELP = {
        'anycubic-p1': 'Experimental resin support. Enable LAN mode on the printer. Photon P1 permits one MQTT client: close Photon Workshop before connecting. Use the dashboard handoff button before opening the slicer again. Camera conversion is not enabled.',
        klipper: 'Use the same address you open Mainsail or Fluidd with (for example <code>192.168.1.50</code> or <code>voron.local</code>). OBS connects through this server, so you don\'t need to change Moonraker\'s CORS settings.',
        'snapmaker-u1': 'Enter the IP address shown in the U1\'s network settings on its touchscreen. The U1 runs Klipper, so both overlays work, including the live 3D twin.',
        bambu: 'On the printer\'s screen:<ol>' +
            '<li>Open the network settings and note the <b>IP address</b> and <b>Access Code</b>.</li>' +
            '<li>Find the <b>serial number</b> in the device info (it\'s also in Bambu Studio / Handy).</li>' +
            '<li>If the test below says the connection was refused, turn on <b>LAN Only</b> mode, and on newer firmware also <b>Developer Mode</b>. Bambu blocks third-party apps otherwise.</li></ol>',
        'elegoo-cc': 'Enter the IP address from the printer\'s network settings. This works with the original Centauri Carbon. The Centauri Carbon 2 uses a different protocol and isn\'t supported yet.',
        'elegoo-resin': 'Enter the IP address from the printer\'s network settings. This works with resin printers that speak SDCP over WebSocket, such as the Saturn 4 Ultra and Mars 5 Ultra (the Saturn 2 and 3 Ultra use an older protocol and aren\'t supported yet). Resin printers have no G-code, so only the status overlay applies. The camera is RTSP: add it to OBS as a Media Source.',
        prusalink: 'On the printer, open <b>Settings &gt; Network &gt; PrusaLink</b> and note the <b>IP address</b> and <b>password</b> (the user name is always <code>maker</code>). Needs firmware 5.1 or newer. The status overlay works; the Live Toolpath doesn\'t, because PrusaLink doesn\'t report the current layer.'
    };

    let printers = [];
    let editing = null;      // original id when editing
    let currentType = 'klipper';
    let extra = {};          // discovered fields not shown in the form (mainboardId)

    // ---------------- API ----------------

    async function api(path, options = {}) {
        const resp = await fetch('/api/' + path, {
            method: options.method || 'GET',
            headers: options.body ? { 'Content-Type': 'application/json' } : {},
            body: options.body ? JSON.stringify(options.body) : undefined
        });
        const json = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(json.error?.message || `HTTP ${resp.status}`);
        return json;
    }

    function toast(text) {
        const t = $('toast');
        t.textContent = text;
        t.classList.remove('hidden');
        clearTimeout(toast.timer);
        toast.timer = setTimeout(() => t.classList.add('hidden'), 2200);
    }

    // ---------------- printer list ----------------

    function overlayUrl(page, id, camera) {
        const url = new URL(page, location.origin);
        url.searchParams.set('printer', id);
        // Honor an explicit camera URL without asking a printer bridge to enable video.
        if (page === 'printer.html' && camera) url.searchParams.set('camera', camera);
        return url.href;
    }

    function statusText(s) {
        if (!s) return { cls: '', text: 'Starting...' };
        if (!s.online) return { cls: 'error', text: s.message || 'Offline' };
        if (s.message) return { cls: 'warn', text: s.message };
        const state = s.state || 'standby';
        if (state === 'printing' || state === 'paused') {
            const pct = Math.round((s.progress || 0) * 100);
            const layer = s.layer && s.total_layers ? ` · layer ${s.layer}/${s.total_layers}` : '';
            return { cls: 'ok', text: `${state === 'paused' ? 'Paused' : 'Printing'} ${s.filename || ''} · ${pct}%${layer}` };
        }
        return { cls: 'ok', text: `Online · ${state}` };
    }

    function render() {
        const list = $('printerList');
        $('emptyState').classList.toggle('hidden', printers.length > 0);
        $('dashboardExtras').innerHTML = window.PrinterDashboardLinks ? window.PrinterDashboardLinks.extraHtml(printers) : '';
        // Update in place so copy buttons/inputs don't flicker while polling.
        const seen = new Set();
        printers.forEach(p => {
            seen.add(p.id);
            let card = list.querySelector(`[data-id="${CSS.escape(p.id)}"]`);
            if (!card) {
                card = document.createElement('div');
                card.className = 'card';
                card.dataset.id = p.id;
                list.appendChild(card);
            }
            const sig = JSON.stringify([p.name, p.type, p.model, p.ip, p.camera]);
            if (card.dataset.sig !== sig) {
                card.dataset.sig = sig;
                card.innerHTML = cardHtml(p);
                card.querySelector('[data-act="edit"]').onclick = () => openEditor(p);
                card.querySelector('[data-act="delete"]').onclick = () => removePrinter(p);
                card.querySelectorAll('[data-copy]').forEach(btn => {
                    btn.onclick = () => copy(btn.dataset.copy);
                });
            }
            const st = statusText(p.status);
            card.querySelector('.dot').className = `dot ${st.cls}`;
            card.querySelector('.card-status').textContent = st.text;
        });
        list.querySelectorAll('.card').forEach(c => { if (!seen.has(c.dataset.id)) c.remove(); });
    }

    function esc(s) {
        return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function cardHtml(p) {
        const status = overlayUrl('printer.html', p.id, p.camera);
        const twin = overlayUrl('toolpath.html', p.id);
        const rtsp = p.type === 'bambu' && RTSP_MODELS.test(p.model || '')
            ? `<div class="note">This ${esc(p.model)} streams video over RTSPS, which a browser can't play. For the camera, add a <b>Media Source</b> in OBS, untick "Local File" and use <code>rtsps://bblp:&lt;access code&gt;@${esc(p.ip)}:322/streaming/live/1</code>. Then place the status overlay on top.</div>`
            : '';
        return `
            <div class="card-top">
                <span class="dot"></span>
                <span class="card-name">${esc(p.name)}</span>
                <span class="badge">${esc(TYPE_LABELS[p.type] || p.type)}${p.model ? ' · ' + esc(p.model) : ''}</span>
                <span class="card-status"></span>
                <span class="card-tools">
                    <button class="btn small ghost" data-act="edit">Edit</button>
                    <button class="btn small ghost danger" data-act="delete">Remove</button>
                </span>
            </div>
            <div class="links">
                <div class="link-row"><span class="label">Status overlay</span><input readonly value="${esc(status)}">
                    <button class="btn small" data-copy="${esc(status)}">Copy</button><a class="btn small ghost" href="${esc(status)}" target="_blank" rel="noopener noreferrer">Watch</a></div>
                <div class="link-row"><span class="label">3D twin</span><input readonly value="${esc(twin)}">
                    <button class="btn small" data-copy="${esc(twin)}">Copy</button><a class="btn small ghost" href="${esc(twin)}" target="_blank">Preview</a></div>
            </div>
            ${window.PrinterDashboardLinks ? window.PrinterDashboardLinks.html(p) : '<div class="muted">Controls: dashboard links unavailable.</div>'}
            ${rtsp}`;
    }

    async function copy(text) {
        try {
            await navigator.clipboard.writeText(text);
            toast('Copied! Paste it into an OBS Browser source.');
        } catch {
            prompt('Copy this URL:', text);
        }
    }

    async function refresh() {
        try {
            printers = (await api('printers')).printers;
            render();
        } catch (err) {
            $('printerList').innerHTML = `<div class="card">Can't reach the server: ${esc(err.message)}. Is server.py still running?</div>`;
        }
    }

    async function removePrinter(p) {
        if (!confirm(`Remove ${p.name}?`)) return;
        await api(`printers/${encodeURIComponent(p.id)}`, { method: 'DELETE' });
        refresh();
    }

    // ---------------- editor ----------------

    function setType(type) {
        currentType = type;
        document.querySelectorAll('.type').forEach(b => b.classList.toggle('active', b.dataset.type === type));
        document.querySelectorAll('.only').forEach(el => {
            el.classList.toggle('hidden', !el.classList.contains(type));
        });
        $('typeHelp').innerHTML = HELP[type];
        $('form').classList.remove('hidden');
        const f = $('form');
        f.serial.required = type === 'bambu';
        f.accessCode.required = type === 'bambu' || type === 'prusalink';
        $('accessCodeLabel').textContent = type === 'prusalink' ? 'PrusaLink password' : 'LAN access code';
        f.accessCode.placeholder = type === 'prusalink' ? 'from Settings > Network > PrusaLink' : '8 characters';
    }

    function openEditor(p) {
        editing = p ? p.id : null;
        extra = p && p.mainboardId ? { mainboardId: p.mainboardId } : {};
        $('editorTitle').textContent = p ? `Edit ${p.name}` : 'Add a printer';
        $('editor').classList.remove('hidden');
        $('testResult').classList.add('hidden');
        $('discoverResults').innerHTML = '';
        const f = $('form');
        f.reset();
        if (p) {
            ['name', 'ip', 'serial', 'accessCode', 'model', 'camera'].forEach(k => { if (p[k] !== undefined) f[k].value = p[k]; });
            ['flipHorizontal', 'flipVertical', 'showChamber', 'direct'].forEach(k => { f[k].checked = !!p[k]; });
            setType(p.type || 'klipper');
        } else {
            $('form').classList.add('hidden');
            document.querySelectorAll('.type').forEach(b => b.classList.remove('active'));
        }
        $('editor').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function formData() {
        const f = $('form');
        const data = { type: currentType, originalId: editing || undefined, ...extra };
        ['name', 'ip', 'camera'].forEach(k => { data[k] = f[k].value.trim(); });
        if (currentType === 'bambu') {
            data.serial = f.serial.value.trim();
            data.accessCode = f.accessCode.value.trim();
            data.model = f.model.value;
        }
        if (currentType === 'prusalink') data.accessCode = f.accessCode.value.trim();
        ['flipHorizontal', 'flipVertical', 'showChamber'].forEach(k => { if (f[k].checked) data[k] = true; });
        if (f.direct.checked && (currentType === 'klipper' || currentType === 'snapmaker-u1')) data.direct = true;
        if (currentType === 'bambu' && /X1|H2/i.test(data.model)) data.showChamber = true;
        if (currentType === 'elegoo-cc' || currentType === 'elegoo-resin') data.showChamber = true;
        if (editing) data.id = editing;
        return data;
    }

    function showResult(ok, text) {
        const r = $('testResult');
        r.className = `result ${ok ? 'ok' : 'error'}`;
        r.textContent = text;
    }

    async function testConnection() {
        const btn = $('testBtn');
        btn.disabled = true;
        btn.textContent = 'Testing...';
        try {
            const s = await api('test', { method: 'POST', body: formData() });
            if (s.ok) {
                const st = statusText(s);
                const temps = s.nozzle != null ? ` · nozzle ${Math.round(s.nozzle)}°C, bed ${Math.round(s.bed ?? 0)}°C` : '';
                showResult(true, `Connected! ${st.text}${temps}`);
            } else {
                showResult(false, s.message || 'Could not connect.');
            }
        } catch (err) {
            showResult(false, err.message);
        } finally {
            btn.disabled = false;
            btn.textContent = 'Test connection';
        }
    }

    async function save(ev) {
        ev.preventDefault();
        try {
            await api('printers', { method: 'POST', body: formData() });
            $('editor').classList.add('hidden');
            toast('Saved. Copy a link below into OBS.');
            refresh();
        } catch (err) {
            showResult(false, err.message);
        }
    }

    async function discoverPrinters() {
        const btn = $('discoverBtn');
        btn.disabled = true;
        btn.textContent = 'Searching (5s)...';
        $('discoverResults').innerHTML = '';
        try {
            const { found } = await api('discover', { method: 'POST' });
            const known = new Set(printers.map(p => p.ip));
            const fresh = found.filter(f => !known.has(f.ip));
            $('discoverHint').textContent = fresh.length ? 'Click a printer to fill in the form.' : 'Nothing new found. Enter the details by hand below.';
            fresh.forEach(f => {
                const b = document.createElement('button');
                b.type = 'button';
                b.innerHTML = `<b>${esc(f.name)}</b> · ${esc(TYPE_LABELS[f.type])}${f.model ? ' ' + esc(f.model) : ''} · ${esc(f.ip)}`;
                b.onclick = () => useDiscovered(f);
                $('discoverResults').appendChild(b);
            });
        } catch (err) {
            $('discoverHint').textContent = `Search failed: ${err.message}`;
        } finally {
            btn.disabled = false;
            btn.textContent = 'Search my network';
        }
    }

    function useDiscovered(f) {
        setType(f.type);
        const form = $('form');
        form.name.value = f.name || '';
        form.ip.value = f.ip || '';
        if (f.serial) form.serial.value = f.serial;
        if (f.model && [...form.model.options].some(o => o.value === f.model)) form.model.value = f.model;
        extra = f.mainboardId ? { mainboardId: f.mainboardId } : {};
        (f.type === 'bambu' ? form.accessCode : form.name).focus();
    }

    // ---------------- automatic network search ----------------

    // Printers that need nothing but an address can be added in one click;
    // Bambu Lab printers still need their access code, so they open the form.
    const NEEDS_FORM = new Set(['bambu', 'prusalink', 'anycubic-p1']);
    let found = [];
    let scanning = false;

    function foundPrinterData(f) {
        const data = { type: f.type, name: f.name || TYPE_LABELS[f.type] || 'Printer', ip: f.ip };
        if (f.model) data.model = f.model;
        if (f.mainboardId) data.mainboardId = f.mainboardId;
        if (f.type === 'elegoo-cc' || f.type === 'elegoo-resin') data.showChamber = true;
        return data;
    }

    function renderFound() {
        const fresh = found.filter(f => !f.known && !printers.some(p => p.ip === f.ip));
        const quick = fresh.filter(f => !NEEDS_FORM.has(f.type) && f.supported !== false);
        $('foundPanel').classList.toggle('hidden', !scanning && !fresh.length);
        $('foundHint').textContent = scanning ? 'Searching your network (about 10 seconds)...'
            : `${fresh.length} printer${fresh.length === 1 ? '' : 's'} not added yet.`;
        $('addAllBtn').classList.toggle('hidden', quick.length < 1);
        $('addAllBtn').textContent = quick.length > 1 ? `Add all ${quick.length}` : 'Add it';
        $('rescanBtn').disabled = scanning;
        const list = $('foundList');
        list.innerHTML = '';
        fresh.forEach(f => {
            const row = document.createElement('div');
            row.className = 'found-row';
            const needsForm = NEEDS_FORM.has(f.type);
            const meta = `${esc(TYPE_LABELS[f.type] || f.type)}${f.model && f.model !== f.name ? ' ' + esc(f.model) : ''} · ${esc(f.ip)}`;
            if (f.supported === false) {
                // Seen on the network, but there's no adapter for it yet (Anycubic).
                const why = f.type === 'anycubic'
                    ? (f.lanMode ? 'LAN mode is on. Support is in progress: run tools/anycubic_probe.py to help build it.'
                                 : 'Not supported yet. Turn on LAN mode on the printer for local monitoring.')
                    : 'Not supported yet.';
                row.innerHTML = `<span class="found-name">${esc(f.name)}</span><span class="found-meta">${meta} · ${esc(why)}</span>`;
                list.appendChild(row);
                return;
            }
            row.innerHTML = `<span class="found-name">${esc(f.name)}</span>
                <span class="found-meta">${meta}</span>
                <button class="btn small${needsForm ? ' ghost' : ''}">${needsForm ? 'Set up' : 'Add'}</button>`;
            row.querySelector('button').onclick = () => needsForm ? setUpFound(f) : addFound([f]);
            list.appendChild(row);
        });
    }

    async function scanNetwork() {
        if (scanning) return;
        scanning = true;
        renderFound();
        try {
            found = (await api('discover', { method: 'POST' })).found || [];
        } catch (err) {
            found = [];
            toast(`Network search failed: ${err.message}`);
        } finally {
            scanning = false;
            renderFound();
        }
    }

    async function addFound(list) {
        let added = 0;
        for (const f of list) {
            try {
                await api('printers', { method: 'POST', body: foundPrinterData(f) });
                f.known = true;
                added++;
            } catch (err) {
                toast(`${f.name}: ${err.message}`);
            }
        }
        if (added) toast(`Added ${added} printer${added === 1 ? '' : 's'}. Copy a link below into OBS.`);
        await refresh();
        renderFound();
    }

    function setUpFound(f) {
        openEditor(null);
        useDiscovered(f);
    }

    // ---------------- wiring ----------------

    document.querySelectorAll('.type').forEach(b => { b.onclick = () => setType(b.dataset.type); });
    $('addBtn').onclick = () => openEditor(null);
    $('cancelBtn').onclick = () => $('editor').classList.add('hidden');
    $('testBtn').onclick = testConnection;
    $('discoverBtn').onclick = discoverPrinters;
    $('form').addEventListener('submit', save);

    api('info').then(i => { $('version').textContent = `v${i.version}`; }).catch(() => {});
    $('rescanBtn').onclick = scanNetwork;
    $('addAllBtn').onclick = () => addFound(found.filter(f => !f.known && f.supported !== false && !NEEDS_FORM.has(f.type) && !printers.some(p => p.ip === f.ip)));
    refresh().then(() => {
        // Search the network right away so new printers show up without a click.
        scanNetwork().then(() => {
            if (!printers.length && !found.some(f => !f.known)) openEditor(null);
        });
    });
    setInterval(refresh, 3000);
})();
