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
    const CAMERA_FLIP_X = (body.dataset.cameraFlipX || 'false').toLowerCase() === 'true';
    const CAMERA_FLIP_Y = (body.dataset.cameraFlipY || 'false').toLowerCase() === 'true';
    const SHOW_CHAMBER = (body.dataset.chamberEnabled || body.dataset.showChamber || 'false').toLowerCase() === 'true';

    // Set printer name on load
    const printerNameEl = document.getElementById('printerName');
    if (printerNameEl) {
        printerNameEl.textContent = PRINTER_NAME;
    }

    const cameraEl = document.getElementById('cameraFeed');
    if (cameraEl) {
        if (CAMERA_URL) {
            cameraEl.src = CAMERA_URL;
            const flips = [];
            if (CAMERA_FLIP_X) flips.push('scaleX(-1)');
            if (CAMERA_FLIP_Y) flips.push('scaleY(-1)');
            if (flips.length) {
                cameraEl.style.transform = flips.join(' ');
            }
        } else {
            cameraEl.classList.add('hidden');
        }
    }

    const metadataCache = {
        filename: null,
        data: null,
        source: null
    };

    async function extractThumbnailFromGcode(filename) {
    try {
        // Make sure we have the right path, e.g. "gcodes/Articulated_Lizard_Curl_PLA_3h48m.gcode"
        const path = normalizeFilename(filename);  // uses your existing helper
        if (!path) return null;

        // IMPORTANT: do NOT use encodeURIComponent here, it turns "gcodes/..." into "gcodes%2F..."
        const url = `http://${PRINTER_IP}/server/files/${encodeURI(path)}`;

        const resp = await fetch(url, {
            headers: { Range: "bytes=0-250000" }
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
               // --- Thumbnail (G-code fallback) ---
const thumbEl = document.getElementById("thumbnail");

if (thumbEl) {
    const normalized = normalizeFilename(printStats.filename);
    const loadedFor = thumbEl.dataset.loadedFor || "";

    if (normalized && loadedFor !== normalized) {
        thumbEl.dataset.loadedFor = normalized;

        extractThumbnailFromGcode(normalized).then(b64 => {
            if (b64) {
                thumbEl.src = `data:image/png;base64,${b64}`;
                thumbEl.style.display = "block";

                // 🟩 Update filename under thumbnail
                const fileLabel = document.getElementById("thumbnailFilename");
                if (fileLabel) {
                    fileLabel.textContent = printStats.filename || "--";
                }

            } else {
                thumbEl.src = "";
                thumbEl.style.display = "none";

                const fileLabel = document.getElementById("thumbnailFilename");
                if (fileLabel) {
                    fileLabel.textContent = "--";
                }
            }
        }).catch(err => {
            console.error("Thumbnail load error:", err);
            thumbEl.src = "";
            thumbEl.style.display = "none";

            const fileLabel = document.getElementById("thumbnailFilename");
            if (fileLabel) {
                fileLabel.textContent = "--";
            }
        });
    }
}



            } else if (state === 'paused') {
                statusElement.className = 'status-pill idle';
                document.getElementById('layerInfo').textContent = '--';
                setTimeValue('timeEstimate', null);
                setTimeValue('timeSlicer', null);
                setTimeValue('timeTotal', null);
                hideThumbnail(); // <-- CALL THE NEW FUNCTION
            } else {
                statusElement.className = 'status-pill idle';
                document.getElementById('progressBar').style.width = '0%';
                document.getElementById('percentage').textContent = '0%';
                setTimeValue('timeEstimate', null);
                setTimeValue('timeSlicer', null);
                setTimeValue('timeTotal', null);
                document.getElementById('layerInfo').textContent = '--';
                document.getElementById('filename').textContent = '--';
		hideThumbnail(); // <-- CALL THE NEW FUNCTION
                
               // --- RECOMMENDED: Add thumbnail cleanup for 'paused' state ---
        	const thumbEl = document.getElementById("thumbnail");
        	if (thumbEl) {
           	thumbEl.src = "";
            	thumbEl.style.display = "none";
            	thumbEl.removeAttribute("data-loaded-for"); 
        	}
                const fileLabel = document.getElementById("thumbnailFilename");
                if (fileLabel) {
                    fileLabel.textContent = "--";
                }
                // 🌟 END OF ADDED LOGIC 🌟
            }
            
        } catch (error) {
            document.getElementById('status').textContent = 'Connection Error';
            document.getElementById('status').className = 'status-pill error';
            console.error('Error fetching print status:', error);
            updateDebug({ error: error?.message || String(error) });
	    hideThumbnail();
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
    // Base candidates (lowercase forms)
    const baseCandidates = [
        'temperature_sensor chamber',
        'temperature_sensor chamber_temp',
        'heater_generic chamber'
    ];

    // Generate common capitalization variants of the last word (chamber / chamber_temp)
    function caseVariants(name) {
        const lower = name.toLowerCase();
        const firstUpper = lower.charAt(0).toUpperCase() + lower.slice(1);
        const upper = lower.toUpperCase();
        return [...new Set([lower, firstUpper, upper])];
    }

    // Expand base candidates into multiple capitalization variants
    const expandedCandidates = [];
    for (const obj of baseCandidates) {
        const parts = obj.split(' ');
        if (parts.length < 2) {
            expandedCandidates.push(obj);
            continue;
        }
        const className = parts.slice(0, -1).join(' '); // "temperature_sensor" / "heater_generic"
        const tail = parts[parts.length - 1];           // "chamber" / "chamber_temp"
        for (const variant of caseVariants(tail)) {
            expandedCandidates.push(`${className} ${variant}`);
        }
    }

    // Try each candidate until one returns a valid temperature
    for (const obj of expandedCandidates) {
        try {
            const resp = await fetch(`http://${PRINTER_IP}/printer/objects/query?${encodeURIComponent(obj)}`);
            if (!resp.ok) continue;

            const json = await resp.json();
            const status = json.result?.status;
            if (!status || !Object.keys(status).length) continue;

            const key = Object.keys(status)[0];
            const entry = status[key] || {};

            const currentRaw =
                entry.temperature ??
                entry.temp ??
                entry.current ??
                entry.temper;

            const current = Number.isFinite(currentRaw) ? Math.round(currentRaw) : null;
            if (current === null) continue;

            const targetRaw =
                entry.target ??
                entry.target_temp ??
                entry.target_temperature;

            const target = Number.isFinite(targetRaw)
                ? Math.round(targetRaw)
                : current;

            // Success – return as soon as we find a valid sensor
            return { current, target };
        } catch (e) {
            // ignore this candidate and try the next
        }
    }

    // No usable chamber sensor found
    return null;
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
    // print-progress.js (Add this function)

    function hideThumbnail() {
    	const thumbEl = document.getElementById("thumbnail");
    	const fileLabel = document.getElementById("thumbnailFilename");
    	if (thumbEl) {
        thumbEl.src = "";
        thumbEl.style.display = "none";
        thumbEl.removeAttribute("data-loaded-for"); // Clear cache reference
    }
    if (fileLabel) {
        fileLabel.textContent = "--";
    }
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