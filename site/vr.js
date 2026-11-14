// vr.html: "stand inside the sky". Plain WebGL (no library), WebXR when the browser offers immersive VR.
//
// - Background: data/vr/sky_2k.jpg, then sky_4k.jpg (pipeline/vr_sky.py: SPHEREx DR1 all-sky HiPS from
//   NASA/IPAC IRSA, equirectangular ICRS, RA 180 at the left edge, RA growing to the left, Dec +90 on top).
// - Dots: the 4,586 Gaia DR3 stars faster than 0.5"/yr of data/fast_stars.json.gz (pipeline/fast_stars.py).
//   Time slider: each star moves along a great circle at its Gaia proper motion (pmra includes cos dec).
//   Radial velocity and the change of proper motion it causes (perspective acceleration) are ignored, so the
//   slider is limited to +-2,000 years (worst case Kapteyn's / Barnard's Star: about 15% of the shown shift).
// - Targets: the five challenge targets and Luhman 16 are labelled; a tap opens a panel that blinks the real
//   SPHEREx frames in data/<id>/frames/ (meta.json) with our numbers (data/verify/tests.json, meta.json).
//
// World frame: GL (X, Y, Z) = ICRS (x, z, -y): Y is the north celestial pole, RA 0 is +X, RA 90 is -Z.
// Seen from inside, with north up, east (growing RA) is on the left, as on the real sky.

import { t, lang, num, tname, month, onLang } from "./js/i18n.js";

const $ = (id) => document.getElementById(id);
const D2R = Math.PI / 180, MAS = Math.PI / 180 / 3.6e6;          // mas -> rad
const NOW = 2026.0, GAIA_EPOCH = 2016.0, RANGE = 2000;
const R_SKY = 100, R_STAR = 90;
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const Q = new URLSearchParams(location.search);
const BINS = [500, 1000, 2000, 4000];                              // mas/yr, same bins as the explorer layer
const BIN_RGB = [[0.5, 0.83, 1.0], [1.0, 0.9, 0.43], [1.0, 0.68, 0.36], [1.0, 0.36, 0.54]];
const BIN_SIZE = [3.2, 4.4, 5.6, 7.0];                            // CSS px

// Targets. Catalogue motion only moves the label with the slider; the panel numbers are ours.
const TARGETS = [
  { id: "barnard", test: "V1", bin: 2.0, crop: 200, first: true },
  { id: "eps_indi_b", test: "V2", bin: 2.0, crop: 110 },
  { id: "wise0855", test: "V4", bin: 4.6, crop: 120 },
  { id: "luhman16", test: "V3" },
  { id: "rw_aur", bin: 4.6, crop: 170, slow: true },
  { id: "r_dra", bin: 4.6, crop: 260, slow: true },
];
const FALLBACK_NAME = { barnard: "Barnard's Star", eps_indi_b: "Epsilon Indi B", wise0855: "WISE 0855-0714", luhman16: "Luhman 16AB", rw_aur: "RW Aurigae", r_dra: "R Draconis" };

const state = {
  ra: 269.45, dec: 4.74, fov: 60,          // where we look (deg) and the vertical field of view
  year: NOW, playing: false, dirty: true,
  motion: false, motionOffset: 0, devQ: null,
  xr: null, gl: null, stars: null, targets: TARGETS, tests: null, meta: {},
  open: null,
};
window.__vr = state;                          // read by the headless tests

// ------------------------------------------------------------------------------------------ sphere math
function unit(ra, dec) {                      // ICRS unit vector
  const a = ra * D2R, d = dec * D2R;
  return [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)];
}
function radec(v) {
  const r = Math.hypot(v[0], v[1], v[2]);
  return [((Math.atan2(v[1], v[0]) / D2R) % 360 + 360) % 360, Math.asin(v[2] / r) / D2R];
}
const toGL = (v) => [v[0], v[2], -v[1]];
/** Unit tangent of the motion and its rate (rad/yr) for a proper motion (pmra includes cos dec), ICRS. */
function motionDir(ra, dec, pmra, pmdec) {
  const a = ra * D2R, d = dec * D2R;
  const E = [-Math.sin(a), Math.cos(a), 0];
  const N = [-Math.sin(d) * Math.cos(a), -Math.sin(d) * Math.sin(a), Math.cos(d)];
  const mu = Math.hypot(pmra, pmdec) * MAS;
  if (!mu) return { e: [0, 0, 0], mu: 0 };
  const k = MAS / mu;
  return { e: [0, 1, 2].map((i) => (pmra * E[i] + pmdec * N[i]) * k), mu };
}
/** Position (ra, dec) at `year` of a star at (ra, dec) at `epoch`: great circle, constant proper motion. */
export function propagateGC(ra, dec, pmra, pmdec, epoch, year) {
  const p = unit(ra, dec), { e, mu } = motionDir(ra, dec, pmra, pmdec);
  const th = mu * (year - epoch), c = Math.cos(th), s = Math.sin(th);
  return radec([0, 1, 2].map((i) => p[i] * c + e[i] * s));
}
/** Separation (deg) and position angle (deg, east of north) from point 1 to point 2. */
function sepPA(r1, d1, r2, d2) {
  const a1 = r1 * D2R, b1 = d1 * D2R, a2 = r2 * D2R, b2 = d2 * D2R;
  const sep = 2 * Math.asin(Math.sqrt(Math.sin((b2 - b1) / 2) ** 2 + Math.cos(b1) * Math.cos(b2) * Math.sin((a2 - a1) / 2) ** 2));
  const pa = Math.atan2(Math.sin(a2 - a1) * Math.cos(b2), Math.cos(b1) * Math.sin(b2) - Math.sin(b1) * Math.cos(b2) * Math.cos(a2 - a1));
  return [sep / D2R, ((pa / D2R) % 360 + 360) % 360];
}
state.math = { propagateGC, sepPA };

// ------------------------------------------------------------------------------------------ matrices (column-major)
function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
}
function mul(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}
/** View matrix (world -> camera) from a camera->world rotation given by its right, up and back axes. */
function viewFromAxes(r, u, b) {
  return new Float32Array([r[0], u[0], b[0], 0, r[1], u[1], b[1], 0, r[2], u[2], b[2], 0, 0, 0, 0, 1]);
}
function rotY(phi) {
  const c = Math.cos(phi), s = Math.sin(phi);
  return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]);
}
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// Quaternions for phone motion ([x, y, z, w]).
function qmul(a, b) {
  return [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
}
const qaxis = (ax, ang) => { const s = Math.sin(ang / 2); return [ax[0] * s, ax[1] * s, ax[2] * s, Math.cos(ang / 2)]; };
function qrot(q, v) {                         // rotate vector v by quaternion q
  const [x, y, z, w] = q, [vx, vy, vz] = v;
  const ix = w * vx + y * vz - z * vy, iy = w * vy + z * vx - x * vz, iz = w * vz + x * vy - y * vx, iw = -x * vx - y * vy - z * vz;
  return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
}
/** Device orientation (deg) -> camera rotation in a frame with Y up (the usual W3C recipe). */
function deviceQuat(alpha, beta, gamma, screenAngle) {
  const qy = qaxis([0, 1, 0], alpha * D2R), qx = qaxis([1, 0, 0], beta * D2R), qz = qaxis([0, 0, 1], -gamma * D2R);
  let q = qmul(qmul(qy, qx), qz);                                   // Euler order YXZ
  q = qmul(q, [-Math.SQRT1_2, 0, 0, Math.SQRT1_2]);                 // camera looks out of the back of the screen
  return qmul(q, qaxis([0, 0, 1], -screenAngle * D2R));
}

/** Camera axes (GL world) for the current look direction. */
function cameraAxes() {
  if (state.motion && state.devQ) {
    const q = qmul(qaxis([0, 1, 0], state.motionOffset), state.devQ);
    return { r: qrot(q, [1, 0, 0]), u: qrot(q, [0, 1, 0]), b: qrot(q, [0, 0, 1]) };
  }
  const f = toGL(unit(state.ra, state.dec));
  const r = norm(cross(f, [0, 1, 0]));
  const u = cross(r, f);
  return { r, u, b: [-f[0], -f[1], -f[2]] };
}
function syncLookFromCamera() {               // phone motion: keep ra/dec in step for labels and the tests
  const { b } = cameraAxes();
  const f = [-b[0], -b[1], -b[2]];
  [state.ra, state.dec] = radec([f[0], -f[2], f[1]]);
}

// ------------------------------------------------------------------------------------------ WebGL
// The equirectangular image is stretched by 1/cos(dec) along RA; plain mip-mapping then blurs along the
// meridians away from the equator. A negative LOD bias of log2(cos dec) keeps stars round there.
const SKY_VS = `attribute vec3 p; attribute vec2 uv; uniform mat4 vp; varying vec2 v_uv; varying float v_bias;
void main(){ v_uv = uv; v_bias = max(-2.5, 0.9 * log2(max(sqrt(max(1.0 - p.y * p.y, 0.0)), 0.02)));
  gl_Position = vp * vec4(p * ${R_SKY.toFixed(1)}, 1.0); }`;
const SKY_FS = `precision mediump float; uniform sampler2D tex; uniform float gain; varying vec2 v_uv; varying float v_bias;
void main(){ gl_FragColor = vec4(texture2D(tex, v_uv, v_bias).rgb * gain, 1.0); }`;
// Stars and trails: p0 = unit vector at Gaia epoch 2016.0, e = unit direction of motion, mu = rad/yr.
const STAR_VS = `attribute vec3 p0; attribute vec3 e; attribute float mu; attribute float bin; attribute float end;
uniform mat4 vp; uniform float dt; uniform float dtNow; uniform float px; uniform vec3 col[4]; uniform vec4 size; uniform mediump float ring;
varying vec3 v_c; varying float v_a;
void main(){
  float th = mu * mix(dtNow, dt, end);
  vec3 p = p0 * cos(th) + e * sin(th);
  gl_Position = vp * vec4(p * ${R_STAR.toFixed(1)}, 1.0);
  int b = int(bin + 0.5);
  v_c = b == 0 ? col[0] : b == 1 ? col[1] : b == 2 ? col[2] : col[3];
  float s = b == 0 ? size.x : b == 1 ? size.y : b == 2 ? size.z : size.w;
  gl_PointSize = s * px;
  if (ring > 0.5) { v_c = vec3(1.0, 0.79, 0.3); gl_PointSize = 26.0 * px; }
  v_a = end;
}`;
const STAR_FS = `precision mediump float; varying vec3 v_c; varying float v_a; uniform float lines; uniform float ring;
void main(){
  if (lines > 0.5) { gl_FragColor = vec4(v_c * 0.85, 0.15 + 0.45 * v_a); return; }
  vec2 d = gl_PointCoord - 0.5; float r = length(d) * 2.0;
  if (r > 1.0) discard;
  if (ring > 0.5) { if (r < 0.78) discard; gl_FragColor = vec4(v_c, 1.0); return; }
  float core = smoothstep(1.0, 0.55, r), ring = smoothstep(1.0, 0.8, r) - smoothstep(0.8, 0.6, r);
  gl_FragColor = vec4(mix(v_c, vec3(1.0), core * 0.35) , max(core, ring * 0.6));
}`;

function shader(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}
function program(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, shader(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, shader(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const loc = {};
  const na = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES), nu = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < na; i++) { const n = gl.getActiveAttrib(p, i).name; loc[n] = gl.getAttribLocation(p, n); }
  for (let i = 0; i < nu; i++) { const n = gl.getActiveUniform(p, i).name.replace(/\[0\]$/, ""); loc[n] = gl.getUniformLocation(p, n); }
  return { p, loc };
}

const R = { canvas: $("sky") };
function initGL() {
  if (Q.has("nogl")) return null;
  const opts = { antialias: true, alpha: false, preserveDrawingBuffer: Q.has("test") };
  let gl = null;
  try { gl = R.canvas.getContext("webgl", opts) || R.canvas.getContext("experimental-webgl", opts); } catch (e) { gl = null; }
  if (!gl) return null;
  try {
    R.sky = program(gl, SKY_VS, SKY_FS);
    R.star = program(gl, STAR_VS, STAR_FS);
  } catch (e) { console.warn("vr: shaders", e); return null; }
  // sky sphere, 96 x 48 quads, uv as in pipeline/vr_sky.py
  const NX = 96, NY = 48, pos = [], uv = [], idx = [];
  for (let j = 0; j <= NY; j++) for (let i = 0; i <= NX; i++) {
    const u = i / NX, v = j / NY;
    pos.push(...toGL(unit(180 - 360 * u, 90 - 180 * v)));
    uv.push(u, v);
  }
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
    const a = j * (NX + 1) + i, b = a + NX + 1;
    idx.push(a, b, a + 1, a + 1, b, b + 1);
  }
  R.skyPos = buf(gl, new Float32Array(pos));
  R.skyUV = buf(gl, new Float32Array(uv));
  R.skyIdx = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, R.skyIdx);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(idx), gl.STATIC_DRAW);
  R.skyN = idx.length;
  R.tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, R.tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, 1, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, new Uint8Array([4, 6, 12]));
  R.aniso = gl.getExtension("EXT_texture_filter_anisotropic") || gl.getExtension("WEBKIT_EXT_texture_filter_anisotropic");
  R.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.CULL_FACE);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  R.canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); showFlat(true); });
  return gl;
}
function buf(gl, data) {
  const b = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, b);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  return b;
}
function loadSky(gl, url) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.decoding = "async";
    im.onload = () => {
      gl.bindTexture(gl.TEXTURE_2D, R.tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, im);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      if (R.aniso) gl.texParameterf(gl.TEXTURE_2D, R.aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(4, gl.getParameter(R.aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
      state.skyLoaded = url;
      state.tSky = state.tSky || {};
      state.tSky[url] = Math.round(performance.now());
      state.dirty = true;
      res();
    };
    im.onerror = () => rej(new Error("sky image " + url));
    im.src = url;
  });
}

/** Star buffers: trails (two vertices per star: "now" and the slider time) and dots (one vertex per star). */
function starBuffers(gl, stars) {
  const n = stars.length;
  const L = { p: new Float32Array(n * 6), e: new Float32Array(n * 6), mu: new Float32Array(n * 2), bin: new Float32Array(n * 2), end: new Float32Array(n * 2) };
  const D = { p: new Float32Array(n * 3), e: new Float32Array(n * 3), mu: new Float32Array(n), bin: new Float32Array(n), end: new Float32Array(n).fill(1) };
  stars.forEach((s, i) => {
    const p = toGL(unit(s.ra, s.dec)), m = motionDir(s.ra, s.dec, s.pmra, s.pmdec), e = toGL(m.e);
    D.p.set(p, i * 3); D.e.set(e, i * 3); D.mu[i] = m.mu; D.bin[i] = s.bin;
    for (let k = 0; k < 2; k++) {
      const j = i * 2 + k;
      L.p.set(p, j * 3); L.e.set(e, j * 3); L.mu[j] = m.mu; L.bin[j] = s.bin; L.end[j] = k;
    }
  });
  const up = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, buf(gl, v)]));
  R.lines = up(L); R.dots = up(D);
  R.nStars = n;
}
function attr(gl, loc, b, size) {
  if (loc == null || loc < 0) return;
  gl.bindBuffer(gl.ARRAY_BUFFER, b);
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
}

function ringPositions() {
  const out = new Float32Array(R.nRings * 3);
  TARGETS.filter((tg) => tg.ra0 != null).forEach((tg, i) => out.set(toGL(unit(...targetPos(tg))), i * 3));
  return out;
}
function ringBuffers(gl) {
  const n = TARGETS.filter((tg) => tg.ra0 != null).length;
  if (!n) return;
  R.nRings = n;
  R.rings = { p: buf(gl, new Float32Array(n * 3)), e: buf(gl, new Float32Array(n * 3)), mu: buf(gl, new Float32Array(n)), bin: buf(gl, new Float32Array(n)), end: buf(gl, new Float32Array(n).fill(1)) };
  gl.bindBuffer(gl.ARRAY_BUFFER, R.rings.p);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(n * 3), gl.DYNAMIC_DRAW);
}
function drawScene(gl, vp, pxScale, rings = false) {
  // sky
  const s = R.sky;
  gl.useProgram(s.p);
  gl.uniformMatrix4fv(s.loc.vp, false, vp);
  gl.uniform1f(s.loc.gain, 1.0);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, R.tex);
  gl.uniform1i(s.loc.tex, 0);
  attr(gl, s.loc.p, R.skyPos, 3);
  attr(gl, s.loc.uv, R.skyUV, 2);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, R.skyIdx);
  gl.drawElements(gl.TRIANGLES, R.skyN, gl.UNSIGNED_SHORT, 0);
  for (const k of ["p", "uv"]) if (s.loc[k] >= 0) gl.disableVertexAttribArray(s.loc[k]);
  if (!R.nStars) return;
  // trails, then dots
  const st = R.star;
  gl.useProgram(st.p);
  gl.enable(gl.BLEND);
  gl.uniformMatrix4fv(st.loc.vp, false, vp);
  gl.uniform1f(st.loc.dt, state.year - GAIA_EPOCH);
  gl.uniform1f(st.loc.dtNow, NOW - GAIA_EPOCH);
  gl.uniform1f(st.loc.px, pxScale);
  gl.uniform3fv(st.loc.col, new Float32Array(BIN_RGB.flat()));
  gl.uniform4fv(st.loc.size, new Float32Array(BIN_SIZE));
  const bind = (B) => { attr(gl, st.loc.p0, B.p, 3); attr(gl, st.loc.e, B.e, 3); attr(gl, st.loc.mu, B.mu, 1); attr(gl, st.loc.bin, B.bin, 1); attr(gl, st.loc.end, B.end, 1); };
  if (Math.abs(state.year - NOW) > 1) {
    bind(R.lines);
    gl.uniform1f(st.loc.lines, 1);
    gl.drawArrays(gl.LINES, 0, R.nStars * 2);
  }
  bind(R.dots);
  gl.uniform1f(st.loc.lines, 0);
  gl.uniform1f(st.loc.ring, 0);
  gl.drawArrays(gl.POINTS, 0, R.nStars);
  if (rings && R.rings) {                                         // headset only: targets as gold rings (no HTML labels there)
    gl.bindBuffer(gl.ARRAY_BUFFER, R.rings.p);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, ringPositions());
    bind(R.rings);
    gl.uniform1f(st.loc.ring, 1);
    gl.drawArrays(gl.POINTS, 0, R.nRings);
    gl.uniform1f(st.loc.ring, 0);
  }
  for (const k of ["p0", "e", "mu", "bin", "end"]) if (st.loc[k] >= 0) gl.disableVertexAttribArray(st.loc[k]);
  gl.disable(gl.BLEND);
}

// ------------------------------------------------------------------------------------------ flat-screen frame
let W = 0, H = 0, DPR = 1;
/** Free space between the top bar + target chips and the bottom bar, for the panel and the zoom buttons. */
function layoutVars() {
  const root = document.documentElement.style;
  $("targets").style.top = Math.round($("top").getBoundingClientRect().bottom) + "px";   // the top bar wraps on small screens
  const fh = $("bottom").getBoundingClientRect().height, tb = $("targets").getBoundingClientRect().bottom;
  root.setProperty("--fh", Math.round(fh) + "px");
  root.setProperty("--th", Math.round(Math.max(tb, $("top").getBoundingClientRect().bottom)) + "px");
}
function resize() {
  layoutVars();
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = innerWidth; H = innerHeight;
  R.canvas.width = Math.round(W * DPR);
  R.canvas.height = Math.round(H * DPR);
  state.dirty = true;
}
function flatVP() {
  const { r, u, b } = cameraAxes();
  const proj = perspective(state.fov * D2R, W / H, 0.1, 1000);
  return mul(proj, viewFromAxes(r, u, b));
}
/** Screen position (CSS px) of an ICRS direction, or null when behind the viewer or off screen. */
function project(ra, dec, vp = state.vp) {
  if (!vp) return null;
  const p = toGL(unit(ra, dec));
  const x = vp[0] * p[0] + vp[4] * p[1] + vp[8] * p[2] + vp[12];
  const y = vp[1] * p[0] + vp[5] * p[1] + vp[9] * p[2] + vp[13];
  const w = vp[3] * p[0] + vp[7] * p[1] + vp[11] * p[2] + vp[15];
  if (w <= 1e-6) return null;
  return [(x / w + 1) / 2 * W, (1 - y / w) / 2 * H];
}
state.project = (ra, dec) => project(ra, dec);

function frame() {
  if (state.xr) { R.loop = false; return; }                     // the headset drives drawing now
  requestAnimationFrame(frame);
  if (state.playing) stepPlay();
  if (state.motion) { state.dirty = true; }
  if (!state.dirty) return;
  state.dirty = false;
  const gl = state.gl;
  if (state.motion) syncLookFromCamera();
  state.vp = flatVP();
  if (gl) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, R.canvas.width, R.canvas.height);
    gl.clearColor(0.02, 0.03, 0.05, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    drawScene(gl, state.vp, DPR * (state.fov < 30 ? 1.25 : 1));
    state.frames = (state.frames || 0) + 1;
  }
  placeLabels();
}
const redraw = () => { state.dirty = true; };
function startLoop() { if (!R.loop) { R.loop = true; requestAnimationFrame(frame); } }

// ------------------------------------------------------------------------------------------ data
async function getJSON(u) {
  for (let i = 0; i < 3; i++) {
    try { const r = await fetch(u); if (r.ok) return await r.json(); } catch (e) { /* retry */ }
    await new Promise((res) => setTimeout(res, 500 * (i + 1)));
  }
  return null;
}
async function loadStars() {
  const r = await fetch("data/fast_stars.json.gz");
  if (!r.ok) throw new Error("fast stars HTTP " + r.status);
  let u8 = new Uint8Array(await r.arrayBuffer());
  if (u8[0] === 0x1f && u8[1] === 0x8b) u8 = new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
  const doc = JSON.parse(new TextDecoder().decode(u8));
  const ix = Object.fromEntries(doc.fields.map((f, i) => [f, i]));
  return doc.stars.map((row) => {
    const pmra = row[ix.pmra], pmdec = row[ix.pmdec], pm = Math.hypot(pmra, pmdec);
    let bin = 0; while (bin < 3 && pm >= BINS[bin + 1]) bin++;
    return { sid: row[ix.sid], name: row[ix.name], pid: row[ix.pid], ra: row[ix.ra], dec: row[ix.dec], pmra, pmdec, pm, bin };
  }).sort((a, b) => a.pm - b.pm);                                  // slow first, fast drawn on top
}

/** Each target: position, epoch and catalogue motion (to move its label), plus the panel data. */
async function loadTargets() {
  const [tests, cats, ...metas] = await Promise.all([
    getJSON("data/verify/tests.json"), getJSON("data/categories.json"),
    ...TARGETS.map((tg) => (tg.id === "luhman16" ? null : getJSON(`data/${tg.id}/meta.json`))),
  ]);
  state.tests = tests;
  const lum = (cats?.categories || []).flatMap((c) => c.points || []).find((p) => p.id === "luhman16");
  TARGETS.forEach((tg, i) => {
    const m = metas[i];
    if (m) {
      state.meta[tg.id] = m;
      const g = m.gaia || {};
      Object.assign(tg, { name: m.target, ra0: g.ra_deg ?? m.ra, dec0: g.dec_deg ?? m.dec, ep: g.ref_epoch ?? NOW, pmra: g.pmra_mas_yr || 0, pmdec: g.pmdec_mas_yr || 0, src: g.label || "Gaia DR3" });
    } else if (tg.id === "luhman16" && lum) {
      Object.assign(tg, { name: lum.name, ra0: lum.ra, dec0: lum.dec, ep: lum.epoch, pmra: lum.pmra, pmdec: lum.pmdec, src: "SIMBAD" });
    }
    if (!tg.name) tg.name = FALLBACK_NAME[tg.id];
    tg.test = tg.test && tests?.tests?.find((x) => x.id === tg.test);
  });
}
function targetPos(tg, year = state.year) {
  if (tg.ra0 == null) return null;
  return propagateGC(tg.ra0, tg.dec0, tg.pmra, tg.pmdec, tg.ep, year);
}
state.targetPos = (id, y) => targetPos(TARGETS.find((x) => x.id === id), y);

// ------------------------------------------------------------------------------------------ labels and chips
function buildLabels() {
  const box = $("labels"), nav = $("targets");
  box.innerHTML = ""; nav.innerHTML = "";
  for (const tg of TARGETS) {
    if (tg.ra0 == null) continue;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "lbl" + (tg.slow ? " slow" : "");
    b.innerHTML = `<span class="ring"></span><span class="tx"></span>`;
    b.addEventListener("click", (e) => { e.stopPropagation(); openPanel(tg); });
    b.tabIndex = -1;                                              // the chips are the keyboard path
    box.appendChild(b);
    tg.el = b;
    const c = document.createElement("button");
    c.type = "button";
    c.addEventListener("click", () => { flyTo(tg); openPanel(tg); });
    nav.appendChild(c);
    tg.chip = c;
  }
  textLabels();
}
function textLabels() {
  for (const tg of TARGETS) {
    const nm = tname(tg.name);
    if (tg.el) { tg.el.querySelector(".tx").textContent = nm; tg.el.setAttribute("aria-label", nm); }
    if (tg.chip) tg.chip.textContent = nm;
  }
}
function placeLabels() {
  for (const tg of TARGETS) {
    if (!tg.el) continue;
    const rd = targetPos(tg);
    const xy = rd && project(rd[0], rd[1]);
    const vis = xy && xy[0] > -40 && xy[0] < W + 10 && xy[1] > -20 && xy[1] < H + 20;
    tg.el.style.display = vis ? "" : "none";
    if (vis) tg.el.style.transform = `translate(${xy[0].toFixed(1)}px, ${(xy[1] - 11).toFixed(1)}px)`;
  }
}

// ------------------------------------------------------------------------------------------ camera control
const clampDec = (d) => Math.max(-89.5, Math.min(89.5, d));
function setLook(ra, dec) { state.ra = ((ra % 360) + 360) % 360; state.dec = clampDec(dec); redraw(); }
function setFov(f) { state.fov = Math.max(12, Math.min(110, f)); redraw(); }
function degPerPx() { return state.fov / H; }
let flyAnim = null;
function flyTo(tg) {
  const rd = targetPos(tg);
  if (!rd) return;
  if (state.motion) toggleMotion(false);
  if (reduceMotion) { setLook(rd[0], rd[1]); setFov(Math.min(state.fov, 40)); return; }
  const r0 = state.ra, d0 = state.dec, f0 = state.fov, f1 = Math.min(state.fov, 40);
  let dra = ((rd[0] - r0 + 540) % 360) - 180;
  const t0 = performance.now(), T = 900;
  cancelAnimationFrame(flyAnim);
  const step = (now) => {
    const k = Math.min(1, (now - t0) / T), s = k * k * (3 - 2 * k);
    setLook(r0 + dra * s, d0 + (rd[1] - d0) * s);
    setFov(f0 + (f1 - f0) * s);
    if (k < 1) flyAnim = requestAnimationFrame(step);
  };
  flyAnim = requestAnimationFrame(step);
}

function pointerControls() {
  const c = R.canvas, pts = new Map();
  let moved = 0, pinch0 = null;
  c.addEventListener("pointerdown", (e) => {
    c.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    moved = 0;
    if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch0 = [Math.hypot(a[0] - b[0], a[1] - b[1]), state.fov]; }
    hideHint();
  });
  c.addEventListener("pointermove", (e) => {
    const p = pts.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p[0], dy = e.clientY - p[1];
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    moved += Math.abs(dx) + Math.abs(dy);
    if (pts.size === 2 && pinch0) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (d > 10) setFov(pinch0[1] * pinch0[0] / d);
      return;
    }
    if (state.motion) return;                                    // phone motion steers; dragging would fight it
    const k = degPerPx();
    setLook(state.ra + dx * k / Math.max(0.2, Math.cos(state.dec * D2R)) * 0.9, state.dec + dy * k);
  });
  const up = (e) => {
    const was = pts.has(e.pointerId);
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch0 = null;
    if (was && moved < 6 && e.type === "pointerup") pick(e.clientX, e.clientY);
  };
  c.addEventListener("pointerup", up);
  c.addEventListener("pointercancel", up);
  c.addEventListener("wheel", (e) => { e.preventDefault(); setFov(state.fov * Math.exp(e.deltaY * 0.0012)); hideHint(); }, { passive: false });
  addEventListener("keydown", (e) => {
    if (e.target.closest?.("input, textarea, select, a, button:not(.lbl)") && e.target.id !== "sky") return;
    const k = 3 * state.fov / 60;
    const map = { ArrowLeft: [k, 0], ArrowRight: [-k, 0], ArrowUp: [0, k], ArrowDown: [0, -k] };
    if (map[e.key] && !state.motion) { e.preventDefault(); setLook(state.ra + map[e.key][0] / Math.max(0.2, Math.cos(state.dec * D2R)), state.dec + map[e.key][1]); hideHint(); }
    else if (e.key === "+" || e.key === "=") { setFov(state.fov / 1.2); }
    else if (e.key === "-" || e.key === "_") { setFov(state.fov * 1.2); }
    else if (e.key === "Escape" && state.open) closePanel();
  });
  $("zin").addEventListener("click", () => setFov(state.fov / 1.25));
  $("zout").addEventListener("click", () => setFov(state.fov * 1.25));
}

/** Tap on the sky: the nearest moving star within 16 px (a target opens its panel). */
function pick(x, y) {
  if (!state.stars) return;
  let best = null, bd = 16 * 16;
  for (const s of state.stars) {
    const rd = propagateGC(s.ra, s.dec, s.pmra, s.pmdec, GAIA_EPOCH, state.year);
    const p = project(rd[0], rd[1]);
    if (!p) continue;
    const d = (p[0] - x) ** 2 + (p[1] - y) ** 2;
    if (d < bd) { bd = d; best = s; }
  }
  const tip = $("tip");
  if (!best) { tip.hidden = true; return; }
  const tg = TARGETS.find((x) => x.id === best.pid);
  if (tg) { openPanel(tg); tip.hidden = true; return; }
  tip.textContent = t("vr.star", { name: best.name ? tname(best.name) : `Gaia DR3 ${best.sid}`, pm: num(best.pm / 1000, 2) }, "{name}: {pm}″ per year (Gaia DR3)");
  tip.hidden = false;
  clearTimeout(pick.tm);
  pick.tm = setTimeout(() => { tip.hidden = true; }, 5000);
}

function hideHint() { $("hint").classList.add("gone"); }

// ------------------------------------------------------------------------------------------ time slider
const slider = $("time");
function setYear(y) {
  state.year = Math.max(NOW - RANGE, Math.min(NOW + RANGE, y));
  slider.value = String(Math.round(state.year - NOW));
  showYear();
  redraw();
}
state.setYear = setYear;
function fmtInt(v) { return Math.round(v).toLocaleString(lang() === "tr" ? "tr-TR" : "en-US"); }
function showYear() {
  const d = Math.round(state.year - NOW);
  const y = String(Math.round(state.year));                      // a calendar year: no thousands separator
  const rel = d === 0 ? t("vr.now", null, "now") : t(d > 0 ? "vr.after" : "vr.before", { n: fmtInt(Math.abs(d)) }, d > 0 ? "+{n} years" : "−{n} years");
  $("year").innerHTML = `<b>${t("vr.yearN", { y }, "{y}")}</b>${rel}`;
  slider.setAttribute("aria-valuetext", `${t("vr.yearN", { y }, "{y}")}, ${rel}`);
}
slider.addEventListener("input", () => { stopPlay(); setYear(NOW + Number(slider.value)); hideHint(); });
let playDir = 1, playT = 0;
function stepPlay() {
  const now = performance.now(), dt = playT ? Math.min(0.1, (now - playT) / 1000) : 0;
  playT = now;
  let y = state.year + playDir * dt * 400;                      // 400 years per second
  if (y >= NOW + RANGE) { y = NOW + RANGE; playDir = -1; }
  if (y <= NOW - RANGE) { y = NOW - RANGE; playDir = 1; }
  setYear(y);
}
function startPlay() { state.playing = true; playT = 0; $("play").textContent = "❚❚"; $("play").setAttribute("aria-label", t("vr.pause", null, "Stop time")); $("play").title = t("vr.pause", null, "Stop time"); hideHint(); }
function stopPlay() { state.playing = false; $("play").textContent = "▶"; $("play").setAttribute("aria-label", t("vr.play", null, "Run time")); $("play").title = t("vr.play", null, "Run time"); }
$("play").addEventListener("click", () => (state.playing ? stopPlay() : startPlay()));

// ------------------------------------------------------------------------------------------ target panel
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
let blinkTimer = null;
function openPanel(tg) {
  hideHint();
  state.open = tg;
  for (const x of TARGETS) x.chip?.setAttribute("aria-current", String(x === tg));
  renderPanel();
  $("panel").hidden = false;
  $("pClose").focus({ preventScroll: true });
}
function closePanel() {
  const tg = state.open;
  state.open = null;
  clearInterval(blinkTimer);
  $("panel").hidden = true;
  for (const x of TARGETS) x.chip?.setAttribute("aria-current", "false");
  tg?.chip?.focus({ preventScroll: true });
}
$("pClose").addEventListener("click", closePanel);

function renderPanel() {
  const tg = state.open;
  if (!tg) return;
  clearInterval(blinkTimer);
  $("pTag").textContent = t(`vr.tag.${tg.id}`, null, "");
  $("pTitle").textContent = tname(tg.name);
  const meta = state.meta[tg.id];
  $("pBlink").innerHTML = meta && tg.bin ? blinkHtml(meta, tg) : `<p class="fine">${esc(t("vr.noBlink", null, "No SPHEREx frames are stored on the site for this one; the sky explorer fetches them live."))}</p>`;
  $("pText").innerHTML = numbersHtml(tg, meta);
  $("pGo").innerHTML = tg.id === "luhman16"
    ? `<a href="explore.html?p=luhman16">${esc(t("vr.openSky", null, "Open in the sky explorer →"))}</a>`
    : `<a href="ornek.html?data=data/${tg.id}/">${esc(t("vr.open", null, "Open the full result →"))}</a>`;
  wireBlink();
}

function blinkHtml(meta, tg) {
  const bin = (meta.wavelength_bins || []).find((b) => b.wavelength_um === tg.bin) || (meta.wavelength_bins || [])[0];
  if (!bin || !bin.frames?.length) return "";
  const [Wp, Hp] = meta.grid?.png_px || [720, 770];
  const mk = (meta.markers || []).map((m) => m.png_xy).filter(Boolean);
  const cx = mk.length ? mk.reduce((s, p) => s + p[0], 0) / mk.length : Wp / 2;
  const cy = mk.length ? mk.reduce((s, p) => s + p[1], 0) / mk.length : (Hp + (meta.grid?.label_strip_px || 0)) / 2;
  const C = tg.crop, x0 = cx - C / 2, y0 = cy - C / 2;
  const imgs = bin.frames.map((f, i) => `<image href="data/${tg.id}/${esc(f.file)}" width="${Wp}" height="${Hp}" data-k="${i}"${i ? "" : ' class="on"'}/>`).join("");
  const rings = bin.frames.map((f, i) => {
    const m = (meta.markers || []).find((k) => k.epoch === f.epoch);
    return m?.png_xy ? `<circle class="rg${i ? "" : " on"}" data-k="${i}" cx="${m.png_xy[0]}" cy="${m.png_xy[1]}" r="${Math.max(5, C * 0.06)}"/>` : "";
  }).join("");
  const box = C * (meta.grid?.pixel_arcsec || 3) / (meta.grid?.upscale || 4) / 60;
  state.blinkEpochs = bin.frames.map((f) => f.epoch);
  return `<div class="blink" aria-label="${esc(t("vr.blinkAlt", null, "SPHEREx images of the same spot, one per season"))}" role="img">
    <svg viewBox="${x0.toFixed(1)} ${y0.toFixed(1)} ${C} ${C}" preserveAspectRatio="xMidYMid slice">${imgs}${rings}</svg>
    <span class="ep" id="pEp">${esc(month(bin.frames[0].epoch))}</span></div>
    <div class="bctl"><button type="button" class="btn" id="bPlay"></button><button type="button" class="btn" id="bNext">${esc(t("vr.next", null, "Next season"))}</button></div>
    <p class="fine">${esc(t("vr.blinkCap", { um: num(tg.bin, 1), box: num(box, 1) }, "Real SPHEREx images at {um} µm, one per season, {box}′ wide. Circle: catalogue position on that date."))}</p>`;
}
function wireBlink() {
  const svg = $("pBlink").querySelector("svg");
  if (!svg) return;
  const n = svg.querySelectorAll("image").length;
  let k = 0, playing = !reduceMotion;
  const show = (i) => {
    k = (i + n) % n;
    for (const el of svg.querySelectorAll("[data-k]")) el.classList.toggle("on", Number(el.dataset.k) === k);
    $("pEp").textContent = month(state.blinkEpochs[k]);
    state.blinkShown = k;
  };
  const btn = $("bPlay");
  const paint = () => { btn.textContent = playing ? t("vr.bPause", null, "Pause") : t("vr.bPlay", null, "Play"); btn.setAttribute("aria-pressed", String(playing)); };
  const run = () => { clearInterval(blinkTimer); if (playing) blinkTimer = setInterval(() => show(k + 1), 800); };
  btn.addEventListener("click", () => { playing = !playing; paint(); run(); });
  $("bNext").addEventListener("click", () => { playing = false; paint(); run(); show(k + 1); });
  paint(); run();
}

function numbersHtml(tg, meta) {
  const out = [];
  const T = tg.test?.numbers;
  if (T && T.speed_arcsec_yr != null) {
    out.push(`<p>${esc(t("vr.meas", { v: num(T.speed_arcsec_yr, 2), e: num(T.err_speed, 2), pa: num(T.pa_deg, 1) },
      "Measured by us in SPHEREx images, without being told where to look: {v} ± {e}″ per year, toward {pa}° (east of north)."))}</p>`);
    out.push(`<p class="fine">${esc(t("vr.ref", { src: tg.src || "", v: num(T.ref_speed, 2), pa: num(T.ref_pa, 1) }, "Catalogue ({src}): {v}″ per year, toward {pa}°."))}</p>`);
    if (tg.test.status === "pass") out.push(`<p class="ok">${esc(t("vr.pass", null, "Agrees with the catalogue within our 3σ test limit."))}</p>`);
    else out.push(`<p class="bad">${esc(t("vr.fail", { d: num(Math.abs(T.d_pa_deg ?? 0), 1), s: num(Math.abs(T.d_pa_sigma ?? 0), 1), v: num(Math.abs(T.d_speed_sigma ?? 0), 1) },
      "Speed agrees ({v}σ), but the direction is {d}° off ({s}σ): this test fails our 3σ limit."))}</p>`);
  } else if (tg.slow && meta) {
    const bins = meta.measured?.photometry?.bins || [];
    const b = bins.find((x) => x.wavelength_um === 4.6 && x.seasons?.length) || bins.filter((x) => x.seasons?.length).slice(-1)[0];
    if (b) {
      const s = b.seasons[b.seasons.length - 1];
      out.push(`<p>${esc(t("vr.bright", { um: num(b.wavelength_um, 1), r: num(s.ratio_to_first, 2), e: num(s.ratio_err, 2), a: month(b.seasons[0].epoch), b: month(s.epoch) },
        "Measured by us: at {um} µm it shone {r} ± {e} times as bright in {b} as in {a}."))}</p>`);
    }
    const pm = Math.hypot(tg.pmra, tg.pmdec) / 1000;
    out.push(`<p class="fine">${esc(t("vr.slow", { pm: num(pm, 3) }, "Its motion (Gaia DR3: {pm}″ per year) is far too small to see here; it changes its brightness instead."))}</p>`);
  }
  const pmc = Math.hypot(tg.pmra || 0, tg.pmdec || 0) / 1000;
  if (!tg.slow && pmc) {
    const shift = pmc * RANGE / 3600;
    out.push(`<p class="fine">${esc(t("vr.crawl", { d: num(shift, 1) }, "On the time slider its label moves up to {d}° in 2,000 years."))}</p>`);
  }
  return out.join("");
}

// ------------------------------------------------------------------------------------------ phone motion
const motionBtn = $("motionBtn");
function onOrient(e) {
  if (e.alpha == null && e.beta == null) return;
  const ang = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
  const q = deviceQuat(e.alpha || 0, e.beta || 0, e.gamma || 0, ang);
  if (!state.devQ) {                                             // first reading: keep looking where we were
    const f = qrot(q, [0, 0, -1]);
    const yawDev = Math.atan2(-f[2], f[0]);
    state.motionOffset = state.ra * D2R - yawDev;
  }
  state.devQ = q;
  state.gotOrient = true;
}
async function toggleMotion(on) {
  if (on) {
    try {
      if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
        const r = await DeviceOrientationEvent.requestPermission();
        if (r !== "granted") throw new Error("denied");
      }
    } catch (e) { flash(t("vr.motionDenied", null, "Motion sensors are not allowed here: drag to look around.")); return; }
    state.devQ = null; state.gotOrient = false;
    addEventListener("deviceorientation", onOrient);
    state.motion = true;
    setTimeout(() => { if (state.motion && !state.gotOrient) { toggleMotion(false); flash(t("vr.motionNone", null, "No motion sensor answered: drag to look around.")); } }, 1500);
  } else {
    removeEventListener("deviceorientation", onOrient);
    if (state.motion) syncLookFromCamera();
    state.motion = false; state.devQ = null;
  }
  motionBtn.setAttribute("aria-pressed", String(state.motion));
  motionBtn.textContent = state.motion ? t("vr.motionOff", null, "Stop phone motion") : t("vr.motionBtn", null, "Use phone motion");
  redraw();
}
function flash(msg) {
  const tip = $("tip");
  tip.textContent = msg; tip.hidden = false;
  clearTimeout(flash.tm); flash.tm = setTimeout(() => { tip.hidden = true; }, 5000);
}
motionBtn.addEventListener("click", () => toggleMotion(!state.motion));

// ------------------------------------------------------------------------------------------ WebXR
async function setupXR() {
  const btn = $("xrBtn");
  if (!state.gl || !navigator.xr || !window.isSecureContext) return;
  let ok = false;
  try { ok = await navigator.xr.isSessionSupported("immersive-vr"); } catch (e) { ok = false; }
  if (!ok) return;
  btn.hidden = false;
  btn.addEventListener("click", enterXR);
}
async function enterXR() {
  const gl = state.gl;
  try {
    await gl.makeXRCompatible();
    const session = await navigator.xr.requestSession("immersive-vr");
    state.xr = session;
    session.updateRenderState({ baseLayer: new XRWebGLLayer(session, gl), depthNear: 0.1, depthFar: 1000 });
    const ref = await session.requestReferenceSpace("local");
    const model = rotY((90 - state.ra) * D2R);                     // face the direction we were looking at
    const autoTime = !reduceMotion;
    let last = 0;
    session.addEventListener("select", () => { state.playing = !state.playing; });
    if (autoTime) state.playing = true;
    session.addEventListener("end", () => { state.xr = null; stopPlay(); redraw(); startLoop(); });
    const onXR = (time, xf) => {
      session.requestAnimationFrame(onXR);
      if (state.playing) { const dt = last ? Math.min(0.1, (time - last) / 1000) : 0; let y = state.year + playDir * dt * 300; if (y >= NOW + RANGE || y <= NOW - RANGE) playDir *= -1; setYear(y); }
      last = time;
      const pose = xf.getViewerPose(ref);
      if (!pose) return;
      const layer = session.renderState.baseLayer;
      gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
      gl.clearColor(0.02, 0.03, 0.05, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      for (const view of pose.views) {
        const vpt = layer.getViewport(view);
        gl.viewport(vpt.x, vpt.y, vpt.width, vpt.height);
        const vp = mul(mul(view.projectionMatrix, view.transform.inverse.matrix), model);
        drawScene(gl, vp, 1.6, true);
      }
    };
    session.requestAnimationFrame(onXR);
  } catch (e) {
    console.warn("vr: WebXR", e);
    state.xr = null;
    flash(t("vr.xrFail", null, "The headset view could not start."));
    startLoop();
  }
}

// ------------------------------------------------------------------------------------------ no WebGL
function showFlat(lost) {
  $("sky").hidden = true;
  $("zoom").hidden = true;
  $("hint").hidden = true;
  $("labels").hidden = true;
  $("flat").hidden = false;
  $("bottom").querySelector(".row").hidden = true;            // no dots to move without WebGL
  $("legend").hidden = true;
  $("flatImg").src = "data/vr/sky_2k.jpg";
  state.flat = lost ? "lost" : "nogl";
}

// ------------------------------------------------------------------------------------------ start
function onLangChange() {
  document.title = t("vr.title", null, document.title);
  setTimeout(layoutVars, 0);
  textLabels(); showYear();
  if (state.playing) startPlay(); else stopPlay();
  motionBtn.textContent = state.motion ? t("vr.motionOff", null, "Stop phone motion") : t("vr.motionBtn", null, "Use phone motion");
  if (state.open) renderPanel();
}

async function start() {
  // start position: ?ra=&dec= or ?t=<target id>, else Barnard's Star
  if (Q.has("ra") && Q.has("dec")) setLook(Number(Q.get("ra")) || 0, Number(Q.get("dec")) || 0);
  if (Q.has("fov")) setFov(Number(Q.get("fov")) || 60);
  if (Q.has("year")) setYear(Number(Q.get("year")) || NOW);
  showYear();
  stopPlay();
  onLang(onLangChange);
  document.title = t("vr.title", null, document.title);

  const gl = initGL();
  state.gl = gl;
  layoutVars();
  addEventListener("resize", layoutVars);
  $("about").addEventListener("toggle", layoutVars);
  const targetsP = loadTargets().then(() => { buildLabels(); layoutVars(); redraw(); }).catch((e) => console.warn("vr: targets", e));
  if (!gl) {
    showFlat(false);
    await targetsP;
    state.ready = true;
    return;
  }
  resize();
  addEventListener("resize", resize);
  pointerControls();
  startLoop();
  // touch device with motion sensors: offer phone motion
  if (typeof DeviceOrientationEvent !== "undefined" && matchMedia("(pointer: coarse)").matches) motionBtn.hidden = false;
  const skyP = loadSky(gl, "data/vr/sky_2k.jpg").catch((e) => console.warn("vr:", e));
  const retry = async (f, n = 3) => { for (let i = 1; ; i++) { try { return await f(); } catch (e) { if (i >= n) throw e; await new Promise((r) => setTimeout(r, 1000 * i)); } } };
  const starsP = retry(loadStars).then((stars) => {
    state.stars = stars;
    starBuffers(gl, stars);
    redraw();
  }).catch((e) => console.warn("vr: stars", e));
  await Promise.all([skyP, starsP, targetsP]);
  ringBuffers(gl);
  const qt = Q.get("t") && TARGETS.find((x) => x.id === Q.get("t"));
  if (qt) { const rd = targetPos(qt); if (rd) setLook(rd[0], rd[1]); openPanel(qt); }
  state.ready = true;
  setupXR();
  // the sharper sky once the first view is up (skipped on small textures and data saver)
  const save = navigator.connection && navigator.connection.saveData;
  if (R.maxTex >= 4096 && !save && !Q.has("small")) setTimeout(() => loadSky(gl, "data/vr/sky_4k.jpg").catch((e) => console.warn("vr:", e)), 300);
  setTimeout(hideHint, 9000);
}
start();
