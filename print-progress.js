(async function () {
    const body = document.body || document.documentElement;

    let PRINTER_IP = body.dataset.printerIp || 'localhost';
    let PRINTER_NAME = body.dataset.printerName || 'Printer';
    let UPDATE_INTERVAL = Number(body.dataset.updateInterval) || 2000;
    let DEBUG = parseBool(body.dataset.debug || 'false');
    let CAMERA_URL = body.dataset.cameraUrl || '';
    let CAMERA_FLIP_X = parseBool(body.dataset.cameraFlipX || 'false');
    let CAMERA_FLIP_Y = parseBool(body.dataset.cameraFlipY || 'false');
    let SHOW_CHAMBER = parseBool(body.dataset.chamberEnabled || body.dataset.showChamber || 'false');

    const metadataCache = {
        filename: null,
        data: null,
        source: null
    };

    // Chamber discovery cache (needs to be defined before init to avoid TDZ)
    const chamberCandidates = [
        'temperature_sensor chamber',
        'temperature_sensor chamber_temp',
        'temperature_sensor chamber-temp',
        'temperature_sensor enclosure_temp',
        'temperature_sensor enclosure',
        'temperature_host enclosure_temp',
        'temperature_host enclosure',
        'temperature_sensor chamber2',
        'temperature_sensor enclosure_upper',
        'temperature_sensor chamber_average'
    ];
    let chamberObjectName = null;
    let objectListCache = null;
    let objectListFetchedAt = 0;

    function applyConfig(cfg) {
        const b = body;
        const config = cfg || {};

        PRINTER_NAME = config.name || config.label || b.dataset.printerName || 'Printer';
        PRINTER_IP = config.ip || config.host || b.dataset.printerIp || 'localhost';
        CAMERA_URL = config.camera || '';  // Don't fallback to old dataset value
        CAMERA_FLIP_X = parseBool(config.flipHorizontal ?? b.dataset.cameraFlipX ?? 'false');
        CAMERA_FLIP_Y = parseBool(config.flipVertical ?? b.dataset.cameraFlipY ?? 'false');
        SHOW_CHAMBER = parseBool(config.showChamber ?? b.dataset.chamberEnabled ?? b.dataset.showChamber ?? 'false');
        UPDATE_INTERVAL = Number(config.updateInterval || config.intervalMs || b.dataset.updateInterval || 2000) || 2000;
        DEBUG = parseBool(config.debug ?? b.dataset.debug ?? 'false');

        // Auto-generate camera URL if not explicitly provided in config
        if (!CAMERA_URL && PRINTER_IP && PRINTER_IP !== 'localhost') {
            CAMERA_URL = `http://${PRINTER_IP}/webcam/?action=stream`;
        }

        b.dataset.printerName = PRINTER_NAME;
        b.dataset.printerIp = PRINTER_IP;
        b.dataset.cameraUrl = CAMERA_URL;
        b.dataset.cameraFlipX = String(CAMERA_FLIP_X);
        b.dataset.cameraFlipY = String(CAMERA_FLIP_Y);
        b.dataset.chamberEnabled = String(SHOW_CHAMBER);
        b.dataset.updateInterval = String(UPDATE_INTERVAL);
        b.dataset.debug = String(DEBUG);
    }

    async function loadConfig() {
        const query = new URLSearchParams(window.location.search);
        const key = (
            query.get('printer') ||
            query.get('printers') || // common typo
            query.get('id') ||
            query.get('name') ||
            ''
        ).toLowerCase();
        const queryOverride = parseQueryConfig(query);

        const list = await fetchPrinterList();
        if (list && list.length) {
            const found = selectConfig(list, key);
            const base = found || list[0];
            return { ...base, ...queryOverride };
        }

        if (queryOverride && queryOverride.ip) return queryOverride;
        if (window.PRINTER_CONFIG) return { ...window.PRINTER_CONFIG, ...queryOverride };
        return queryOverride || null;
    }

    async function fetchPrinterList() {
        // Inline JSON script fallback (avoids file:// CORS)
        const inlineList = readInlinePrinterList();
        if (inlineList) return inlineList;

        // Global JS variable fallback (window.PRINTERS or window.PRINTER_CONFIGS)
        const globalList = readGlobalPrinterList();
        if (globalList) return globalList;

        // First attempt: printers.json (preferred)
        const main = await fetchJsonConfig('printers.json');
        if (main) return main;

        // Fallback: example file (template)
        const example = await fetchJsonConfig('printers.json.example');
        if (example) return example;

        return null;
    }

    async function fetchJsonConfig(path) {
        const url = new URL(path, window.location.href).href;
        // Try fetch with timeout
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 2000); // 2 second timeout
            
            const resp = await fetch(url, { signal: controller.signal });
            clearTimeout(timeout);
            
            if (resp.ok) {
                const json = await resp.json();
                if (Array.isArray(json)) return json;
                if (Array.isArray(json.printers)) return json.printers;
            }
        } catch (err) {
            if (err.name === 'AbortError') {
                console.warn(`Timeout fetching ${url}`);
            } else {
                console.warn(`Could not fetch ${url}:`, err?.message || err);
            }
        }

        // Fallback to XHR for file:// contexts where fetch is blocked by CORS
        if (location.protocol === 'file:') {
            try {
                const json = await loadJsonViaXhr(url);
                if (Array.isArray(json)) return json;
                if (Array.isArray(json?.printers)) return json.printers;
            } catch (err) {
                console.warn(`Could not load ${url} via XHR:`, err?.message || err);
            }
        }
        return null;
    }

    function readInlinePrinterList() {
        const ids = ['printers-config', 'printers-json', 'printer-config'];
        for (const id of ids) {
            const script = document.getElementById(id);
            if (!script) continue;
            try {
                const txt = script.textContent || script.innerText;
                if (!txt) continue;
                const json = JSON.parse(txt);
                if (Array.isArray(json)) return json;
                if (Array.isArray(json.printers)) return json.printers;
            } catch (err) {
                console.warn(`Could not parse inline printers JSON from #${id}:`, err?.message || err);
            }
        }
        return null;
    }

    function readGlobalPrinterList() {
        const candidates = [window.PRINTERS, window.PRINTER_CONFIGS];
        for (const candidate of candidates) {
            if (!candidate) continue;
            if (Array.isArray(candidate)) return candidate;
            if (Array.isArray(candidate.printers)) return candidate.printers;
        }
        return null;
    }

    function loadJsonViaXhr(path) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('GET', path, true);
            xhr.overrideMimeType('application/json');
            xhr.onreadystatechange = () => {
                if (xhr.readyState !== 4) return;
                if (xhr.status === 0 || (xhr.status >= 200 && xhr.status < 300)) {
                    try {
                        const data = JSON.parse(xhr.responseText);
                        resolve(data);
                    } catch (err) {
                        reject(err);
                    }
                } else {
                    reject(new Error(`XHR ${xhr.status}`));
                }
            };
            xhr.onerror = () => reject(new Error('XHR network error'));
            xhr.send();
        });
    }

    function parseQueryConfig(query) {
        if (!query) return {};
        const cfg = {};
        if (query.get('ip')) cfg.ip = query.get('ip');
        if (query.get('host')) cfg.ip = query.get('host');
        if (query.get('name')) cfg.name = query.get('name');
        if (query.get('label')) cfg.name = query.get('label');
        if (query.get('camera')) cfg.camera = query.get('camera');
        if (query.get('flipX')) cfg.flipHorizontal = parseBool(query.get('flipX'));
        if (query.get('flipHorizontal')) cfg.flipHorizontal = parseBool(query.get('flipHorizontal'));
        if (query.get('flipY')) cfg.flipVertical = parseBool(query.get('flipY'));
        if (query.get('flipVertical')) cfg.flipVertical = parseBool(query.get('flipVertical'));
        if (query.get('chamber')) cfg.showChamber = parseBool(query.get('chamber'));
        if (query.get('showChamber')) cfg.showChamber = parseBool(query.get('showChamber'));
        if (query.get('interval')) cfg.updateInterval = Number(query.get('interval'));
        if (query.get('updateInterval')) cfg.updateInterval = Number(query.get('updateInterval'));
        if (query.get('debug')) cfg.debug = parseBool(query.get('debug'));
        return cfg;
    }

    function selectConfig(list, key) {
        if (!key) return null;
        const lowerKey = key.toLowerCase();
        return list.find(cfg => {
            const id = String(cfg.id || cfg.name || cfg.label || '').toLowerCase();
            return id === lowerKey;
        }) || null;
    }

    function setPrinterName() {
        const printerNameEl = document.getElementById('printerName');
        if (printerNameEl) {
            printerNameEl.textContent = PRINTER_NAME;
        }
    }

    function setupCamera() {
        const cameraEl = document.getElementById('cameraFeed');
        if (!cameraEl) return;
        if (CAMERA_URL) {
            cameraEl.src = CAMERA_URL;
            cameraEl.classList.remove('hidden');
            const flips = [];
            if (CAMERA_FLIP_X) flips.push('scaleX(-1)');
            if (CAMERA_FLIP_Y) flips.push('scaleY(-1)');
            cameraEl.style.transform = flips.join(' ');
            
            // Show camera only when loaded successfully
            cameraEl.onload = () => {
                cameraEl.classList.add('loaded');
            };
            cameraEl.onerror = () => {
                cameraEl.classList.remove('loaded');
                console.warn('Camera feed failed to load');
            };
        } else {
            cameraEl.classList.add('hidden');
        }
    }

    await initialize();

    async function initialize() {
        const cfg = await loadConfig();
        if (!cfg) {
            showConfigError('No printer config found. Ensure printers.json is readable or pass ?ip=...&name=... in the URL.');
            return;
        }
        applyConfig(cfg);
        setPrinterName();
        setupCamera();
        
        // Start fetching immediately without waiting for chamber
        fetchPrintStatus();
        setInterval(fetchPrintStatus, UPDATE_INTERVAL);
        
        // Update chamber in background (don't block)
        updateChamber();
    }

    async function extractThumbnailFromGcode(filename) {
        try {
            const path = normalizeFilename(filename);
            if (!path) return null;

            const url = `http://${PRINTER_IP}/server/files/${encodeURI(path)}`;

            const resp = await fetch(url, {
                headers: { Range: "bytes=0-100000" }  // Reduced from 250KB to 100KB
            });

            if (!resp.ok) {
                console.warn("Thumbnail header fetch failed:", resp.status, url);
                return null;
            }

            const text = await resp.text();

            // Find all thumbnail blocks, keep the last (usually 300x300)
            const blockRegex = /; thumbnail begin \d+x\d+ \d+([\s\S]*?); thumbnail end/g;
            let match;
            let lastBlock = null;

            while ((match = blockRegex.exec(text)) !== null) {
                const block = match[1];
                const b64 = block
                    .split("\n")
                    .map(line => line.trim().replace(/^;/, "").trim())
                    .filter(Boolean)
                    .join("");
                lastBlock = b64;
            }

            return lastBlock;
        } catch (err) {
            console.error("extractThumbnailFromGcode error:", err);
            return null;
        }
    }

    function hideThumbnail() {
        const thumbEl = document.getElementById("thumbnail");
        const fileLabel = document.getElementById("thumbnailFilename");
        if (thumbEl) {
            thumbEl.src = "";
            thumbEl.style.display = "none";
            thumbEl.removeAttribute("data-loaded-for");
        }
        if (fileLabel) {
            fileLabel.textContent = "--";
        }
    }

    async function fetchPrintStatus() {
        try {
            const response = await fetch(`http://${PRINTER_IP}/printer/objects/query?display_status&print_stats&virtual_sdcard&extruder&heater_bed&toolhead`);
            const data = await response.json();
            
            const status = data.result.status;
            const printStats = status.print_stats;
            const displayStatus = status.display_status;
            const virtualSdcard = status.virtual_sdcard;
            const extruder = status.extruder;
            const heaterBed = status.heater_bed;
            const toolhead = status.toolhead;

            await ensureMetadataLoaded(printStats.filename, printStats.state);
            
            if (extruder) {
                const hotendTemp = Math.round(extruder.temperature);
                const hotendTarget = Math.round(extruder.target);
                document.getElementById('hotendTemp').textContent = `${hotendTemp}\u00B0C / ${hotendTarget}\u00B0C`;
            }
            
            if (heaterBed) {
                const bedTemp = Math.round(heaterBed.temperature);
                const bedTarget = Math.round(heaterBed.target);
                document.getElementById('bedTemp').textContent = `${bedTemp}\u00B0C / ${bedTarget}\u00B0C`;
            }

            await updateChamber();
            
            const statusElement = document.getElementById('status');
            const state = printStats.state;
            statusElement.textContent = state.charAt(0).toUpperCase() + state.slice(1);
            
            if (state === 'printing') {
                statusElement.className = 'status-pill ok';
                
                // Prefer the virtual_sdcard progress (matches what Mainsail shows), fall back to display_status
                const rawProgress = virtualSdcard.progress ?? displayStatus.progress ?? 0;
                const progress = Math.max(0, Math.min(1, Number(rawProgress) || 0));
                const percentage = Math.round(progress * 100);
                document.getElementById('progressBar').style.width = percentage + '%';
                document.getElementById('percentage').textContent = percentage + '%';
                
                const { currentLayer, totalLayer } = getLayerInfo(printStats, displayStatus, toolhead);
                document.getElementById('layerInfo').textContent = formatLayerInfo(currentLayer, totalLayer);
                const printDuration = printStats.print_duration || 0;
                const estimateRemaining = computeRemainingFromProgress(progress, printDuration);
                const slicerTotal = getSlicerTotalSeconds(metadataCache.data, printStats.info);
                const slicerRemaining = slicerTotal !== null && slicerTotal !== undefined
                    ? Math.max(0, slicerTotal - printDuration)
                    : null;
                const elapsedTime = getElapsedTime(printStats);

                setTimeValue('timeEstimate', estimateRemaining);
                setTimeValue('timeSlicer', slicerRemaining);
                setTimeValue('timeTotal', elapsedTime);

                updateDebug({
                    state,
                    progress,
                    filename: printStats.filename,
                    toolheadZ: toolhead?.position?.[2],
                    slicerInfo: printStats.info || {},
                    metadata: metadataCache,
                    currentLayer,
                    totalLayer,
                    metadataLayer: computeLayerFromMetadata(toolhead, metadataCache.data),
                    progressLayer: computeLayerFromProgress(displayStatus, metadataCache.data),
                    estimateRemaining,
                    slicerRemaining,
                    slicerTotal,
                    elapsedTime
                });
                
                document.getElementById('filename').textContent = formatFilename(printStats.filename) || 'Unknown';
                
                // Thumbnail display
                const thumbEl = document.getElementById("thumbnail");
                if (thumbEl) {
                    const normalized = normalizeFilename(printStats.filename);
                    const loadedFor = thumbEl.dataset.loadedFor || "";

                    if (normalized && loadedFor !== normalized) {
                        thumbEl.dataset.loadedFor = normalized;
                        // Keep hidden while loading
                        thumbEl.style.display = "none";

                        extractThumbnailFromGcode(normalized).then(b64 => {
                            if (b64 && b64.length > 100) {  // Sanity check for valid base64
                                thumbEl.src = `data:image/png;base64,${b64}`;
                                thumbEl.style.display = "block";

                                const fileLabel = document.getElementById("thumbnailFilename");
                                if (fileLabel) {
                                    fileLabel.textContent = printStats.filename || "--";
                                }
                            } else {
                                hideThumbnail();
                            }
                        }).catch(err => {
                            console.error("Thumbnail load error:", err);
                            hideThumbnail();
                        });
                    }
                }
                
            } else if (state === 'paused') {
                statusElement.className = 'status-pill idle';
                document.getElementById('layerInfo').textContent = '--';
                setTimeValue('timeEstimate', null);
                setTimeValue('timeSlicer', null);
                setTimeValue('timeTotal', null);
                hideThumbnail();
            } else {
                statusElement.className = 'status-pill idle';
                document.getElementById('progressBar').style.width = '0%';
                document.getElementById('percentage').textContent = '0%';
                setTimeValue('timeEstimate', null);
                setTimeValue('timeSlicer', null);
                setTimeValue('timeTotal', null);
                document.getElementById('layerInfo').textContent = '--';
                document.getElementById('filename').textContent = '--';
                hideThumbnail();
            }
            
        } catch (error) {
            document.getElementById('status').textContent = 'Connection Error';
            document.getElementById('status').className = 'status-pill error';
            console.error('Error fetching print status:', error);
            updateDebug({ error: error?.message || String(error) });
            hideThumbnail();
        }
    }

    function showConfigError(msg) {
        console.error(msg);
        const statusElement = document.getElementById('status');
        if (statusElement) {
            statusElement.textContent = 'Config Error';
            statusElement.className = 'status-pill error';
        }
        const debugEl = document.getElementById('debugInfo');
        if (debugEl) {
            debugEl.textContent = msg;
            debugEl.classList.remove('hidden');
        }
    }

    async function updateChamber() {
        const chamberChip = document.getElementById('chamberChip');
        if (!chamberChip) return;

        const temps = await fetchChamberTemp();
        if (temps) {
            chamberChip.classList.remove('hidden');
            document.getElementById('chamberTemp').textContent = `${temps.current}\u00B0C / ${temps.target}\u00B0C`;
        } else if (SHOW_CHAMBER) {
            chamberChip.classList.remove('hidden');
            document.getElementById('chamberTemp').textContent = '--';
        } else {
            chamberChip.classList.add('hidden');
        }
    }

    async function fetchChamberTemp() {
        const objName = await getChamberObjectName();
        if (objName) {
            const data = await querySingleObject(objName);
            const parsed = parseTempEntry(data);
            if (parsed) return parsed;
        }

        // fallback: try known candidates directly
        for (const obj of chamberCandidates) {
            const data = await querySingleObject(obj);
            const parsed = parseTempEntry(data);
            if (parsed) {
                chamberObjectName = obj; // cache the one that worked
                return parsed;
            }
        }
        return null;
    }

    async function getChamberObjectName() {
        if (chamberObjectName) return chamberObjectName;
        const objects = await fetchObjectList();
        if (!objects) return null;

        const lower = objects.map(o => o.toLowerCase());
        for (const candidate of chamberCandidates) {
            const idx = lower.indexOf(candidate.toLowerCase());
            if (idx !== -1) {
                chamberObjectName = objects[idx]; // preserve original case
                return chamberObjectName;
            }
        }
        return null;
    }

    async function fetchObjectList() {
        const now = Date.now();
        if (objectListCache && now - objectListFetchedAt < 30000) {
            return objectListCache;
        }
        try {
            const resp = await fetch(`http://${PRINTER_IP}/printer/objects/list`);
            if (!resp.ok) return null;
            const json = await resp.json();
            const list = json.result?.objects;
            if (Array.isArray(list)) {
                objectListCache = list;
                objectListFetchedAt = now;
                return list;
            }
        } catch (err) {
            // ignore
        }
        return null;
    }

    async function querySingleObject(objName) {
        try {
            const resp = await fetch(`http://${PRINTER_IP}/printer/objects/query?${encodeURIComponent(objName)}`);
            if (!resp.ok) return null;
            const json = await resp.json();
            const status = json.result?.status;
            if (!status) return null;
            const key = Object.keys(status)[0];
            return status[key] || null;
        } catch {
            return null;
        }
    }

    function parseTempEntry(entry) {
        if (!entry) return null;
        const current = Math.round(entry.temperature ?? entry.temp ?? entry.current ?? entry.temper);
        const targetRaw = entry.target ?? entry.target_temp ?? entry.target_temperature;
        const target = targetRaw !== undefined && targetRaw !== null ? Math.round(targetRaw) : Math.round(entry.temperature ?? entry.temp ?? 0);
        if (!Number.isFinite(current)) return null;
        return {
            current,
            target: Number.isFinite(target) ? target : current
        };
    }

    function parseBool(val) {
        if (val === undefined || val === null) return false;
        if (typeof val === 'boolean') return val;
        const str = String(val).toLowerCase();
        return str === 'true' || str === '1' || str === 'yes';
    }

    function formatLayerInfo(current, total) {
        const hasCurrent = current !== null && current !== undefined;
        const hasTotal = total !== null && total !== undefined;
        
        if (!hasCurrent && !hasTotal) return '--';
        if (hasCurrent && hasTotal) return `${current} / ${total}`;
        if (hasCurrent) return `${current}`;
        return `-- / ${total}`;
    }

    function formatTime(seconds) {
        if (!seconds || seconds < 0) return '--';
        
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = Math.floor(seconds % 60);
        
        if (hours > 0) {
            return `${hours}h ${minutes}m`;
        } else if (minutes > 0) {
            return `${minutes}m ${secs}s`;
        } else {
            return `${secs}s`;
        }
    }

    function setTimeValue(elementId, seconds) {
        const el = document.getElementById(elementId);
        if (!el) return;
        if (seconds === null || seconds === undefined || seconds < 0 || !Number.isFinite(seconds)) {
            el.textContent = '--';
        } else {
            el.textContent = formatTime(seconds);
        }
    }

    function computeRemainingFromProgress(progress, printDuration) {
        if (progress > 0 && progress < 1) {
            const totalTime = printDuration / progress;
            return totalTime - printDuration;
        }
        return null;
    }

    function getSlicerTotalSeconds(metadata, slicerInfo) {
        const candidates = [
            metadata?.estimated_time,
            metadata?.slicer_estimated_time,
            metadata?.slicer_time,
            metadata?.estimated_print_time,
            metadata?.slicer_estimated_duration,
            metadata?.print_time,
            slicerInfo?.estimated_time,
            slicerInfo?.slicer_time,
            slicerInfo?.slicer_estimated_time,
            slicerInfo?.estimated_print_time,
            slicerInfo?.slicer_estimated_duration
        ];

        for (const value of candidates) {
            const num = asNumber(value);
            if (num && num > 0) {
                return num;
            }
        }
        return null;
    }

    function getElapsedTime(printStats) {
        const totalDuration = asNumber(printStats?.total_duration);
        const printDuration = asNumber(printStats?.print_duration);
        return totalDuration ?? printDuration ?? null;
    }

    function getLayerInfo(printStats, displayStatus, toolhead) {
        const slicerInfo = printStats.info || {};
        const slicerCurrent = asNumber(
            slicerInfo.current_layer ??
            slicerInfo.currentLayer ??
            slicerInfo.layer_current ??
            slicerInfo.layer
        );
        const slicerTotal = asNumber(
            slicerInfo.total_layer ??
            slicerInfo.totalLayer ??
            slicerInfo.layer_count ??
            slicerInfo.layerTotal ??
            slicerInfo.totalLayers
        );
        
        const metadataLayer = computeLayerFromMetadata(toolhead, metadataCache.data);
        const progressLayer = computeLayerFromProgress(displayStatus, metadataCache.data);
        
        return {
            currentLayer: firstNonNull(slicerCurrent, metadataLayer.current, progressLayer.current),
            totalLayer: firstNonNull(slicerTotal, metadataLayer.total, progressLayer.total)
        };
    }

    function computeLayerFromMetadata(toolhead, metadata) {
        if (!metadata) return { current: null, total: null };
        
        const layerHeight = metadata.layer_height;
        const firstLayerHeight = metadata.first_layer_height || layerHeight;
        const objectHeight = metadata.object_height;
        const layerCount = asNumber(
            metadata.layer_count ??
            metadata.total_layer ??
            metadata.total_layers
        );
        const currentZ = toolhead?.position?.[2];
        
        let total = layerCount || null;
        if (!total && layerHeight && objectHeight) {
            total = Math.max(1, Math.round(((objectHeight - firstLayerHeight) / layerHeight) + 1));
        }

        let current = null;
        if (layerHeight && currentZ !== undefined && currentZ !== null) {
            const calc = Math.floor(((currentZ - firstLayerHeight) / layerHeight) + 1);
            current = Math.max(1, calc);
            if (total) {
                current = Math.min(total, current);
            }
        }

        return { current, total };
    }

    function computeLayerFromProgress(displayStatus, metadata) {
        if (!metadata) return { current: null, total: null };
        
        const total = asNumber(
            metadata.layer_count ??
            metadata.total_layer ??
            metadata.total_layers
        );
        const progress = typeof displayStatus?.progress === 'number' ? displayStatus.progress : null;

        if (!total || progress === null || progress <= 0) {
            return { current: null, total: total || null };
        }

        const current = Math.max(1, Math.min(total, Math.round(progress * total)));
        return { current, total };
    }

    function firstNonNull(...values) {
        for (const value of values) {
            if (value !== null && value !== undefined) {
                return value;
            }
        }
        return null;
    }

    function asNumber(value) {
        const num = Number(value);
        return Number.isFinite(num) ? num : null;
    }

    async function ensureMetadataLoaded(filename, state) {
        if (state !== 'printing' || !filename) {
            return;
        }

        if (metadataCache.filename === filename && metadataCache.data) {
            return;
        }

        metadataCache.filename = filename;
        const metaResult = await fetchMetadata(filename);
        metadataCache.data = metaResult?.data || null;
        metadataCache.source = metaResult?.source || null;
    }

    async function fetchMetadata(filename) {
        try {
            const fileParam = normalizeFilename(filename);
            if (!fileParam) {
                return null;
            }

            const apiMeta = await fetchMetadataFromApi(fileParam);
            if (apiMeta) {
                return { data: apiMeta, source: 'api' };
            }

            const headerMeta = await fetchMetadataFromGcode(fileParam);
            if (headerMeta) {
                return { data: headerMeta, source: 'gcode-header' };
            }

            return null;
        } catch (err) {
            console.error('Error fetching metadata:', err);
            return null;
        }
    }

    async function fetchMetadataFromApi(fileParam) {
        const candidates = [
            fileParam,
            fileParam.replace(/^gcodes\//, ''),
            `gcodes/${fileParam.replace(/^gcodes\//, '')}`,
            `printer_data/${fileParam}`,
            `gcode_files/${fileParam.replace(/^gcodes\//, '')}`
        ];

        for (const candidate of candidates) {
            try {
                const response = await fetch(`http://${PRINTER_IP}/server/files/metadata?filename=${encodeURIComponent(candidate)}`);
                if (!response.ok) {
                    // Don't log 404s - metadata might not be ready yet
                    continue;
                }
                const data = await response.json();
                return data.result;
            } catch (err) {
                // Silently continue to next candidate
            }
        }
        return null;
    }

    async function fetchMetadataFromGcode(fileParam) {
        try {
            const candidates = [
                fileParam,
                fileParam.replace(/^gcodes\//, ''),
                `gcodes/${fileParam}`,
                `printer_data/${fileParam}`,
                `gcode_files/${fileParam.replace(/^gcodes\//, '')}`
            ];

            for (const candidate of candidates) {
                const safePath = encodeURI(candidate);
                const response = await fetch(`http://${PRINTER_IP}/server/files/${safePath}`, {
                    headers: { Range: 'bytes=0-65535' }
                });

                if (!response.ok) {
                    // Silently continue - file might not be accessible
                    continue;
                }

                const text = await response.text();
                const parsed = parseGcodeHeader(text);
                if (parsed) {
                    return parsed;
                }
            }

            return null;
        } catch (err) {
            // Silently fail - metadata is optional
            return null;
        }
    }

    function parseGcodeHeader(text) {
        if (!text) return null;

        const meta = {};
        const lines = text.split(/\r?\n/).slice(0, 500);
        const numberFromLine = (line, regex) => {
            const match = line.match(regex);
            if (!match) return null;
            const num = Number(match[1]);
            return Number.isFinite(num) ? num : null;
        };

        for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line.startsWith(';')) continue;

            const lower = line.toLowerCase();
            meta.layer_height = meta.layer_height ?? numberFromLine(lower, /layer[_ ]?height[:=]\s*([\d.]+)/i);
            meta.first_layer_height = meta.first_layer_height ?? numberFromLine(lower, /first[_ ]?layer[_ ]?height[:=]\s*([\d.]+)/i);
            meta.layer_count = meta.layer_count ?? numberFromLine(lower, /layer[_ ]?(?:count|total|totals?)[:=]\s*([\d]+)/i);
            meta.layer_count = meta.layer_count ?? numberFromLine(lower, /total[_ ]?layers?[:=]\s*([\d]+)/i);
            meta.estimated_time = meta.estimated_time ?? numberFromLine(lower, /(?:estimated[_ ]?time|estimated[_ ]?print[_ ]?time|print[_ ]?time)[:=]\s*([\d.]+)/i);
            meta.estimated_time = meta.estimated_time ?? numberFromLine(lower, /;time[:=]\s*([\d.]+)/i);
            const heightVal = numberFromLine(lower, /(?:maxz|height|object[_ ]?height)[:=]\s*([\d.]+)/i);
            if (heightVal !== null) {
                meta.object_height = meta.object_height ?? heightVal;
            }
        }

        if (!meta.object_height && meta.layer_height && meta.layer_count) {
            meta.object_height = meta.layer_height * meta.layer_count;
        }

        if (meta.layer_height || meta.first_layer_height || meta.layer_count || meta.object_height) {
            return meta;
        }

        return null;
    }

    function normalizeFilename(filename) {
        if (!filename) return null;
        let name = filename.replace(/^~\//, '')
                           .replace(/^printer_data\//, '')
                           .replace(/^gcode_files\//, '')
                           .replace(/^files\//, '');

        if (!name.startsWith('gcodes/')) {
            name = name.replace(/^gcodes\//, 'gcodes/');
            if (!name.startsWith('gcodes/')) {
                name = `gcodes/${name}`;
            }
        }

        return name;
    }

    function formatFilename(filename) {
        if (!filename) return null;
        const normalized = filename.split('/').pop();
        const withoutExt = normalized.replace(/\.gcode$/i, '');
        return withoutExt;
    }

    function updateDebug(info) {
        if (!DEBUG) return;
        const el = document.getElementById('debugInfo');
        if (!el) return;

        if (info?.error) {
            el.textContent = `ERROR: ${info.error}`;
            el.classList.remove('hidden');
            return;
        }

        const lines = [];
        lines.push(`state=${info.state}`);
        lines.push(`progress=${(info.progress ?? 0) * 100}%`);
        lines.push(`filename=${info.filename}`);
        lines.push(`toolheadZ=${info.toolheadZ}`);

        const slicerInfo = info.slicerInfo || {};
        lines.push(`slicer: current=${slicerInfo.current_layer ?? slicerInfo.currentLayer ?? slicerInfo.layer_current ?? slicerInfo.layer ?? 'null'} total=${slicerInfo.total_layer ?? slicerInfo.totalLayer ?? slicerInfo.layer_count ?? slicerInfo.layerTotal ?? slicerInfo.totalLayers ?? 'null'}`);

        const meta = info.metadata || {};
        const metaKeys = meta.data ? Object.keys(meta.data).filter(k => !k.startsWith('_')).join(',') : 'none';
        lines.push(`metadata: source=${meta.source || 'none'} filename=${meta.filename || 'n/a'} keys=${metaKeys}`);

        const mLayer = info.metadataLayer || {};
        lines.push(`metadataLayer: current=${mLayer.current ?? 'null'} total=${mLayer.total ?? 'null'}`);

        const pLayer = info.progressLayer || {};
        lines.push(`progressLayer: current=${pLayer.current ?? 'null'} total=${pLayer.total ?? 'null'}`);

        lines.push(`chosen: current=${info.currentLayer ?? 'null'} total=${info.totalLayer ?? 'null'}`);
        lines.push(`estimateRemaining=${info.estimateRemaining ?? 'null'}`);
        lines.push(`slicerRemaining=${info.slicerRemaining ?? 'null'} total=${info.slicerTotal ?? 'null'}`);

        el.textContent = lines.join('\n');
        el.classList.remove('hidden');
    }

    fetchPrintStatus();
    setInterval(fetchPrintStatus, UPDATE_INTERVAL);
})();
