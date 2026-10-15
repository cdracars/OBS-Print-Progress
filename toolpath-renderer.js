/**
 * WebGL2 renderer for the Live Toolpath overlay.
 *
 * Every extrusion segment is one GPU instance expanded into a screen-facing
 * ribbon and shaded like a round plastic bead (fake cylinder normal plus
 * Kajiya-Kay style lighting along the segment direction). The whole model
 * is uploaded once; printed vs. unprinted is decided per frame purely by
 * instance ranges, so following a live print costs nothing extra:
 *
 *   pass 1  printed segments [0, progress)   opaque, lit, glowing hot trail
 *   pass 2  bed grid                          alpha, depth-tested
 *   pass 3  unprinted segments [progress, n)  additive holographic ghost
 *   pass 4  nozzle                            additive glow sprite
 *
 * The canvas is transparent so it composites over a camera feed in OBS.
 */

(function (root) {
    'use strict';

    const { SEG_FLOATS, SEG_ATTRS, FEATURES } = root.GcodeToolpath;

    // ============================================================
    // SHADERS
    // ============================================================

    const TOOLPATH_VS = `#version 300 es
precision highp float;
precision highp int;
layout(location=0) in vec2 aCorner;   // x: 0 start / 1 end, y: -1 / +1 side
layout(location=1) in vec3 aStart;
layout(location=2) in vec3 aEnd;
layout(location=3) in vec4 aAttr;     // feature, speed/2, layer parity, -

uniform mat4 uViewProj;
uniform vec2 uViewport;
uniform float uPxPerUnit;
uniform float uWidth;
uniform float uMinPx;
uniform float uBase;
uniform float uProgress;
uniform int uPass;
uniform int uMode;
uniform vec3 uPalette[16];
uniform vec3 uColorLow;
uniform vec3 uColorHigh;
uniform vec2 uZRange;
uniform float uSpeedMax;
uniform float uTrail;

out vec3 vColor;
out float vSide;
out float vHeat;
out vec3 vWorld;
out vec3 vTangent;

vec3 speedRamp(float t) {
    vec3 c0 = vec3(0.16, 0.35, 0.95);
    vec3 c1 = vec3(0.10, 0.85, 0.85);
    vec3 c2 = vec3(0.45, 0.95, 0.30);
    vec3 c3 = vec3(1.00, 0.80, 0.15);
    vec3 c4 = vec3(1.00, 0.25, 0.25);
    if (t < 0.25) return mix(c0, c1, t / 0.25);
    if (t < 0.50) return mix(c1, c2, (t - 0.25) / 0.25);
    if (t < 0.75) return mix(c2, c3, (t - 0.50) / 0.25);
    return mix(c3, c4, (t - 0.75) / 0.25);
}

void main() {
    float seg = uBase + float(gl_InstanceID);
    vec3 a = aStart;
    vec3 b = aEnd;
    if (uPass == 0) {
        float f = uProgress - seg;
        if (f < 1.0) b = mix(a, b, clamp(f, 0.0, 1.0));
    }

    vec4 ca = uViewProj * vec4(a, 1.0);
    vec4 cb = uViewProj * vec4(b, 1.0);
    vec4 clip = aCorner.x < 0.5 ? ca : cb;
    vec3 world = aCorner.x < 0.5 ? a : b;

    vec2 halfVp = uViewport * 0.5;
    vec2 sa = ca.xy / ca.w * halfVp;
    vec2 sb = cb.xy / cb.w * halfVp;
    vec2 dir = sb - sa;
    float len = length(dir);
    dir = len > 1e-4 ? dir / len : vec2(1.0, 0.0);
    vec2 nrm = vec2(-dir.y, dir.x);

    float px = max(uMinPx, uWidth * uPxPerUnit / clip.w);
    if (uPass == 1) px = max(uMinPx, px * 0.6);
    vec2 off = nrm * aCorner.y * px * 0.5 + dir * (aCorner.x * 2.0 - 1.0) * px * 0.5;
    clip.xy += off / halfVp * clip.w;
    gl_Position = clip;

    vec3 base;
    if (uMode == 1) {
        base = uPalette[int(min(aAttr.x, 15.0) + 0.5)];
    } else if (uMode == 2) {
        base = speedRamp(clamp(aAttr.y * 2.0 / max(uSpeedMax, 1.0), 0.0, 1.0));
    } else {
        float h = clamp((world.z - uZRange.x) / max(uZRange.y - uZRange.x, 0.001), 0.0, 1.0);
        base = mix(uColorLow, uColorHigh, smoothstep(0.0, 1.0, h));
    }
    vColor = base * mix(0.86, 1.0, aAttr.z);
    vHeat = uPass == 0 ? exp(-max(uProgress - seg, 0.0) / uTrail) : 0.0;
    vSide = aCorner.y;
    vWorld = world;
    vec3 t = b - a;
    vTangent = dot(t, t) > 1e-12 ? normalize(t) : vec3(1.0, 0.0, 0.0);
}`;

    const TOOLPATH_FS = `#version 300 es
precision highp float;
precision highp int;
in vec3 vColor;
in float vSide;
in float vHeat;
in vec3 vWorld;
in vec3 vTangent;

uniform int uPass;
uniform vec3 uLightDir;
uniform vec3 uNozzle;
uniform float uNozzleOn;
uniform vec3 uHot;
uniform vec3 uGhostColor;
uniform float uGhostAlpha;
uniform float uScanZ;
uniform float uPulse;

out vec4 outColor;

void main() {
    float prof = sqrt(max(0.0, 1.0 - vSide * vSide));
    if (uPass == 0) {
        float tl = dot(vTangent, uLightDir);
        float diff = sqrt(max(0.0, 1.0 - tl * tl));
        float shade = 0.30 + 0.70 * diff * (0.35 + 0.65 * prof);
        float spec = pow(prof, 18.0) * pow(diff, 8.0) * 0.45;
        vec3 c = vColor * shade + vec3(spec);
        float d = distance(vWorld, uNozzle);
        c += uHot * uNozzleOn * exp(-d * 0.55) * 0.55;
        c = mix(c, uHot * (1.1 + 0.5 * prof), clamp(vHeat, 0.0, 1.0) * 0.9);
        outColor = vec4(c, 1.0);
    } else {
        float scan = exp(-abs(vWorld.z - uScanZ) * 1.6);
        float a = uGhostAlpha * (0.4 + 0.6 * prof) * uPulse + scan * 0.18;
        vec3 c = uGhostColor * a;
        outColor = vec4(c, a);
    }
}`;

    const GRID_VS = `#version 300 es
precision highp float;
precision highp int;
layout(location=0) in vec4 aPos;   // xyz + alpha
uniform mat4 uViewProj;
out float vAlpha;
void main() { vAlpha = aPos.w; gl_Position = uViewProj * vec4(aPos.xyz, 1.0); }`;

    const GRID_FS = `#version 300 es
precision highp float;
precision highp int;
in float vAlpha;
uniform vec3 uColor;
out vec4 outColor;
void main() { outColor = vec4(uColor * vAlpha, vAlpha); }`;

    const SPRITE_VS = `#version 300 es
precision highp float;
precision highp int;
uniform mat4 uViewProj;
uniform vec3 uPos;
uniform float uSize;
void main() {
    vec4 c = uViewProj * vec4(uPos, 1.0);
    gl_Position = c;
    gl_PointSize = uSize;
}`;

    const SPRITE_FS = `#version 300 es
precision highp float;
precision highp int;
uniform vec3 uColor;
uniform float uIntensity;
out vec4 outColor;
void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float r = length(p);
    float core = smoothstep(0.18, 0.0, r);
    float halo = exp(-r * r * 6.0) * 0.6;
    float ring = smoothstep(0.06, 0.0, abs(r - 0.55)) * 0.35;
    float a = (core + halo + ring) * uIntensity;
    outColor = vec4(mix(uColor, vec3(1.0), core) * a, a);
}`;

    // ============================================================
    // MATH
    // ============================================================

    function perspective(fovy, aspect, near, far) {
        const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
        return new Float32Array([
            f / aspect, 0, 0, 0,
            0, f, 0, 0,
            0, 0, (far + near) * nf, -1,
            0, 0, 2 * far * near * nf, 0
        ]);
    }

    function lookAt(eye, target, up) {
        let zx = eye[0] - target[0], zy = eye[1] - target[1], zz = eye[2] - target[2];
        let l = Math.hypot(zx, zy, zz) || 1; zx /= l; zy /= l; zz /= l;
        let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
        l = Math.hypot(xx, xy, xz) || 1; xx /= l; xy /= l; xz /= l;
        const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
        return new Float32Array([
            xx, yx, zx, 0,
            xy, yy, zy, 0,
            xz, yz, zz, 0,
            -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
            -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
            -(zx * eye[0] + zy * eye[1] + zz * eye[2]),
            1
        ]);
    }

    function multiply(a, b) {
        const o = new Float32Array(16);
        for (let c = 0; c < 4; c++) {
            for (let r = 0; r < 4; r++) {
                o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
            }
        }
        return o;
    }

    function hexToRgb(hex) {
        const h = hex.replace('#', '');
        const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
        return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
    }

    const lerp = (a, b, t) => a + (b - a) * t;

    // ============================================================
    // RENDERER
    // ============================================================

    class ToolpathRenderer {
        constructor(canvas, options = {}) {
            this.canvas = canvas;
            const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: true });
            if (!gl) throw new Error('WebGL2 is not available');
            this.gl = gl;

            this.options = {
                mode: options.mode || 'height',
                width: options.width || 0.45,
                trail: options.trail || 300,
                ghost: options.ghost !== false,
                ghostAlpha: options.ghostAlpha ?? 0.045,
                spin: options.spin ?? 8,
                pitch: options.pitch ?? 26,
                zoom: options.zoom || 1
            };

            this.model = null;
            this.uploaded = 0;
            this.gpuCapacity = 0;
            this.progress = 0;
            this.nozzle = null;
            this.nozzleColor = [1, 0.75, 0.4];
            this.nozzleIntensity = 1;
            this.ghostPulse = 1;
            this.bed = null;
            this.gridCount = 0;

            this.yaw = -Math.PI * 0.3;
            this.pitch = this.options.pitch * Math.PI / 180;
            this.zoom = this.options.zoom;
            this.frame = null;            // smoothed camera framing
            this.lastInteraction = -1e9;

            this.theme = {
                low: [0.12, 0.37, 0.85],
                high: [0.70, 0.85, 1.0],
                ghost: [0.23, 0.53, 1.0],
                hot: [1.0, 0.72, 0.38],
                grid: [0.36, 0.55, 0.95]
            };
            this.palette = new Float32Array(48);
            FEATURES.forEach((f, i) => this.palette.set(hexToRgb(f.color), i * 3));

            this._initGl();
            this._bindInteraction();
        }

        // ---------------- public API ----------------

        setModel(model) {
            this.model = model;
            this.uploaded = 0;
            this.gpuCapacity = 0;
            this.progress = 0;
        }

        setProgress(p) { this.progress = Math.max(0, p); }
        setNozzle(pos) { this.nozzle = pos; }
        setMode(mode) { this.options.mode = mode; }

        setTheme(theme) { Object.assign(this.theme, theme); }

        setBed(minX, minY, maxX, maxY) {
            if (this.bed && this.bed.join() === [minX, minY, maxX, maxY].join()) return;
            this.bed = [minX, minY, maxX, maxY];
            this._buildGrid();
        }

        render(timeMs, dt) {
            const gl = this.gl;
            this._resize();
            this._sync();

            const camera = this._camera(timeMs, dt);
            gl.viewport(0, 0, this.canvas.width, this.canvas.height);
            gl.clearColor(0, 0, 0, 0);
            gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
            if (!camera) return;

            const count = this.model ? Math.min(this.model.count, this.uploaded) : 0;
            const progress = Math.min(this.progress, count);
            const printed = progress > 0 ? Math.min(count, Math.floor(progress) + 1) : 0;

            // --- pass 1: printed ---
            gl.enable(gl.DEPTH_TEST);
            gl.depthMask(true);
            gl.disable(gl.BLEND);
            if (printed > 0) this._drawSegments(camera, 0, printed, 0, progress);

            // --- pass 2: bed grid ---
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
            gl.depthMask(false);
            if (this.gridCount) {
                gl.useProgram(this.gridProgram.program);
                gl.uniformMatrix4fv(this.gridProgram.u.uViewProj, false, camera.viewProj);
                gl.uniform3fv(this.gridProgram.u.uColor, this.theme.grid);
                gl.bindVertexArray(this.gridVao);
                gl.drawArrays(gl.LINES, 0, this.gridCount);
            }

            // --- pass 3: ghost ---
            gl.blendFunc(gl.ONE, gl.ONE);
            const ghostStart = Math.floor(progress);
            if (this.options.ghost && count > ghostStart) {
                this._drawSegments(camera, ghostStart, count - ghostStart, 1, progress);
            }

            // --- pass 4: nozzle ---
            if (this.nozzle) {
                gl.disable(gl.DEPTH_TEST);
                const sp = this.spriteProgram;
                gl.useProgram(sp.program);
                gl.uniformMatrix4fv(sp.u.uViewProj, false, camera.viewProj);
                gl.uniform3fv(sp.u.uPos, this.nozzle);
                gl.uniform1f(sp.u.uSize, 34 * camera.dpr);
                gl.uniform3fv(sp.u.uColor, this.nozzleColor);
                gl.uniform1f(sp.u.uIntensity, this.nozzleIntensity);
                gl.bindVertexArray(this.emptyVao);
                gl.drawArrays(gl.POINTS, 0, 1);
            }
            gl.bindVertexArray(null);
        }

        // ---------------- GL setup ----------------

        _initGl() {
            const gl = this.gl;
            this.toolpathProgram = this._program(TOOLPATH_VS, TOOLPATH_FS);
            this.gridProgram = this._program(GRID_VS, GRID_FS);
            this.spriteProgram = this._program(SPRITE_VS, SPRITE_FS);

            this.cornerBuf = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuf);
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, -1, 0, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);

            this.posBuf = gl.createBuffer();
            this.attrBuf = gl.createBuffer();
            this.segVao = gl.createVertexArray();
            gl.bindVertexArray(this.segVao);
            gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuf);
            gl.enableVertexAttribArray(0);
            gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
            [1, 2, 3].forEach(loc => { gl.enableVertexAttribArray(loc); gl.vertexAttribDivisor(loc, 1); });
            gl.bindVertexArray(null);

            this.gridBuf = gl.createBuffer();
            this.gridVao = gl.createVertexArray();
            gl.bindVertexArray(this.gridVao);
            gl.bindBuffer(gl.ARRAY_BUFFER, this.gridBuf);
            gl.enableVertexAttribArray(0);
            gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 0, 0);
            gl.bindVertexArray(null);

            this.emptyVao = gl.createVertexArray();
        }

        _program(vsSrc, fsSrc) {
            const gl = this.gl;
            const compile = (type, src) => {
                const s = gl.createShader(type);
                gl.shaderSource(s, src);
                gl.compileShader(s);
                if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
                return s;
            };
            const program = gl.createProgram();
            gl.attachShader(program, compile(gl.VERTEX_SHADER, vsSrc));
            gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fsSrc));
            gl.linkProgram(program);
            if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
            const u = {};
            const n = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
            for (let i = 0; i < n; i++) {
                const name = gl.getActiveUniform(program, i).name.replace(/\[0\]$/, '');
                u[name] = gl.getUniformLocation(program, name);
            }
            return { program, u };
        }

        _sync() {
            const m = this.model;
            if (!m || m.count <= this.uploaded) return;
            const gl = this.gl;
            if (m.capacity > this.gpuCapacity) {
                gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
                gl.bufferData(gl.ARRAY_BUFFER, m.capacity * SEG_FLOATS * 4, gl.STATIC_DRAW);
                gl.bindBuffer(gl.ARRAY_BUFFER, this.attrBuf);
                gl.bufferData(gl.ARRAY_BUFFER, m.capacity * SEG_ATTRS, gl.STATIC_DRAW);
                this.gpuCapacity = m.capacity;
                this.uploaded = 0;
            }
            const from = this.uploaded, to = m.count;
            gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
            gl.bufferSubData(gl.ARRAY_BUFFER, from * SEG_FLOATS * 4, m.positions.subarray(from * SEG_FLOATS, to * SEG_FLOATS));
            gl.bindBuffer(gl.ARRAY_BUFFER, this.attrBuf);
            gl.bufferSubData(gl.ARRAY_BUFFER, from * SEG_ATTRS, m.attrs.subarray(from * SEG_ATTRS, to * SEG_ATTRS));
            this.uploaded = to;
        }

        _buildGrid() {
            const [x0, y0, x1, y1] = this.bed;
            const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
            const fadeR = Math.max(x1 - x0, y1 - y0) * 0.62;
            const step = 10, piece = 5;
            const verts = [];
            const alphaAt = (x, y, major) => {
                const d = Math.hypot(x - cx, y - cy) / fadeR;
                return Math.max(0, 1 - d * d) * (major ? 0.32 : 0.14);
            };
            const addLine = (ax, ay, bx, by, major) => {
                const len = Math.hypot(bx - ax, by - ay);
                const n = Math.max(1, Math.ceil(len / piece));
                for (let k = 0; k < n; k++) {
                    const t0 = k / n, t1 = (k + 1) / n;
                    const px = lerp(ax, bx, t0), py = lerp(ay, by, t0);
                    const qx = lerp(ax, bx, t1), qy = lerp(ay, by, t1);
                    verts.push(px, py, 0, alphaAt(px, py, major), qx, qy, 0, alphaAt(qx, qy, major));
                }
            };
            for (let x = Math.ceil(x0 / step) * step; x <= x1; x += step) addLine(x, y0, x, y1, x % 50 === 0);
            for (let y = Math.ceil(y0 / step) * step; y <= y1; y += step) addLine(x0, y, x1, y, y % 50 === 0);
            addLine(x0, y0, x1, y0, true); addLine(x1, y0, x1, y1, true);
            addLine(x1, y1, x0, y1, true); addLine(x0, y1, x0, y0, true);
            const gl = this.gl;
            gl.bindBuffer(gl.ARRAY_BUFFER, this.gridBuf);
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
            this.gridCount = verts.length / 4;
        }

        _resize() {
            const dpr = Math.min(window.devicePixelRatio || 1, 2);
            const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
            const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
            if (this.canvas.width !== w || this.canvas.height !== h) {
                this.canvas.width = w;
                this.canvas.height = h;
            }
            this.dpr = dpr;
        }

        // ---------------- camera ----------------

        _camera(timeMs, dt) {
            const bounds = this.model && this.model.count ? this.model.getBounds() : null;
            let target;
            if (bounds) {
                target = {
                    cx: (bounds.minX + bounds.maxX) / 2,
                    cy: (bounds.minY + bounds.maxY) / 2,
                    h: bounds.maxZ,
                    r: Math.max(8, 0.5 * Math.hypot(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, bounds.maxZ))
                };
            } else if (this.bed) {
                const [x0, y0, x1, y1] = this.bed;
                target = { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, h: 0, r: Math.max(x1 - x0, y1 - y0) * 0.45 };
            } else {
                return null;
            }

            // Smoothly re-frame as the model materializes while loading.
            if (!this.frame) this.frame = { ...target };
            const k = 1 - Math.exp(-dt * 3);
            for (const key of Object.keys(target)) this.frame[key] = lerp(this.frame[key], target[key], k);

            const idle = timeMs - this.lastInteraction > 4000;
            if (idle) this.yaw += (this.options.spin * Math.PI / 180) * dt;

            const f = this.frame;
            const fov = 32 * Math.PI / 180;
            const aspect = this.canvas.width / this.canvas.height;
            const fitR = f.r / Math.sin(fov / 2) * (aspect < 1 ? 1 / aspect : 1);
            const dist = fitR * 1.02 / this.zoom;
            const tgt = [f.cx, f.cy, f.h * 0.45];
            const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
            const eye = [tgt[0] + dist * cp * Math.cos(this.yaw), tgt[1] + dist * cp * Math.sin(this.yaw), tgt[2] + dist * sp];

            const proj = perspective(fov, aspect, Math.max(0.5, dist * 0.05), dist * 6);
            const view = lookAt(eye, tgt, [0, 0, 1]);
            const lx = Math.cos(this.yaw + 0.9), ly = Math.sin(this.yaw + 0.9);
            const ll = Math.hypot(lx, ly, 1.3);

            return {
                viewProj: multiply(proj, view),
                pxPerUnit: proj[5] * this.canvas.height * 0.5,
                light: [lx / ll, ly / ll, 1.3 / ll],
                zRange: bounds ? [bounds.minZ, Math.max(bounds.maxZ, bounds.minZ + 1)] : [0, 1],
                scanZ: bounds ? bounds.minZ + ((timeMs / 1000 * 0.18) % 1.25) * (bounds.maxZ - bounds.minZ + 2) : 0,
                dpr: this.dpr
            };
        }

        _drawSegments(camera, base, count, pass, progress) {
            const gl = this.gl;
            const p = this.toolpathProgram;
            const u = p.u;
            gl.useProgram(p.program);
            gl.bindVertexArray(this.segVao);

            const stride = SEG_FLOATS * 4;
            gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
            gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, base * stride);
            gl.vertexAttribPointer(2, 3, gl.FLOAT, false, stride, base * stride + 12);
            gl.bindBuffer(gl.ARRAY_BUFFER, this.attrBuf);
            gl.vertexAttribPointer(3, 4, gl.UNSIGNED_BYTE, false, SEG_ATTRS, base * SEG_ATTRS);

            const modes = { height: 0, feature: 1, speed: 2 };
            gl.uniformMatrix4fv(u.uViewProj, false, camera.viewProj);
            gl.uniform2f(u.uViewport, this.canvas.width, this.canvas.height);
            gl.uniform1f(u.uPxPerUnit, camera.pxPerUnit);
            gl.uniform1f(u.uWidth, this.options.width);
            gl.uniform1f(u.uMinPx, 1.15 * camera.dpr);
            gl.uniform1f(u.uBase, base);
            gl.uniform1f(u.uProgress, progress);
            gl.uniform1i(u.uPass, pass);
            gl.uniform1i(u.uMode, modes[this.options.mode] ?? 0);
            gl.uniform3fv(u.uPalette, this.palette);
            gl.uniform3fv(u.uColorLow, this.theme.low);
            gl.uniform3fv(u.uColorHigh, this.theme.high);
            gl.uniform2fv(u.uZRange, camera.zRange);
            gl.uniform1f(u.uSpeedMax, this.speedMax || (this.speedMax = Math.max(20, this.model.speedPercentile(0.999))));
            gl.uniform1f(u.uTrail, this.options.trail);
            gl.uniform3fv(u.uLightDir, camera.light);
            gl.uniform3fv(u.uNozzle, this.nozzle || [0, 0, -1e6]);
            gl.uniform1f(u.uNozzleOn, this.nozzle ? this.nozzleIntensity : 0);
            gl.uniform3fv(u.uHot, this.theme.hot);
            gl.uniform3fv(u.uGhostColor, this.theme.ghost);
            gl.uniform1f(u.uGhostAlpha, this.options.ghostAlpha);
            gl.uniform1f(u.uScanZ, camera.scanZ);
            gl.uniform1f(u.uPulse, this.ghostPulse);

            gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
        }

        /** Speed colouring range must be recomputed once a model finishes loading. */
        invalidateSpeedRange() { this.speedMax = 0; }

        // ---------------- interaction ----------------

        _bindInteraction() {
            const c = this.canvas;
            let drag = null;
            c.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY }; c.setPointerCapture(e.pointerId); });
            c.addEventListener('pointermove', e => {
                if (!drag) return;
                this.yaw -= (e.clientX - drag.x) * 0.008;
                this.pitch = Math.max(-0.2, Math.min(1.45, this.pitch + (e.clientY - drag.y) * 0.006));
                drag = { x: e.clientX, y: e.clientY };
                this.lastInteraction = performance.now();
            });
            c.addEventListener('pointerup', () => { drag = null; });
            c.addEventListener('wheel', e => {
                e.preventDefault();
                this.zoom = Math.max(0.3, Math.min(8, this.zoom * Math.exp(-e.deltaY * 0.0012)));
                this.lastInteraction = performance.now();
            }, { passive: false });
            c.addEventListener('dblclick', () => {
                this.zoom = this.options.zoom;
                this.pitch = this.options.pitch * Math.PI / 180;
                this.lastInteraction = -1e9;
            });
        }
    }

    root.ToolpathRenderer = ToolpathRenderer;
    root.ToolpathRenderer.hexToRgb = hexToRgb;
})(typeof self !== 'undefined' ? self : this);
