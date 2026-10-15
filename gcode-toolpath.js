/**
 * G-code toolpath parser for the Live Toolpath ("digital twin") overlay.
 *
 * Turns a G-code file into a flat list of extrusion segments that the WebGL
 * renderer can draw directly, and keeps enough bookkeeping to map Klipper's
 * live state back onto that list:
 *
 * - Streaming, byte-level parser: feed it Uint8Array chunks straight from a
 *   fetch() reader. Never decodes the whole file to a string, so byte offsets
 *   stay exact even with CRLF line endings or UTF-8 comments.
 * - Every segment records the byte offset of the end of the line that
 *   produced it. Klipper's `virtual_sdcard.file_position` is a byte offset in
 *   the same file, so "how much has printed" becomes a binary search.
 * - G2/G3 arcs are linearized, G90/G91/M82/M83/G92 follow Klipper semantics.
 * - Slicer feature comments (`;TYPE:` / `; FEATURE:`) are classified so the
 *   overlay can colour by feature (walls, infill, supports, ...).
 * - Layers come from slicer layer-change comments when present, otherwise
 *   from Z changes of extrusion moves.
 *
 * UMD module: works as a browser global (window.GcodeToolpath) and in Node
 * (require) for the unit tests.
 */

(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.GcodeToolpath = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // ============================================================
    // FEATURE TYPES
    // ============================================================

    const FEATURES = [
        { id: 0, label: 'Other', color: '#8a93a6' },
        { id: 1, label: 'Outer wall', color: '#ff9f43' },
        { id: 2, label: 'Inner wall', color: '#ffd166' },
        { id: 3, label: 'Overhang wall', color: '#ff5d8f' },
        { id: 4, label: 'Sparse infill', color: '#b388ff' },
        { id: 5, label: 'Solid infill', color: '#e040fb' },
        { id: 6, label: 'Top surface', color: '#ff6b6b' },
        { id: 7, label: 'Bottom surface', color: '#4ecdc4' },
        { id: 8, label: 'Bridge', color: '#4d96ff' },
        { id: 9, label: 'Gap fill', color: '#f1f3f5' },
        { id: 10, label: 'Support', color: '#06d6a0' },
        { id: 11, label: 'Support interface', color: '#7bd389' },
        { id: 12, label: 'Skirt / brim', color: '#00b4d8' },
        { id: 13, label: 'Prime tower', color: '#adb5bd' },
        { id: 14, label: 'Ironing', color: '#ffafcc' }
    ];

    /**
     * Map a slicer feature name to a FEATURES id.
     * Covers PrusaSlicer/SuperSlicer ("External perimeter"), Orca/Bambu
     * ("Outer wall") and Cura ("WALL-OUTER", "SKIN", "FILL").
     * Order matters: more specific names are checked first.
     */
    function classifyFeature(name) {
        const s = String(name || '').toLowerCase().trim();
        if (!s) return 0;
        if (s.includes('ironing')) return 14;
        if (s.includes('overhang')) return 3;
        if (s.includes('outer') || s.includes('external')) return 1;
        if (s.includes('support') && (s.includes('interface') || s.includes('roof') || s.includes('floor'))) return 11;
        if (s.includes('support')) return 10;
        if (s.includes('bridge')) return 8;
        if (s.includes('gap')) return 9;
        if (s.includes('top')) return 6;
        if (s.includes('bottom')) return 7;
        if (s.includes('skirt') || s.includes('brim')) return 12;
        if (s.includes('tower') || s.includes('wipe')) return 13;
        if (s.includes('solid') || s.includes('skin')) return 5;
        if (s.includes('infill') || s.includes('fill')) return 4;
        if (s.includes('perimeter') || s.includes('wall') || s.includes('inner')) return 2;
        return 0;
    }

    // ============================================================
    // PARSER
    // ============================================================

    const NL = 10, CR = 13, SPACE = 32, TAB = 9, SEMI = 59, STAR = 42;
    const SEG_FLOATS = 6;   // x0 y0 z0 x1 y1 z1
    const SEG_ATTRS = 4;    // feature, speed/2 (mm/s), layer parity, reserved
    const LAYER_EPSILON = 0.0099;

    function emptyBounds() {
        return { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
    }

    function extendBounds(b, x, y, z) {
        if (x < b.minX) b.minX = x; if (x > b.maxX) b.maxX = x;
        if (y < b.minY) b.minY = y; if (y > b.maxY) b.maxY = y;
        if (z < b.minZ) b.minZ = z; if (z > b.maxZ) b.maxZ = z;
    }

    class ToolpathParser {
        constructor(options = {}) {
            this.arcResolution = options.arcResolution || 0.5; // mm per linearized arc piece

            this.count = 0;
            this.capacity = 0;
            this.positions = new Float32Array(0);
            this.attrs = new Uint8Array(0);
            this.offsets = new Float64Array(0);
            this._grow(Math.max(1024, options.expectedSegments | 0));

            this.layers = [];               // [{ z, start }]
            this.bytesParsed = 0;
            this.linesParsed = 0;
            this.speedHistogram = new Uint32Array(256);
            this.featureCounts = new Uint32Array(FEATURES.length);

            // Bounds of slicer-tagged features (ignores purge lines in start
            // gcode) and of everything, used as a fallback.
            this._featureBounds = emptyBounds();
            this._allBounds = emptyBounds();

            // Machine state (Klipper semantics)
            this.x = 0; this.y = 0; this.z = 0; this.e = 0;
            this.absoluteCoords = true;
            this.absoluteExtrude = true;
            this.unitScale = 1;
            this.feedrate = 0;              // mm/s
            this.feature = 0;

            this._carry = null;
            this._num = 0;                  // scratch: parse cursor
            this._lastLayerZ = -Infinity;
            this._layerComments = false;
            this._pendingLayer = false;
            this._featureCache = new Map();
        }

        /** Feed the next chunk of the file. */
        push(chunk) {
            if (!chunk || !chunk.length) return;
            let buf = chunk;
            let base = this.bytesParsed;
            if (this._carry) {
                buf = new Uint8Array(this._carry.length + chunk.length);
                buf.set(this._carry, 0);
                buf.set(chunk, this._carry.length);
                base -= this._carry.length;
                this._carry = null;
            }
            let start = 0;
            let nl;
            while ((nl = buf.indexOf(NL, start)) !== -1) {
                this._line(buf, start, nl, base + nl + 1);
                start = nl + 1;
            }
            if (start < buf.length) this._carry = buf.slice(start);
            this.bytesParsed += chunk.length;
        }

        /** Flush the final line (files without a trailing newline). */
        finish() {
            if (this._carry) {
                const carry = this._carry;
                this._carry = null;
                this._line(carry, 0, carry.length, this.bytesParsed);
            }
            return this;
        }

        getBounds() {
            const b = Number.isFinite(this._featureBounds.minX) ? this._featureBounds : this._allBounds;
            return Number.isFinite(b.minX) ? { ...b } : null;
        }

        /** Speed (mm/s) at the given percentile of extruded segments. */
        speedPercentile(p) {
            let total = 0;
            for (let i = 0; i < 256; i++) total += this.speedHistogram[i];
            if (!total) return 0;
            const target = total * p;
            let acc = 0;
            for (let i = 0; i < 256; i++) {
                acc += this.speedHistogram[i];
                if (acc >= target) return i * 2;
            }
            return 510;
        }

        // ---------------- internals ----------------

        _grow(min) {
            let cap = this.capacity || 1024;
            while (cap < min) cap *= 2;
            if (cap === this.capacity) return;
            const pos = new Float32Array(cap * SEG_FLOATS);
            const att = new Uint8Array(cap * SEG_ATTRS);
            const off = new Float64Array(cap);
            pos.set(this.positions.subarray(0, this.count * SEG_FLOATS));
            att.set(this.attrs.subarray(0, this.count * SEG_ATTRS));
            off.set(this.offsets.subarray(0, this.count));
            this.positions = pos;
            this.attrs = att;
            this.offsets = off;
            this.capacity = cap;
        }

        _readNumber(buf, i, end) {
            let neg = false;
            if (buf[i] === 45) { neg = true; i++; } else if (buf[i] === 43) { i++; }
            let int = 0, frac = 0, div = 1, any = false, d;
            while (i < end && (d = buf[i] - 48) >= 0 && d <= 9) { int = int * 10 + d; i++; any = true; }
            if (i < end && buf[i] === 46) {
                i++;
                while (i < end && (d = buf[i] - 48) >= 0 && d <= 9) {
                    if (div < 1e9) { frac = frac * 10 + d; div *= 10; }
                    i++; any = true;
                }
            }
            this._num = i;
            if (!any) return NaN;
            const v = int + frac / div;
            return neg ? -v : v;
        }

        _line(buf, s, e, endOffset) {
            this.linesParsed++;
            while (s < e && (buf[s] === SPACE || buf[s] === TAB)) s++;
            if (e > s && buf[e - 1] === CR) e--;
            if (s >= e) return;

            let c = buf[s];
            if (c === SEMI) { this._comment(buf, s + 1, e); return; }

            // Optional line number prefix: N123 G1 ...
            if ((c | 32) === 110) {
                this._readNumber(buf, s + 1, e);
                s = this._num;
                while (s < e && (buf[s] === SPACE || buf[s] === TAB)) s++;
                if (s >= e) return;
                c = buf[s];
            }

            const letter = c & 0xDF; // upper-case
            if (letter !== 71 && letter !== 77) return; // only G and M matter
            const d0 = buf[s + 1] - 48;
            if (!(d0 >= 0 && d0 <= 9)) return;          // e.g. GET_POSITION macro
            const code = this._readNumber(buf, s + 1, e);
            let i = this._num;

            if (letter === 77) {
                if (code === 82) this.absoluteExtrude = true;
                else if (code === 83) this.absoluteExtrude = false;
                return;
            }

            switch (code) {
                case 0: case 1: case 2: case 3: case 28: case 92: break;
                case 90: this.absoluteCoords = true; return;
                case 91: this.absoluteCoords = false; return;
                case 20: this.unitScale = 25.4; return;
                case 21: this.unitScale = 1; return;
                default: return;
            }

            let hasX = false, hasY = false, hasZ = false, hasE = false, hasF = false;
            let X = 0, Y = 0, Z = 0, E = 0, F = 0, I = 0, J = 0;
            while (i < e) {
                const ch = buf[i];
                if (ch === SEMI || ch === STAR) break;
                if (ch === SPACE || ch === TAB) { i++; continue; }
                const w = ch & 0xDF;
                const v = this._readNumber(buf, i + 1, e);
                i = this._num > i + 1 ? this._num : i + 1;
                const has = !Number.isNaN(v);
                const val = has ? v : 0;
                switch (w) {
                    case 88: hasX = true; X = val; break;
                    case 89: hasY = true; Y = val; break;
                    case 90: hasZ = true; Z = val; break;
                    case 69: hasE = true; E = val; break;
                    case 70: if (has) { hasF = true; F = val; } break;
                    case 73: I = val; break;
                    case 74: J = val; break;
                    default: break;
                }
            }

            const u = this.unitScale;

            if (code === 28) {
                // Home: named axes (or all) go to 0
                const all = !hasX && !hasY && !hasZ;
                if (all || hasX) this.x = 0;
                if (all || hasY) this.y = 0;
                if (all || hasZ) this.z = 0;
                return;
            }

            if (code === 92) {
                if (hasX) this.x = X * u;
                if (hasY) this.y = Y * u;
                if (hasZ) this.z = Z * u;
                if (hasE) this.e = E * u;
                if (!hasX && !hasY && !hasZ && !hasE) { this.x = 0; this.y = 0; this.z = 0; this.e = 0; }
                return;
            }

            if (hasF) this.feedrate = F * u / 60;

            const rel = !this.absoluteCoords;
            const nx = hasX ? (rel ? this.x + X * u : X * u) : this.x;
            const ny = hasY ? (rel ? this.y + Y * u : Y * u) : this.y;
            const nz = hasZ ? (rel ? this.z + Z * u : Z * u) : this.z;
            let de = 0;
            if (hasE) {
                const relE = rel || !this.absoluteExtrude;
                const ne = relE ? this.e + E * u : E * u;
                de = ne - this.e;
                this.e = ne;
            }

            if (de > 1e-9) {
                if (code === 2 || code === 3) {
                    this._arc(code === 2, this.x, this.y, this.z, nx, ny, nz, I * u, J * u, endOffset);
                } else if (nx !== this.x || ny !== this.y || nz !== this.z) {
                    this._segment(this.x, this.y, this.z, nx, ny, nz, endOffset);
                }
            }

            this.x = nx; this.y = ny; this.z = nz;
        }

        _arc(clockwise, x0, y0, z0, x1, y1, z1, I, J, endOffset) {
            const cx = x0 + I, cy = y0 + J;
            const r = Math.hypot(I, J);
            if (!(r > 1e-6)) { this._segment(x0, y0, z0, x1, y1, z1, endOffset); return; }
            const a0 = Math.atan2(y0 - cy, x0 - cx);
            const a1 = Math.atan2(y1 - cy, x1 - cx);
            let sweep = a1 - a0;
            if (clockwise) { if (sweep >= 0) sweep -= Math.PI * 2; }
            else if (sweep <= 0) sweep += Math.PI * 2;
            const len = Math.abs(sweep) * r;
            const n = Math.max(1, Math.min(720, Math.ceil(len / this.arcResolution)));
            let px = x0, py = y0, pz = z0;
            for (let k = 1; k <= n; k++) {
                const t = k / n;
                let qx, qy;
                if (k === n) { qx = x1; qy = y1; }
                else {
                    const a = a0 + sweep * t;
                    qx = cx + Math.cos(a) * r;
                    qy = cy + Math.sin(a) * r;
                }
                const qz = z0 + (z1 - z0) * t;
                this._segment(px, py, pz, qx, qy, qz, endOffset);
                px = qx; py = qy; pz = qz;
            }
        }

        _segment(x0, y0, z0, x1, y1, z1, endOffset) {
            if (this.count >= this.capacity) this._grow(this.count + 1);
            const i = this.count;

            if (this._layerComments) {
                if (this._pendingLayer) {
                    this.layers.push({ z: z1, start: i });
                    this._pendingLayer = false;
                    this._lastLayerZ = z1;
                }
            } else if (Math.abs(z1 - this._lastLayerZ) > LAYER_EPSILON) {
                this.layers.push({ z: z1, start: i });
                this._lastLayerZ = z1;
            }

            const p = i * SEG_FLOATS;
            const pos = this.positions;
            pos[p] = x0; pos[p + 1] = y0; pos[p + 2] = z0;
            pos[p + 3] = x1; pos[p + 4] = y1; pos[p + 5] = z1;

            const speedByte = Math.min(255, Math.round(this.feedrate / 2));
            const a = i * SEG_ATTRS;
            this.attrs[a] = this.feature;
            this.attrs[a + 1] = speedByte;
            this.attrs[a + 2] = this.layers.length & 1;
            this.offsets[i] = endOffset;

            this.speedHistogram[speedByte]++;
            this.featureCounts[this.feature]++;
            extendBounds(this._allBounds, x0, y0, z0);
            extendBounds(this._allBounds, x1, y1, z1);
            if (this.feature !== 0) {
                extendBounds(this._featureBounds, x0, y0, z0);
                extendBounds(this._featureBounds, x1, y1, z1);
            }
            this.count = i + 1;
        }

        _comment(buf, s, e) {
            while (s < e && (buf[s] === SPACE || buf[s] === TAB)) s++;
            const len = e - s;
            if (len < 5) return;
            const head = asciiUpper(buf, s, Math.min(e, s + 14));

            let valueStart = -1;
            if (head.startsWith('TYPE:')) valueStart = s + 5;
            else if (head.startsWith('FEATURE:')) valueStart = s + 8;

            if (valueStart >= 0) {
                const name = asciiString(buf, valueStart, Math.min(e, valueStart + 64)).trim();
                let id = this._featureCache.get(name);
                if (id === undefined) {
                    id = classifyFeature(name);
                    this._featureCache.set(name, id);
                }
                this.feature = id;
                return;
            }

            if (head.startsWith('LAYER_CHANGE') || head.startsWith('CHANGE_LAYER') || /^LAYER:-?\d/.test(head)) {
                if (!this._layerComments) {
                    // Switch to comment-driven layers; anything extruded
                    // before the first marker (purge lines) is "layer 0".
                    this._layerComments = true;
                    this.layers = [];
                }
                this._pendingLayer = true;
            }
        }
    }

    function asciiUpper(buf, s, e) {
        let out = '';
        for (let i = s; i < e; i++) {
            const c = buf[i];
            out += String.fromCharCode(c >= 97 && c <= 122 ? c - 32 : c);
        }
        return out;
    }

    function asciiString(buf, s, e) {
        let out = '';
        for (let i = s; i < e; i++) out += String.fromCharCode(buf[i]);
        return out;
    }

    // ============================================================
    // LIVE-STATE HELPERS
    // ============================================================

    /**
     * Number of segments whose source line ends at or before `filePosition`
     * (i.e. lines Klipper has already read from the file).
     */
    function segmentIndexAtOffset(offsets, count, filePosition) {
        if (!(filePosition > 0) || !count) return 0;
        let lo = 0, hi = count;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (offsets[mid] <= filePosition) lo = mid + 1; else hi = mid;
        }
        return lo;
    }

    /**
     * Klipper reads ahead of the nozzle (lookahead queue), so file_position
     * runs slightly ahead of what is physically printed. Given the nozzle's
     * live position, search backwards from `approxIndex` for the segment the
     * nozzle is actually on and return a fractional progress (index + t).
     *
     * Returns null when the nozzle isn't near any recent extrusion
     * (travel moves, z-hops, purge, ...).
     */
    function refineIndexByPosition(positions, count, approxIndex, x, y, z, options = {}) {
        const windowSize = options.window || 3000;
        const maxDistance = options.maxDistance || 2.5;
        const end = Math.min(count, Math.max(0, approxIndex));
        const start = Math.max(0, end - windowSize);
        let best = -1, bestScore = Infinity, bestT = 0;

        for (let i = end - 1; i >= start; i--) {
            const p = i * SEG_FLOATS;
            const ax = positions[p], ay = positions[p + 1], az = positions[p + 2];
            const bx = positions[p + 3], by = positions[p + 4], bz = positions[p + 5];
            const dz = Math.abs((az + bz) * 0.5 - z);
            if (dz > 1.2) continue;
            const vx = bx - ax, vy = by - ay;
            const l2 = vx * vx + vy * vy;
            let t = l2 > 1e-12 ? ((x - ax) * vx + (y - ay) * vy) / l2 : 0;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const dx = ax + vx * t - x, dy = ay + vy * t - y;
            // XY distance dominates; Z keeps us on the right layer; a tiny
            // age penalty prefers the most recent of overlapping candidates.
            const score = Math.sqrt(dx * dx + dy * dy) + dz * 3 + (end - i) * 1e-5;
            if (score < bestScore) { bestScore = score; best = i; bestT = t; }
        }

        if (best < 0 || bestScore > maxDistance) return null;
        return best + bestT;
    }

    /** Index into `layers` for a segment index (-1 before the first layer). */
    function layerIndexAt(layers, segment) {
        let lo = 0, hi = layers.length - 1, ans = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >>> 1;
            if (layers[mid].start <= segment) { ans = mid; lo = mid + 1; } else hi = mid - 1;
        }
        return ans;
    }

    /** Parse a whole G-code string (convenience for tests and demo mode). */
    function parseGcodeText(text, options) {
        const bytes = typeof TextEncoder !== 'undefined'
            ? new TextEncoder().encode(text)
            : Uint8Array.from(Buffer.from(text, 'utf8'));
        const parser = new ToolpathParser(options);
        parser.push(bytes);
        return parser.finish();
    }

    return {
        FEATURES,
        SEG_FLOATS,
        SEG_ATTRS,
        ToolpathParser,
        classifyFeature,
        segmentIndexAtOffset,
        refineIndexByPosition,
        layerIndexAt,
        parseGcodeText
    };
});
