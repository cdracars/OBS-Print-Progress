/**
 * OBS Print Progress Overlay for Klipper/Moonraker
 * 
 * Displays real-time 3D printer status including:
 * - Print progress percentage and progress bar
 * - Current/total layer information
 * - Hotend, bed, and optional chamber temperatures
 * - Time estimates (progress-based, slicer estimate, elapsed time)
 * - Live camera feed
 * - G-code thumbnail preview
 * 
 * Features:
 * - Multi-printer support via printers.json
 * - Automatic metadata extraction from G-code files
 * - Fallback layer/time calculations from filenames
 * - Theme system with CSS variables
 * - Automatic chamber temperature detection
 * - Debug mode for troubleshooting
 */

(async function () {
    // ============================================================
    // UTILITY FUNCTIONS (must be defined first due to hoisting)
    // ============================================================

    /**
     * Parse various boolean representations to actual boolean
     * Handles: true/false, 1/0, yes/no, string/boolean types
     */
    function parseBool(val) {
        if (val === undefined || val === null) return false;
        if (typeof val === 'boolean') return val;
        const str = String(val).toLowerCase();
        return str === 'true' || str === '1' || str === 'yes';
    }

    const body = document.body || document.documentElement;

    // ============================================================
    // CONFIGURATION VARIABLES
    // ============================================================

    let PRINTER_IP = body.dataset.printerIp || 'localhost';
    let PRINTER_NAME = body.dataset.printerName || 'Printer';
    let UPDATE_INTERVAL = Number(body.dataset.updateInterval) || 2000;  // Polling interval in ms
    let DEBUG = parseBool(body.dataset.debug || 'false');
    let CAMERA_URL = body.dataset.cameraUrl || '';
    let CAMERA_FLIP_X = parseBool(body.dataset.cameraFlipX || 'false');  // Mirror horizontally
    let CAMERA_FLIP_Y = parseBool(body.dataset.cameraFlipY || 'false');  // Flip vertically
    let SHOW_CHAMBER = parseBool(body.dataset.chamberEnabled || body.dataset.showChamber || 'false');

    // ============================================================
    // METADATA CACHE
    // ============================================================

    const metadataCache = {
        filename: null,
        data: null,
        source: null
    };

    // ============================================================
    // CHAMBER TEMPERATURE DETECTION
    // ============================================================

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

    // ============================================================
    // CONFIGURATION FUNCTIONS
    // ============================================================

    function applyConfig(cfg) {
        const b = body;
        const config = cfg || {};

        PRINTER_NAME = config.name || config.label || b.dataset.printerName || 'Printer';
        PRINTER_IP = config.ip || config.host || b.dataset.printerIp || 'localhost';
        CAMERA_URL = config.camera || '';
        CAMERA_FLIP_X = parseBool(config.flipHorizontal ?? b.dataset.cameraFlipX ?? 'false');
        CAMERA_FLIP_Y = parseBool(config.flipVertical ?? b.dataset.cameraFlipY ?? 'false');
        SHOW_CHAMBER = parseBool(config.showChamber ?? b.dataset.chamberEnabled ?? b.dataset.showChamber ?? 'false');
        UPDATE_INTERVAL = Number(config.updateInterval || config.intervalMs || b.dataset.updateInterval || 2000) || 2000;
        DEBUG = parseBool(config.debug ?? b.dataset.debug ?? 'false');

        console.log('[OBS Print Progress] DEBUG mode:', DEBUG);
        if (DEBUG) {
            console.log('[OBS Print Progress] Config loaded:', {
                name: PRINTER_NAME,
                ip: PRINTER_IP,
                camera: CAMERA_URL,
                showChamber: SHOW_CHAMBER,
                interval: UPDATE_INTERVAL
            });
        }

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

    function validateConfig(config, isFromList = false) {
        const errors = [];

        if (!config || typeof config !== 'object') {
            errors.push('Configuration must be an object');
            return { valid: false, errors };
        }

        if (isFromList) {
            if (!config.id || typeof config.id !== 'string' || !config.id.trim()) {
                errors.push('Printer configuration missing required "id" field');
            }
        }

        if (!config.name && !config.label) {
            errors.push('Printer configuration missing "name" field');
        }

        if (!config.ip && !config.host) {
            errors.push('Printer configuration missing "ip" field (IP address or hostname)');
        } else {
            const ip = config.ip || config.host;
            if (typeof ip !== 'string' || !ip.trim()) {
                errors.push('Printer "ip" must be a non-empty string');
            }
        }

        if (config.updateInterval !== undefined) {
            const interval = Number(config.updateInterval);
            if (!Number.isFinite(interval) || interval < 500 || interval > 60000) {
                errors.push('updateInterval must be between 500 and 60000 milliseconds');
            }
        }

        return { valid: errors.length === 0, errors };
    }

    function validatePrinterList(printerList) {
        if (!Array.isArray(printerList)) {
            return { valid: false, errors: ['printers.json must contain a "printers" array'], validConfigs: [] };
        }
        if (printerList.length === 0) {
            return { valid: false, errors: ['printers.json "printers" array is empty'], validConfigs: [] };
        }

        const allErrors = [];
        const validConfigs = [];
        const ids = new Set();

        printerList.forEach((config, index) => {
            const result = validateConfig(config, true);

            if (!result.valid) {
                result.errors.forEach(err => allErrors.push(`Printer #${index + 1}: ${err}`));
            } else {
                if (ids.has(config.id)) {
                    allErrors.push(`Printer #${index + 1}: Duplicate id "${config.id}"`);
                } else {
                    ids.add(config.id);
                    validConfigs.push(config);
                }
            }
        });

        return { valid: allErrors.length === 0 && validConfigs.length > 0, errors: allErrors, validConfigs };
    }

    async function loadConfig() {
        const query = new URLSearchParams(window.location.search);
        const key = (
            query.get('printer') ||
            query.get('printers') ||
            query.get('id') ||
            query.get('name') ||
            ''
        ).toLowerCase();

        console.log('[OBS Print Progress] Loading config for printer key:', key || '(default/first)');

        const queryOverride = parseQueryConfig(query);
        if (queryOverride) console.log('[OBS Print Progress] Query params found:', queryOverride);

        const list = await fetchPrinterList();
        if (DEBUG) console.log('[OBS Print Progress] Printer list loaded:', list);

        if (list && list.length) {
            const found = selectConfig(list, key);
            const base = found || list[0];
            const merged = { ...base, ...queryOverride };
            if (DEBUG) console.log('[OBS Print Progress] Final config:', merged);
            return merged;
        }

        if (queryOverride && queryOverride.ip) return queryOverride;
        if (window.PRINTER_CONFIG) return { ...window.PRINTER_CONFIG, ...queryOverride };
        return queryOverride || null;
    }

    async function fetchPrinterList() {
        const inlineList = readInlinePrinterList();
        if (inlineList) {
            const validation = validatePrinterList(inlineList);
            if (!validation.valid) showConfigError(`Configuration errors:\n${validation.errors.join('\n')}`);
            return validation.validConfigs.length > 0 ? validation.validConfigs : inlineList;
        }

        const globalList = readGlobalPrinterList();
        if (globalList) {
            const validation = validatePrinterList(globalList);
            if (!validation.valid) showConfigError(`Configuration errors:\n${validation.errors.join('\n')}`);
            return validation.validConfigs.length > 0 ? validation.validConfigs : globalList;
        }

        const main = await fetchJsonConfig('printers.json');
        if (main) {
            const validation = validatePrinterList(main);
            if (!validation.valid) showConfigError(`Configuration errors in printers.json:\n${validation.errors.join('\n')}`);
            return validation.validConfigs.length > 0 ? validation.validConfigs : main;
        }

        const example = await fetchJsonConfig('printers.json.example');
        if (example) {
            const validation = validatePrinterList(example);
            return validation.validConfigs.length > 0 ? validation.validConfigs : example;
        }

        return null;
    }

    async function fetchJsonConfig(path) {
        const url = new URL(path, window.location.href).href;

        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 2000);
            const resp = await fetch(url, { signal: controller.signal });
            clearTimeout(timeout);

            if (resp.ok) {
                const json = await resp.json();
                if (Array.isArray(json)) return json;
                if (Array.isArray(json.printers)) return json.printers;
            }
        } catch (err) {
            // ignore
        }

        if (location.protocol === 'file:') {
            try {
                const json = await loadJsonViaXhr(url);
                if (Array.isArray(json)) return json;
                if (Array.isArray(json?.printers)) return json.printers;
            } catch {
                // ignore
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
            } catch {
                // ignore
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
                        resolve(JSON.parse(xhr.responseText));
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
        if (printerNameEl) printerNameEl.textContent = PRINTER_NAME;
    }

    function setupCamera() {
        const cameraEl = document.getElementById('cameraFeed');
        if (!cameraEl) return;

        if (CAMERA_URL) {
            let retryCount = 0;
            const maxRetries = 3;

            const loadCamera = () => {
                cameraEl.src = CAMERA_URL + (retryCount > 0 ? `?retry=${retryCount}&t=${Date.now()}` : '');
                cameraEl.classList.remove('hidden');
                const flips = [];
                if (CAMERA_FLIP_X) flips.push('scaleX(-1)');
                if (CAMERA_FLIP_Y) flips.push('scaleY(-1)');
                cameraEl.style.transform = flips.join(' ');
            };

            cameraEl.onload = () => cameraEl.classList.add('loaded');

            cameraEl.onerror = () => {
                cameraEl.classList.remove('loaded');
                retryCount++;
                if (retryCount <= maxRetries) {
                    const delay = Math.min(1000 * Math.pow(2, retryCount - 1), 8000);
                    setTimeout(loadCamera, delay);
                }
            };

            loadCamera();
        } else {
            cameraEl.classList.add('hidden');
        }
    }

    // ============================================================
    // INIT
    // ============================================================

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

        // start polling ONCE
        fetchPrintStatus();
        setInterval(fetchPrintStatus, UPDATE_INTERVAL);

        // non-blocking chamber update
        updateChamber();
    }

    // ============================================================
    // THUMBNAIL
    // ============================================================

    async function extractThumbnailFromGcode(filename) {
        try {
            const path = normalizeFilename(filename);
            if (!path) return null;

            const url = `http://${PRINTER_IP}/server/files/gcodes/${encodeURI(path)}`;
            if (DEBUG) console.log('[OBS Print Progress] Thumbnail URL:', url);

            const resp = await fetch(url, { headers: { Range: "bytes=0-100000" } });
            if (!resp.ok) return null;

            const text = await resp.text();
            const blockRegex = /; thumbnail begin \d+x\d+ \d+([\s\S]*?); thumbnail end/g;

            let match;
            let lastBlock = null;
            while ((match = blockRegex.exec(text)) !== null) {
                const b64 = match[1]
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
        if (fileLabel) fileLabel.textContent = "--";
    }

    // ============================================================
    // API RETRY
    // ============================================================

    let apiRetryCount = 0;
    const maxApiRetries = 5;
    let apiRetryTimeout = null;

    // ============================================================
    // MAIN STATUS FETCH
    // ============================================================

    async function fetchPrintStatus() {
        try {
            const response = await fetch(
                `http://${PRINTER_IP}/printer/objects/query?display_status&print_stats&virtual_sdcard&extruder&heater_bed&toolhead`
            );

            if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);

            apiRetryCount = 0;

            const data = await response.json();
            const status = data.result.status;

            const printStats = status.print_stats;
            const displayStatus = status.display_status;
            const virtualSdcard = status.virtual_sdcard;
            const extruder = status.extruder;
            const heaterBed = status.heater_bed;
            const toolhead = status.toolhead;

            await ensureMetadataLoaded(printStats.filename, printStats.state);

            // temps
            if (extruder) {
                const hotendTemp = Math.round(extruder.temperature);
                const hotendTarget = Math.round(extruder.target);
                const el = document.getElementById('hotendTemp');
                if (el) el.textContent = `${hotendTemp}\u00B0C / ${hotendTarget}\u00B0C`;
            }

            if (heaterBed) {
                const bedTemp = Math.round(heaterBed.temperature);
                const bedTarget = Math.round(heaterBed.target);
                const el = document.getElementById('bedTemp');
                if (el) el.textContent = `${bedTemp}\u00B0C / ${bedTarget}\u00B0C`;
            }

            // OPTIONAL: motion_report for speed/flow (safe if unsupported)
            await updateMotionStats(extruder);

            await updateChamber();

            // state
            const statusElement = document.getElementById('status');
            const state = printStats.state;
            if (statusElement) {
                statusElement.textContent = state.charAt(0).toUpperCase() + state.slice(1);
            }

            if (state === 'printing') {
                if (statusElement) statusElement.className = 'status-pill ok';

                const rawProgress = virtualSdcard?.progress ?? displayStatus?.progress ?? 0;

                if (DEBUG) {
                    console.log('[OBS Print Progress] Progress values:', {
                        virtualSdcard_progress: virtualSdcard?.progress,
                        displayStatus_progress: displayStatus?.progress,
                        file_position: virtualSdcard?.file_position,
                        file_size: virtualSdcard?.file_size,
                        using_progress: rawProgress,
                        percentage: Math.round(rawProgress * 100)
                    });
                }

                const progress = Math.max(0, Math.min(1, Number(rawProgress) || 0));
                const percentage = Math.round(progress * 100);

                const bar = document.getElementById('progressBar');
                const pct = document.getElementById('percentage');
                if (bar) bar.style.width = percentage + '%';
                if (pct) pct.textContent = percentage + '%';

                const { currentLayer, totalLayer } = getLayerInfo(printStats, displayStatus, toolhead);
                const layerEl = document.getElementById('layerInfo');
                if (layerEl) layerEl.textContent = formatLayerInfo(currentLayer, totalLayer);

                const printDuration = printStats.print_duration || 0;
                const estimateRemaining = computeRemainingFromProgress(progress, printDuration);

                const slicerTotal = getSlicerTotalSeconds(metadataCache.data, printStats.info);
                const slicerRemaining = slicerTotal != null ? Math.max(0, slicerTotal - printDuration) : null;

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

                const fileEl = document.getElementById('filename');
                if (fileEl) fileEl.textContent = formatFilename(printStats.filename) || 'Unknown';

                // thumbnail
                const thumbEl = document.getElementById("thumbnail");
                const previewContainer = document.getElementById("previewFloating");

                if (thumbEl) {
                    const normalized = normalizeFilename(printStats.filename);
                    const loadedFor = thumbEl.dataset.loadedFor || "";

                    if (normalized && loadedFor !== normalized) {
                        thumbEl.dataset.loadedFor = normalized;
                        thumbEl.style.display = "none";
                        if (previewContainer) previewContainer.classList.remove('loaded');

                        extractThumbnailFromGcode(normalized).then(b64 => {
                            if (b64 && b64.length > 100) {
                                thumbEl.src = `data:image/png;base64,${b64}`;
                                thumbEl.style.display = "block";
                                if (previewContainer) previewContainer.classList.add('loaded');

                                const fileLabel = document.getElementById("thumbnailFilename");
                                if (fileLabel) fileLabel.textContent = printStats.filename || "--";
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
                if (statusElement) statusElement.className = 'status-pill idle';

                const layerEl = document.getElementById('layerInfo');
                if (layerEl) layerEl.textContent = '--';

                const slicerTotal = getSlicerTotalSeconds(metadataCache.data, printStats.info);
                setTimeValue('timeEstimate', null);
                setTimeValue('timeSlicer', slicerTotal);
                setTimeValue('timeTotal', getElapsedTime(printStats));
                hideThumbnail();

            } else {
                if (statusElement) statusElement.className = 'status-pill idle';

                const bar = document.getElementById('progressBar');
                const pct = document.getElementById('percentage');
                if (bar) bar.style.width = '0%';
                if (pct) pct.textContent = '0%';

                const slicerTotal = getSlicerTotalSeconds(metadataCache.data, printStats.info);
                setTimeValue('timeEstimate', null);
                setTimeValue('timeSlicer', slicerTotal);
                setTimeValue('timeTotal', null);

                const layerEl = document.getElementById('layerInfo');
                const fileEl = document.getElementById('filename');
                if (layerEl) layerEl.textContent = '--';
                if (fileEl) fileEl.textContent = '--';
                hideThumbnail();
            }

        } catch (error) {
            const statusEl = document.getElementById('status');
            if (statusEl) statusEl.className = 'status-pill error';

            const isNetworkError =
                error.message?.includes('Failed to fetch') ||
                error.message?.includes('NetworkError') ||
                error.message?.includes('TypeError');

            if (isNetworkError && apiRetryCount < maxApiRetries) {
                apiRetryCount++;
                const delay = Math.min(2000 * Math.pow(2, apiRetryCount - 1), 30000);

                if (statusEl) statusEl.textContent = `Retrying... (${apiRetryCount}/${maxApiRetries})`;
                console.warn(`[OBS Print Progress] API failed, retrying in ${delay}ms (${apiRetryCount}/${maxApiRetries})`);

                if (apiRetryTimeout) clearTimeout(apiRetryTimeout);
                apiRetryTimeout = setTimeout(() => fetchPrintStatus(), delay);
                return;
            }

            if (statusEl) {
                if (error.message?.includes('HTTP 401') || error.message?.includes('HTTP 403')) {
                    statusEl.textContent = 'Authentication Error';
                } else if (error.message?.includes('HTTP 404')) {
                    statusEl.textContent = 'API Not Found';
                } else {
                    statusEl.textContent = `Unreachable: ${PRINTER_IP}`;
                }
            }

            updateDebug({ error: error?.message || String(error), retries: apiRetryCount });
            hideThumbnail();
        }
    }

    /**
     * OPTIONAL motion_report: updates #print-speed and #print-flow if present
     * Safe if motion_report isn't supported (it will silently do nothing).
     */
    async function updateMotionStats(extruder) {
        const speedEl = document.getElementById("print-speed");
        const flowEl = document.getElementById("print-flow");
        if (!speedEl && !flowEl) return;

        try {
            const mrResp = await fetch(`http://${PRINTER_IP}/printer/objects/query?motion_report`);
            if (!mrResp.ok) return;

            const mrJson = await mrResp.json();
            const motionReport = mrJson?.result?.status?.motion_report ?? null;
            if (!motionReport || motionReport.live_velocity === undefined) return;

            const speedMmS = Math.round(motionReport.live_velocity);

            if (speedEl) speedEl.textContent = `${speedMmS} mm/s`;

            if (flowEl && extruder) {
                const extrudeFactor = extruder.extrude_factor ?? 1.0;
                const nozzleDiameter =
                    metadataCache?.data?.nozzle_diameter ??
                    metadataCache?.data?.nozzle ??
                    0.4;

                const nozzleArea = Math.PI * Math.pow(nozzleDiameter / 2, 2);
                const flow = speedMmS * nozzleArea * extrudeFactor;

                flowEl.textContent = `${flow.toFixed(1)} mm³/s`;
            }
        } catch {
            // ignore
        }
    }

    // ============================================================
    // CONFIG ERROR DISPLAY
    // ============================================================

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

    // ============================================================
    // CHAMBER TEMP
    // ============================================================

    async function updateChamber() {
        const chamberChip = document.getElementById('chamberChip');
        if (!chamberChip) return;

        const temps = await fetchChamberTemp();
        const chamberTempEl = document.getElementById('chamberTemp');

        if (temps) {
            chamberChip.classList.remove('hidden');
            if (chamberTempEl) chamberTempEl.textContent = `${temps.current}\u00B0C / ${temps.target}\u00B0C`;
        } else if (SHOW_CHAMBER) {
            chamberChip.classList.remove('hidden');
            if (chamberTempEl) chamberTempEl.textContent = '--';
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

        for (const obj of chamberCandidates) {
            const data = await querySingleObject(obj);
            const parsed = parseTempEntry(data);
            if (parsed) {
                chamberObjectName = obj;
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
                chamberObjectName = objects[idx];
                return chamberObjectName;
            }
        }
        return null;
    }

    async function fetchObjectList() {
        const now = Date.now();
        if (objectListCache && now - objectListFetchedAt < 30000) return objectListCache;

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
        } catch {
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
        const target = targetRaw !== undefined && targetRaw !== null
            ? Math.round(targetRaw)
            : Math.round(entry.temperature ?? entry.temp ?? 0);
        if (!Number.isFinite(current)) return null;
        return { current, target: Number.isFinite(target) ? target : current };
    }

    // ============================================================
    // LAYERS + TIME
    // ============================================================

    function formatLayerInfo(current, total) {
        const hasCurrent = current !== null && current !== undefined && current > 0;
        const hasTotal = total !== null && total !== undefined && total > 0;

        if (!hasCurrent && !hasTotal) return '--';
        if (hasCurrent && hasTotal) return `${current} / ${total}`;
        if (hasCurrent) return `${current} / --`;
        return `-- / ${total}`;
    }

    function formatTime(seconds) {
        if (!seconds || seconds < 0) return '--';

        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = Math.floor(seconds % 60);

        if (hours > 0) return `${hours}h ${minutes}m`;
        if (minutes > 0) return `${minutes}m ${secs}s`;
        return `${secs}s`;
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
            if (num && num > 0) return num;
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

        let fallbackCurrent = null;
        const currentZ = toolhead?.position?.[2];
        if (currentZ !== undefined && currentZ !== null && currentZ > 0 && !metadataLayer.current) {
            fallbackCurrent = Math.max(1, Math.floor(currentZ / 0.2));
        }

        return {
            currentLayer: firstNonNull(slicerCurrent, metadataLayer.current, progressLayer.current, fallbackCurrent),
            totalLayer: firstNonNull(slicerTotal, metadataLayer.total, progressLayer.total)
        };
    }

    function computeLayerFromMetadata(toolhead, metadata) {
        if (!metadata) return { current: null, total: null };

        const layerHeight = metadata.layer_height;
        const firstLayerHeight = metadata.first_layer_height || layerHeight;
        const objectHeight = metadata.object_height;
        const layerCount = asNumber(metadata.layer_count ?? metadata.total_layer ?? metadata.total_layers);
        const currentZ = toolhead?.position?.[2];

        let total = layerCount || null;
        if (!total && layerHeight && objectHeight) {
            total = Math.max(1, Math.round(((objectHeight - firstLayerHeight) / layerHeight) + 1));
        }

        let current = null;
        if (layerHeight && currentZ !== undefined && currentZ !== null) {
            const calc = Math.floor(((currentZ - firstLayerHeight) / layerHeight) + 1);
            current = Math.max(1, calc);
            if (total) current = Math.min(total, current);
        }

        return { current, total };
    }

    function computeLayerFromProgress(displayStatus, metadata) {
        if (!metadata) return { current: null, total: null };

        const total = asNumber(metadata.layer_count ?? metadata.total_layer ?? metadata.total_layers);
        const progress = typeof displayStatus?.progress === 'number' ? displayStatus.progress : null;

        if (!total || progress === null || progress <= 0) {
            return { current: null, total: total || null };
        }

        const current = Math.max(1, Math.min(total, Math.round(progress * total)));
        return { current, total };
    }

    function firstNonNull(...values) {
        for (const value of values) {
            if (value !== null && value !== undefined) return value;
        }
        return null;
    }

    function asNumber(value) {
        const num = Number(value);
        return Number.isFinite(num) ? num : null;
    }

    // ============================================================
    // METADATA
    // ============================================================

    async function ensureMetadataLoaded(filename, state) {
        if (state !== 'printing' || !filename) return;
        if (metadataCache.filename === filename && metadataCache.data) return;

        metadataCache.filename = filename;
        const metaResult = await fetchMetadata(filename);
        metadataCache.data = metaResult?.data || null;
        metadataCache.source = metaResult?.source || null;

        if (metadataCache.data && !metadataCache.data.layer_height) {
            const filenameMatch = filename.match(/[_\s\.]0\.(\d+)(?:[_\s\.]|mm|$)/i);
            if (filenameMatch) {
                const inferredHeight = Number(`0.${filenameMatch[1]}`);
                if (inferredHeight >= 0.05 && inferredHeight <= 0.5) {
                    metadataCache.data.layer_height = inferredHeight;
                    if (metadataCache.data.object_height && !metadataCache.data.layer_count) {
                        const firstLayer = metadataCache.data.first_layer_height || inferredHeight;
                        metadataCache.data.layer_count = Math.max(
                            1,
                            Math.round(((metadataCache.data.object_height - firstLayer) / inferredHeight) + 1)
                        );
                    }
                }
            }
        }

        if (metadataCache.data && !metadataCache.data.estimated_time) {
            const timeMatch = filename.match(/(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?/i);
            if (timeMatch && (timeMatch[1] || timeMatch[2] || timeMatch[3])) {
                let seconds = 0;
                if (timeMatch[1]) seconds += parseInt(timeMatch[1], 10) * 86400;
                if (timeMatch[2]) seconds += parseInt(timeMatch[2], 10) * 3600;
                if (timeMatch[3]) seconds += parseInt(timeMatch[3], 10) * 60;
                if (seconds > 0) metadataCache.data.estimated_time = seconds;
            }
        }
    }

    async function fetchMetadata(filename) {
        try {
            const fileParam = normalizeFilename(filename);
            if (!fileParam) return null;

            const apiMeta = await fetchMetadataFromApi(fileParam);
            if (apiMeta) return { data: apiMeta, source: 'api' };

            const headerMeta = await fetchMetadataFromGcode(fileParam);
            if (headerMeta) return { data: headerMeta, source: 'gcode-header' };

            return null;
        } catch (err) {
            console.error('Error fetching metadata:', err);
            return null;
        }
    }

    async function fetchMetadataFromApi(fileParam) {
        try {
            const url = `http://${PRINTER_IP}/server/files/metadata?filename=${encodeURIComponent(fileParam)}`;
            const response = await fetch(url, { method: 'GET', cache: 'no-cache' });
            if (response.ok) {
                const data = await response.json();
                return data.result;
            }
        } catch {
            // ignore
        }
        return null;
    }

    async function fetchMetadataFromGcode(fileParam) {
        try {
            const safePath = encodeURI(fileParam);
            const url = `http://${PRINTER_IP}/server/files/${safePath}`;

            const response = await fetch(url, { headers: { Range: 'bytes=0-65535' } });
            if (!response.ok) return null;

            const text = await response.text();
            return parseGcodeHeader(text);
        } catch {
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

            meta.layer_height = meta.layer_height ?? numberFromLine(lower, /layer[_ ]?height[:=\s]\s*([\d.]+)/i);
            meta.layer_height = meta.layer_height ?? numberFromLine(lower, /;\s*layer_height\s*=\s*([\d.]+)/i);

            meta.first_layer_height = meta.first_layer_height ?? numberFromLine(lower, /first[_ ]?layer[_ ]?height[:=\s]\s*([\d.]+)/i);
            meta.first_layer_height = meta.first_layer_height ?? numberFromLine(lower, /initial[_ ]?layer[_ ]?height[:=\s]\s*([\d.]+)/i);

            meta.layer_count = meta.layer_count ?? numberFromLine(lower, /layer[_ ]?(?:count|total|totals?)[:=\s]\s*([\d]+)/i);
            meta.layer_count = meta.layer_count ?? numberFromLine(lower, /total[_ ]?layers?[:=\s]\s*([\d]+)/i);
            meta.layer_count = meta.layer_count ?? numberFromLine(lower, /;\s*total_layer_count\s*=\s*([\d]+)/i);

            meta.estimated_time = meta.estimated_time ?? numberFromLine(lower, /(?:estimated[_ ]?time|estimated[_ ]?print[_ ]?time|print[_ ]?time)[:=\s]\s*([\d.]+)/i);
            meta.estimated_time = meta.estimated_time ?? numberFromLine(lower, /;time[:=\s]\s*([\d.]+)/i);
            meta.estimated_time = meta.estimated_time ?? numberFromLine(lower, /;\s*estimated_printing_time\(normal\)\s*=\s*([\d.]+)/i);

            const heightVal = numberFromLine(lower, /(?:maxz|max_z|height|object[_ ]?height)[:=\s]\s*([\d.]+)/i);
            if (heightVal !== null) meta.object_height = meta.object_height ?? heightVal;
        }

        if (!meta.object_height && meta.layer_height && meta.layer_count) {
            meta.object_height = meta.layer_height * meta.layer_count;
        }

        if (meta.object_height && meta.layer_height && !meta.layer_count) {
            const firstLayer = meta.first_layer_height || meta.layer_height;
            meta.layer_count = Math.max(1, Math.round(((meta.object_height - firstLayer) / meta.layer_height) + 1));
        }

        if (meta.layer_height || meta.first_layer_height || meta.layer_count || meta.object_height) return meta;
        return null;
    }

    function normalizeFilename(filename) {
        if (!filename) return null;
        return filename;
    }

    function formatFilename(filename) {
        if (!filename) return null;
        const normalized = filename.split('/').pop();
        return normalized.replace(/\.gcode$/i, '');
    }

    // ============================================================
    // DEBUG
    // ============================================================

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

})();
