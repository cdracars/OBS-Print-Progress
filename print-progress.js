/* Reusable printer overlay logic.
   Configure via body data attributes:
   - data-printer-ip
   - data-printer-name
   - data-update-interval (ms)
   - data-debug (true/false)
*/

(function () {
    const body = document.body || document.documentElement;
    const PRINTER_IP = body.dataset.printerIp || 'localhost';
    const PRINTER_NAME = body.dataset.printerName || 'Printer';
    const UPDATE_INTERVAL = Number(body.dataset.updateInterval) || 2000;
    const DEBUG = (body.dataset.debug || '').toLowerCase() === 'true';
    const CAMERA_URL = body.dataset.cameraUrl || '';
    const PRINTER_TYPE = (body.dataset.printerType || 'moonraker').toLowerCase();
    const STATUS_URL = body.dataset.statusUrl || '';

    // Set printer name on load
    const printerNameEl = document.getElementById('printerName');
    if (printerNameEl) {
        printerNameEl.textContent = PRINTER_NAME;
    }

    const cameraEl = document.getElementById('cameraFeed');
    if (cameraEl) {
        if (CAMERA_URL) {
            cameraEl.src = CAMERA_URL;
        } else {
            cameraEl.classList.add('hidden');
        }
    }

    const metadataCache = {
        filename: null,
        data: null,
        source: null
    };

    async function fetchPrintStatus() {
        if (PRINTER_TYPE === 'bambu') {
            return fetchBambuStatus();
        }
        return fetchMoonrakerStatus();
    }

    async function fetchMoonrakerStatus() {
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
            
            const statusElement = document.getElementById('status');
            const state = printStats.state;
            statusElement.textContent = state.charAt(0).toUpperCase() + state.slice(1);
            
            if (state === 'printing') {
                statusElement.className = 'status-pill ok';
                
                const progress = displayStatus.progress ?? virtualSdcard.progress ?? 0;
                const percentage = Math.round(progress * 100);
                document.getElementById('progressBar').style.width = percentage + '%';
                document.getElementById('percentage').textContent = percentage + '%';
                
                const { currentLayer, totalLayer } = getLayerInfo(printStats, displayStatus, toolhead);
                document.getElementById('layerInfo').textContent = formatLayerInfo(currentLayer, totalLayer);
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
                    progressLayer: computeLayerFromProgress(displayStatus, metadataCache.data)
                });
                
                const printDuration = printStats.print_duration || 0;
                if (progress > 0 && progress < 1) {
                    const totalTime = printDuration / progress;
                    const remaining = totalTime - printDuration;
                    document.getElementById('timeRemaining').textContent = formatTime(remaining);
                } else {
                    document.getElementById('timeRemaining').textContent = '--';
                }
                
                document.getElementById('filename').textContent = printStats.filename || 'Unknown';
                
            } else if (state === 'paused') {
                statusElement.className = 'status-pill idle';
                document.getElementById('layerInfo').textContent = '--';
            } else {
                statusElement.className = 'status-pill idle';
                document.getElementById('progressBar').style.width = '0%';
                document.getElementById('percentage').textContent = '0%';
                document.getElementById('timeRemaining').textContent = '--';
                document.getElementById('layerInfo').textContent = '--';
                document.getElementById('filename').textContent = '--';
            }
            
        } catch (error) {
            document.getElementById('status').textContent = 'Connection Error';
            document.getElementById('status').className = 'status-pill error';
            console.error('Error fetching print status:', error);
            updateDebug({ error: error?.message || String(error) });
        }
    }

    async function fetchBambuStatus() {
        try {
            const url = STATUS_URL || `http://${PRINTER_IP}/status`;
            const response = await fetch(url, { cache: 'no-store' });
            const payload = await response.json();

            const source = payload.data || payload.pushing || payload;
            const print = source.print || source;
            if (!print || typeof print !== 'object' || Object.keys(print).length === 0) {
                document.getElementById('status').textContent = 'Waiting...';
                document.getElementById('status').className = 'status-pill idle';
                document.getElementById('progressBar').style.width = '0%';
                document.getElementById('percentage').textContent = '0%';
                document.getElementById('timeRemaining').textContent = '--';
                document.getElementById('layerInfo').textContent = '--';
                document.getElementById('filename').textContent = '--';
                document.getElementById('hotendTemp').textContent = '--';
                document.getElementById('bedTemp').textContent = '--';
                updateDebug({ mode: 'bambu', state: 'waiting', progress: 0, filename: '--', layers: {}, temps: {} });
                return;
            }

            const statusElement = document.getElementById('status');
            const stateRaw = (print.gcode_state || print.mc_print_stage || 'unknown').toString().toLowerCase();
            const state = stateRaw === 'running' && print.mc_print_stage === 0 ? 'prepare' : stateRaw;
            statusElement.textContent = titleCase(state);

            if (state === 'running' || state === 'prepare') {
                statusElement.className = 'status-pill ok';
            } else if (state === 'failed' || state === 'error') {
                statusElement.className = 'status-pill error';
            } else {
                statusElement.className = 'status-pill idle';
            }

            const nozzleTemp = asNumber(print.nozzle_temper ?? print.nozzle_temp);
            const nozzleTarget = asNumber(print.nozzle_target_temper ?? print.target_nozzle_temp);
            if (nozzleTemp !== null && nozzleTarget !== null) {
                document.getElementById('hotendTemp').textContent = `${Math.round(nozzleTemp)}\u00B0C / ${Math.round(nozzleTarget)}\u00B0C`;
            } else {
                document.getElementById('hotendTemp').textContent = '--';
            }

            const bedTemp = asNumber(print.bed_temper ?? print.bed_temp);
            const bedTarget = asNumber(print.bed_target_temper ?? print.target_bed_temp);
            if (bedTemp !== null && bedTarget !== null) {
                document.getElementById('bedTemp').textContent = `${Math.round(bedTemp)}\u00B0C / ${Math.round(bedTarget)}\u00B0C`;
            } else {
                document.getElementById('bedTemp').textContent = '--';
            }

            const isPrinting = state === 'running' || state === 'prepare';
            const progressRaw = isPrinting ? asNumber(print.mc_percent) : 0;
            const progress = normalizePercentage(progressRaw);
            const percentage = Math.round(progress * 100);
            document.getElementById('progressBar').style.width = `${percentage}%`;
            document.getElementById('percentage').textContent = `${percentage}%`;

            const currentLayer = isPrinting ? asNumber(print.layer_num) : null;
            const totalLayer = isPrinting ? asNumber(print.total_layer_num) : null;
            document.getElementById('layerInfo').textContent = formatLayerInfo(currentLayer, totalLayer);

            const remainingMinutes = isPrinting ? asNumber(print.mc_remaining_time) : null;
            const remainingSeconds = remainingMinutes !== null ? remainingMinutes * 60 : null;
            document.getElementById('timeRemaining').textContent = formatTime(remainingSeconds);

            const filename = isPrinting
                ? (print.subtask_name || print.gcode_file || print.gcode_file_downloaded || 'Unknown')
                : 'Idle';
            document.getElementById('filename').textContent = filename;

            updateDebug({
                mode: 'bambu',
                state,
                progress,
                filename,
                temps: { nozzleTemp, nozzleTarget, bedTemp, bedTarget },
                layers: { currentLayer, totalLayer },
                remainingMinutes,
                raw: print
            });
        } catch (error) {
            document.getElementById('status').textContent = 'Connection Error';
            document.getElementById('status').className = 'status-pill error';
            console.error('Error fetching print status:', error);
            updateDebug({ error: error?.message || String(error) });
        }
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

    function normalizePercentage(value) {
        if (value === null || value === undefined) return 0;
        if (value > 1) {
            return Math.max(0, Math.min(1, value / 100));
        }
        return Math.max(0, Math.min(1, value));
    }

    function titleCase(str) {
        if (!str) return '';
        return str.charAt(0).toUpperCase() + str.slice(1);
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
                    console.warn('Metadata API 404/err for', candidate, response.status);
                    continue;
                }
                const data = await response.json();
                return data.result;
            } catch (err) {
                console.error('Error fetching metadata from API:', candidate, err);
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
                    console.warn('Metadata gcode fetch failed', candidate, response.status);
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
            console.error('Error parsing metadata from gcode:', err);
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

    function updateDebug(info) {
        if (!DEBUG) return;
        const el = document.getElementById('debugInfo');
        if (!el) return;

        if (info?.error) {
            el.textContent = `ERROR: ${info.error}`;
            el.classList.remove('hidden');
            return;
        }

        if (info?.mode === 'bambu') {
            const lines = [];
            lines.push(`mode=bambu`);
            lines.push(`state=${info.state}`);
            lines.push(`progress=${Math.round((info.progress ?? 0) * 100)}%`);
            lines.push(`filename=${info.filename}`);
            const temps = info.temps || {};
            lines.push(`temps: nozzle=${temps.nozzleTemp ?? 'n/a'} / ${temps.nozzleTarget ?? 'n/a'} bed=${temps.bedTemp ?? 'n/a'} / ${temps.bedTarget ?? 'n/a'}`);
            const layers = info.layers || {};
            lines.push(`layers: current=${layers.currentLayer ?? 'n/a'} total=${layers.totalLayer ?? 'n/a'}`);
            lines.push(`remainingMin=${info.remainingMinutes ?? 'n/a'}`);
            if (info.raw) {
                lines.push(`keys=${Object.keys(info.raw).join(',')}`);
            }
            el.textContent = lines.join('\n');
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

        el.textContent = lines.join('\n');
        el.classList.remove('hidden');
    }

    fetchPrintStatus();
    setInterval(fetchPrintStatus, UPDATE_INTERVAL);
})();
