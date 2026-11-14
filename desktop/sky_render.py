"""GPU sky renderer for the Fazari 3D sky viewer (vispy gloo, OpenGL 2.1 / GLSL 120).

The camera sits at the centre of the celestial sphere. Every layer is a set of unit vectors (ICRS)
that the vertex shader rotates into the camera frame and maps with a stereographic projection
(conformal: stars stay round, and it works from a 200 deg all-sky view down to a 0.05 deg field).

Layers, drawn back to front each frame:
  1. Milky Way: one full-screen quad; the fragment shader inverts the projection per pixel, turns the
     direction into galactic (l, b) and evaluates a procedural glow (disk + bulge + dust lane + fBm
     noise + Magellanic Clouds). Pure math, no image.
  2. Lines: RA/Dec grid, ecliptic, galactic equator.
  3. Stars: GPU point sprites; size and brightness from G magnitude against the zoom-dependent
     limiting magnitude, colour from BP-RP. Stored in a pool of fixed-size vertex buffers ("chunks"):
     each HEALPix tile is copied into a free range when it arrives (glBufferSubData) and the range is
     blanked when the tile is evicted, so arriving tiles never cause a full re-upload.
  4. Markers (category points, the picked point) and their labels.

Python does no per-star work per frame: a frame is ~10 draw calls with a few uniforms.
"""
from __future__ import annotations

import math
import os
import queue
import threading
import time
from collections import OrderedDict, deque

import numpy as np
from vispy import app, gloo, visuals

import sky_catalog as cat

# ICRS -> galactic rotation (Hipparcos definition)
ICRS_TO_GAL = np.array([[-0.0548755604162154, -0.8734370902348850, -0.4838350155487132],
                        [+0.4941094278755837, -0.4448296299600112, +0.7469822444972189],
                        [-0.8676661490190047, -0.1980763734312015, +0.4559837761750669]])
OBLIQUITY = math.radians(23.4392911)

COMMON = """
uniform mat3 u_rot;      // world -> camera, use as  v * u_rot
uniform float u_scale;   // 1 / (2 tan(fov/4))
uniform float u_aspect;  // width / height
vec4 project(vec3 cam) {
    vec2 p = 2.0 * cam.xy / (1.0 + max(cam.z, -0.98));
    return vec4(p.x * u_scale / u_aspect, p.y * u_scale, 0.0, 1.0);
}
"""

STAR_VS = COMMON + """
uniform float u_maglim;
uniform float u_dpr;
attribute vec3 a_pos;
attribute float a_mag;
attribute float a_col;
varying vec3 v_color;
varying float v_alpha;
varying float v_core;
vec3 star_color(float c) {
    c = clamp(c, -0.4, 3.5);
    vec3 c0 = vec3(0.62, 0.73, 1.00), c1 = vec3(0.84, 0.89, 1.00), c2 = vec3(1.00, 0.97, 0.93);
    vec3 c3 = vec3(1.00, 0.87, 0.70), c4 = vec3(1.00, 0.72, 0.50), c5 = vec3(1.00, 0.60, 0.42);
    if (c < 0.2) return mix(c0, c1, (c + 0.4) / 0.6);
    if (c < 0.8) return mix(c1, c2, (c - 0.2) / 0.6);
    if (c < 1.3) return mix(c2, c3, (c - 0.8) / 0.5);
    if (c < 2.2) return mix(c3, c4, (c - 1.3) / 0.9);
    return mix(c4, c5, (c - 2.2) / 1.3);
}
void main() {
    vec3 cam = a_pos * u_rot;
    float dm = u_maglim - a_mag;
    if (cam.z < -0.2 || dm < -0.25 || a_mag > 50.0) {
        gl_Position = vec4(3.0, 3.0, 3.0, 1.0);
        gl_PointSize = 0.0;
        v_alpha = 0.0;
        return;
    }
    gl_Position = project(cam);
    float s = clamp(1.3 + 0.85 * dm, 1.3, 15.0);          // core diameter in px
    float halo = 2.0 + 0.6 * max(dm - 4.0, 0.0);
    gl_PointSize = (s + 2.0 * halo) * u_dpr;
    v_core = s / (s + 2.0 * halo);
    v_alpha = clamp(0.28 + 0.26 * (dm + 0.25), 0.10, 1.0);
    v_color = star_color(a_col);
}
"""

STAR_FS = """
varying vec3 v_color;
varying float v_alpha;
varying float v_core;
void main() {
    float r = length(gl_PointCoord - vec2(0.5)) * 2.0;
    if (r > 1.0) discard;
    float x = r / v_core;
    float a = exp(-2.2 * x * x) + 0.10 * exp(-3.5 * r * r);
    gl_FragColor = vec4(v_color * a * v_alpha, 1.0);
}
"""

MW_VS = """
attribute vec2 a_ndc;
varying vec2 v_ndc;
void main() { v_ndc = a_ndc; gl_Position = vec4(a_ndc, 0.0, 1.0); }
"""

MW_FS = """
uniform mat3 u_rot;
uniform mat3 u_gal;
uniform float u_scale;
uniform float u_aspect;
uniform float u_gain;
uniform vec3 u_lmc;
uniform vec3 u_smc;
varying vec2 v_ndc;
float hash(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float noise(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x),
                   mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
               mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x),
                   mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float fbm(vec3 p) {
    float s = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { s += a * noise(p); p = p * 2.03 + vec3(1.7, 9.2, 3.1); a *= 0.5; }
    return s;
}
void main() {
    vec2 p = vec2(v_ndc.x * u_aspect, v_ndc.y) / u_scale;     // stereographic plane
    float s = dot(p, p) * 0.25;
    vec3 cam = vec3(p / (1.0 + s), (1.0 - s) / (1.0 + s));    // inverse stereographic
    vec3 world = u_rot * cam;                                  // = transpose(R) * cam
    vec3 g = world * u_gal;                                    // galactic unit vector
    float L = degrees(atan(g.y, g.x));                         // -180..180, 0 = centre
    float B = degrees(asin(clamp(g.z, -1.0, 1.0)));
    float n1 = fbm(world * 7.0);
    float n2 = fbm(world * 19.0 + vec3(5.0));
    float w = 4.5 + 6.5 * exp(-0.5 * L * L / (35.0 * 35.0)) + 2.0 * (n1 - 0.5);  // thicker toward the centre
    float disk = exp(-0.5 * B * B / (w * w)) * (0.30 + 0.70 * exp(-0.5 * L * L / (75.0 * 75.0)));
    float bulge = exp(-0.5 * (L * L + 2.2 * B * B) / (9.0 * 9.0));
    float rift = exp(-0.5 * pow((B - 0.6 + 2.5 * (n2 - 0.5)) / 2.6, 2.0)) * smoothstep(80.0, 15.0, abs(L - 15.0));
    float lane = clamp(rift * (0.35 + 0.5 * n2 + 0.45 * noise(world * 41.0)), 0.0, 0.85);
    float I = (disk * (0.45 + 1.1 * n1) + 1.4 * bulge) * (1.0 - lane);
    float dl = degrees(acos(clamp(dot(world, u_lmc), -1.0, 1.0)));
    float ds = degrees(acos(clamp(dot(world, u_smc), -1.0, 1.0)));
    I += 0.55 * exp(-0.5 * dl * dl / 9.0) * (0.6 + 0.8 * n2) + 0.30 * exp(-0.5 * ds * ds / 2.5) * (0.6 + 0.8 * n1);
    float warm = clamp(1.6 * bulge + 0.45 * exp(-0.5 * L * L / (45.0 * 45.0)), 0.0, 1.0);
    vec3 col = mix(vec3(0.55, 0.63, 0.86), vec3(1.00, 0.84, 0.62), warm);
    vec3 sky = vec3(0.004, 0.006, 0.016);
    gl_FragColor = vec4(sky + col * I * u_gain, 1.0);
}
"""

BLIT_VS = """
attribute vec2 a_ndc;
varying vec2 v_uv;
void main() { v_uv = a_ndc * 0.5 + 0.5; gl_Position = vec4(a_ndc, 0.0, 1.0); }
"""

BLIT_FS = """
uniform sampler2D u_tex;
varying vec2 v_uv;
void main() { gl_FragColor = vec4(texture2D(u_tex, v_uv).rgb, 1.0); }
"""

LINE_VS = COMMON + """
attribute vec3 a_pos;
varying float v_vis;
void main() {
    vec3 cam = a_pos * u_rot;
    v_vis = cam.z > -0.6 ? 1.0 : 0.0;
    gl_Position = project(cam);
}
"""

LINE_FS = """
uniform vec4 u_color;
varying float v_vis;
void main() { if (v_vis < 0.999) discard; gl_FragColor = u_color; }
"""

FOOT_VS = COMMON + """
attribute vec3 a_pos;
attribute vec4 a_color;
varying vec4 v_color;
varying float v_vis;
void main() {
    vec3 cam = a_pos * u_rot;
    v_vis = cam.z > -0.6 ? 1.0 : 0.0;
    v_color = a_color;
    gl_Position = project(cam);
}
"""

FOOT_FS = """
uniform float u_alpha;
varying vec4 v_color;
varying float v_vis;
void main() { if (v_vis < 0.999) discard; gl_FragColor = vec4(v_color.rgb, v_color.a * u_alpha); }
"""

MARK_VS = COMMON + """
uniform float u_dpr;
attribute vec3 a_pos;
attribute vec4 a_color;
attribute float a_size;
varying vec4 v_color;
varying float v_dot;
void main() {
    vec3 cam = a_pos * u_rot;
    v_dot = a_size > 0.0 ? 1.0 : 0.0;          // negative size: ring only (the star stays visible)
    if (cam.z < -0.2 || a_color.a <= 0.0) { gl_Position = vec4(3.0, 3.0, 3.0, 1.0); gl_PointSize = 0.0; v_color = vec4(0.0); return; }
    gl_Position = project(cam);
    gl_PointSize = abs(a_size) * u_dpr;
    v_color = a_color;
}
"""

MARK_FS = """
varying vec4 v_color;
varying float v_dot;
void main() {
    float r = length(gl_PointCoord - vec2(0.5)) * 2.0;
    float ring = smoothstep(0.62, 0.74, r) * (1.0 - smoothstep(0.90, 1.0, r));
    float dot_ = v_dot * (1.0 - smoothstep(0.10, 0.20, r));
    float a = max(ring, dot_) * v_color.a;
    if (a < 0.02) discard;
    gl_FragColor = vec4(v_color.rgb, a);
}
"""

HUD_VS = """
attribute vec2 a_xy;
void main() { gl_Position = vec4(a_xy, 0.0, 1.0); }
"""

HUD_FS = """
uniform vec4 u_color;
void main() { gl_FragColor = u_color; }
"""

STAR_DTYPE = np.dtype([("a_pos", np.float32, 3), ("a_mag", np.float32), ("a_col", np.float32)])
FOOT_DTYPE = np.dtype([("a_pos", np.float32, 3), ("a_color", np.float32, 4)])
MARK_DTYPE = np.dtype([("a_pos", np.float32, 3), ("a_color", np.float32, 4), ("a_size", np.float32)])


# ------------------------------------------------------------------------------- math
def basis(ra_deg, dec_deg):
    """Rows: screen right (west), screen up (north), forward. cam = M @ world."""
    a, d = math.radians(ra_deg), math.radians(dec_deg)
    f = np.array([math.cos(d) * math.cos(a), math.cos(d) * math.sin(a), math.sin(d)])
    e = np.array([-math.sin(a), math.cos(a), 0.0])
    n = np.array([-math.sin(d) * math.cos(a), -math.sin(d) * math.sin(a), math.cos(d)])
    return np.array([-e, n, f])


def xyz_to_radec(v):
    v = np.asarray(v, dtype=np.float64)
    ra = math.degrees(math.atan2(v[1], v[0])) % 360.0
    dec = math.degrees(math.asin(max(-1.0, min(1.0, v[2] / np.linalg.norm(v)))))
    return ra, dec


def ang_sep(ra1, dec1, ra2, dec2):
    a = cat.radec_to_xyz(ra1, dec1)
    b = cat.radec_to_xyz(ra2, dec2)
    return math.degrees(math.acos(max(-1.0, min(1.0, float(np.dot(a, b))))))


def polyline_segments(pts):
    """(N,3) polyline -> (2(N-1),3) segment pairs for GL_LINES."""
    pts = np.asarray(pts, np.float32)
    return np.repeat(pts, 2, axis=0)[1:-1]


def build_lines():
    grid = []
    t = np.radians(np.linspace(0, 360, 361))
    for dec in range(-75, 90, 15):
        d = math.radians(dec)
        grid.append(polyline_segments(np.stack([np.cos(d) * np.cos(t), np.cos(d) * np.sin(t), np.full_like(t, np.sin(d))], 1)))
    s = np.radians(np.linspace(-89, 89, 179))
    for ra in range(0, 360, 30):
        a = math.radians(ra)
        grid.append(polyline_segments(np.stack([np.cos(s) * math.cos(a), np.cos(s) * math.sin(a), np.sin(s)], 1)))
    ecl = np.stack([np.cos(t), np.sin(t) * math.cos(OBLIQUITY), np.sin(t) * math.sin(OBLIQUITY)], 1)
    gal = (ICRS_TO_GAL.T @ np.stack([np.cos(t), np.sin(t), np.zeros_like(t)], 0)).T
    return np.vstack(grid).astype(np.float32), polyline_segments(ecl), polyline_segments(gal)


def gal_to_xyz(l_deg, b_deg):
    v = cat.radec_to_xyz(l_deg, b_deg)       # same formula, galactic frame
    return ICRS_TO_GAL.T @ v


# ------------------------------------------------------------------------------- star pool
class StarPool:
    """Fixed-size GPU vertex buffers; tiles live in free ranges inside them."""
    CHUNK = 1 << 18                         # 262 144 stars = 5 MB per buffer

    def __init__(self, max_stars):
        self.max_chunks = max(1, int(math.ceil(max_stars / self.CHUNK)))
        self.chunks = []                     # [{"vbo", "free": [(off, n)], "used"}]
        self.used = 0

    def _new_chunk(self):
        blank = np.zeros(self.CHUNK, STAR_DTYPE)
        blank["a_mag"] = 99.0
        ch = {"vbo": gloo.VertexBuffer(blank), "free": [(0, self.CHUNK)], "used": 0}
        self.chunks.append(ch)
        return ch

    def alloc(self, arr5):
        n = len(arr5)
        if n == 0 or n > self.CHUNK:
            return None
        data = np.ascontiguousarray(arr5, np.float32).view(STAR_DTYPE).reshape(-1)
        cands = list(self.chunks)
        for ch in cands + [None]:
            if ch is None:
                if len(self.chunks) >= self.max_chunks:
                    return None
                ch = self._new_chunk()
            for i, (off, size) in enumerate(ch["free"]):
                if size >= n:
                    ch["vbo"].set_subdata(data, offset=off)
                    ch["free"][i] = (off + n, size - n)
                    if size == n:
                        ch["free"].pop(i)
                    ch["used"] += n
                    self.used += n
                    return (self.chunks.index(ch), off, n)
        return None

    def free(self, handle):
        ci, off, n = handle
        ch = self.chunks[ci]
        blank = np.zeros(n, STAR_DTYPE)
        blank["a_mag"] = 99.0
        ch["vbo"].set_subdata(blank, offset=off)
        fr = sorted(ch["free"] + [(off, n)])
        merged = []
        for o, s in fr:
            if merged and merged[-1][0] + merged[-1][1] == o:
                merged[-1] = (merged[-1][0], merged[-1][1] + s)
            else:
                merged.append((o, s))
        ch["free"] = merged
        ch["used"] -= n
        self.used -= n

    def fits(self, n):
        if len(self.chunks) < self.max_chunks:
            return True
        return any(s >= n for ch in self.chunks for _, s in ch["free"])

    def draw(self, program):
        for ch in self.chunks:
            if ch["used"]:
                program.bind(ch["vbo"])
                program.draw("points")


# ------------------------------------------------------------------------------- canvas
class SkyCanvas(app.Canvas):
    def __init__(self, max_stars=3_000_000, network=True, **kw):
        super().__init__(keys=None, **kw)
        self.ra0, self.dec0, self.fov = 266.4, -29.0, 120.0
        self.show_grid = True
        self.network = network
        self.dirty = True
        self.on_pick = None                   # callable(ra, dec)
        self.on_hover = None
        self._anim = None
        self._press = None
        self._last_lod = 0.0
        self._lod_dirty = True
        self._labels_dirty = True
        self.first_frame_s = None
        self.t_created = time.perf_counter()
        self.frame_times = deque(maxlen=600)
        self.draw_ms = deque(maxlen=600)
        self.finish_gl = False                # benchmark: glFinish in every frame
        self.events_log = deque(maxlen=50)

        self.p_star = gloo.Program(STAR_VS, STAR_FS)
        self.p_mw = gloo.Program(MW_VS, MW_FS)
        self.p_line = gloo.Program(LINE_VS, LINE_FS)
        self.p_mark = gloo.Program(MARK_VS, MARK_FS)
        self.p_foot = gloo.Program(FOOT_VS, FOOT_FS)
        self.foot_vb = None
        self.show_footprints = True
        self.show_stars = True
        self.show_milky_way = True
        self.show_markers = True
        self.show_lines = True
        quad = np.array([[-1, -1], [1, -1], [-1, 1], [1, 1]], np.float32)
        self.p_mw["a_ndc"] = quad
        # The Milky Way is evaluated at half resolution into a texture, and only when the view changed
        self.mw_tex = gloo.Texture2D(shape=(8, 8, 3), interpolation="linear", wrapping="clamp_to_edge")
        self.mw_fbo = gloo.FrameBuffer(color=self.mw_tex)
        self.mw_key = None
        self.p_blit = gloo.Program(BLIT_VS, BLIT_FS)
        self.p_blit["a_ndc"] = quad
        self.p_blit["u_tex"] = self.mw_tex
        self.p_mw["u_gal"] = ICRS_TO_GAL.astype(np.float32)
        self.p_mw["u_lmc"] = gal_to_xyz(280.47, -32.89).astype(np.float32)
        self.p_mw["u_smc"] = gal_to_xyz(302.80, -44.30).astype(np.float32)
        grid, ecl, gal = build_lines()
        self.vb_grid, self.vb_ecl, self.vb_gal = (gloo.VertexBuffer(x) for x in (grid, ecl, gal))

        # stars: base layer + LOD tiles
        self.pool = StarPool(max_stars)
        self.max_stars = max_stars
        self.base = None                       # (N,5) float32, also on the GPU via the pool
        self.base_handle = None
        self.resident: OrderedDict = OrderedDict()   # key -> {"h", "n", "mag"}
        self.wanted: set = set()
        self.loader = TileLoaderProxy(self)
        self.hp_cache = {}
        self.hp_ready = threading.Event()
        self.tile_log = deque(maxlen=400)       # (t, key, n, src, seconds)
        self.dropped = 0

        # markers
        self.marks = None
        self.mark_vb = None
        self.pick_vb = gloo.VertexBuffer(np.zeros(1, MARK_DTYPE))
        self.pick_xyz = None
        self.labels = visuals.TextVisual("", color=(0.85, 0.9, 1.0, 0.9), font_size=8,
                                         anchor_x="left", anchor_y="bottom")
        self.label_names = []
        self.label_xyz = np.zeros((0, 3))
        self.label_show = np.zeros(0, bool)

        # compass (N and E at the view centre, recomputed from the projection every frame)
        self.p_hud = gloo.Program(HUD_VS, HUD_FS)
        self.hud_vb = gloo.VertexBuffer(np.zeros((64, 2), np.float32))
        self.p_hud["a_xy"] = self.hud_vb
        self.hud_text = visuals.TextVisual(["N", "E"], color=(0.95, 0.95, 1.0, 1.0), font_size=10,
                                           anchor_x="center", anchor_y="center", bold=True)
        self.hud_info = visuals.TextVisual("", color=(0.75, 0.82, 0.95, 0.9), font_size=8,
                                           anchor_x="left", anchor_y="center")
        self.show_compass = True
        self.compass_dirs = None               # (north, east) unit vectors on screen, y up
        self.hud_idx = [gloo.IndexBuffer(np.arange(a, b, dtype=np.uint32)) for a, b in ((0, 64), (64, 70), (70, 76))]
        self._hud_info_text = None

        gloo.set_clear_color("black")
        self.stats = {"stars_view": 0, "maglim": 0.0}
        for tv in (self.labels, self.hud_text, self.hud_info):
            tv.transforms.configure(canvas=self, viewport=(0, 0) + tuple(self.physical_size))
        threading.Thread(target=self._warmup, daemon=True, name="warmup").start()

    # ---------------------------------------------------------------- data
    def _warmup(self):
        try:
            import astropy.units  # noqa: F401  (slow first import, kept off the GUI thread)
            from astropy_healpix import HEALPix
            for lv in cat.LEVELS:
                self.hp_cache[lv["order"]] = HEALPix(nside=2 ** lv["order"], order="nested")
            self.hp_ready.set()
        except Exception as e:
            self.events_log.append(f"astropy-healpix unavailable: {e}")
        if cat.load_base_cached() is None and self.network:
            try:
                rows = cat.fetch_base()
                self.loader.results.put((("base",), cat.to_gpu(rows), {"src": "esa"}))
            except Exception as e:
                self.events_log.append(f"base layer download failed: {e}")

    def load_base_now(self):
        rows = cat.load_base_cached()
        if rows is not None:
            self._set_base(cat.to_gpu(rows))

    def _set_base(self, arr):
        self.base = arr
        if self.base_handle is not None:
            self.pool.free(self.base_handle)
        self.base_handle = self.pool.alloc(arr)
        self.dirty = True

    def set_markers(self, xyz, colors, sizes, names):
        m = np.zeros(len(xyz), MARK_DTYPE)
        m["a_pos"], m["a_color"], m["a_size"] = xyz, colors, sizes
        self.marks = m
        self.mark_vb = gloo.VertexBuffer(m) if len(m) else None
        self.label_names = list(names)
        self.label_xyz = np.asarray(xyz, np.float64).reshape(-1, 3)
        self.label_show = np.asarray(colors)[:, 3] > 0 if len(m) else np.zeros(0, bool)
        self.labels.text = self.label_names if self.label_names else ""
        self._labels_dirty = True
        self.dirty = True

    def set_footprints(self, polygons, colors):
        """polygons: list of [[ra, dec] x 4] (ICRS deg); colors: list of RGBA. Edges follow great
        circles (12 steps per edge, interpolated in float64)."""
        if not polygons:
            self.foot_vb = None
            self.dirty = True
            return
        pts, cols = [], []
        t = np.linspace(0.0, 1.0, 13)[:, None]
        for poly, col in zip(polygons, colors):
            v = cat.radec_to_xyz(np.array(poly)[:, 0], np.array(poly)[:, 1])
            for i in range(len(v)):
                a, b = v[i], v[(i + 1) % len(v)]
                seg = (1 - t) * a + t * b
                seg /= np.linalg.norm(seg, axis=1, keepdims=True)
                pts.append(polyline_segments(seg))
                cols.append(np.tile(np.asarray(col, np.float32), (2 * (len(seg) - 1), 1)))
        d = np.zeros(sum(len(x) for x in pts), FOOT_DTYPE)
        d["a_pos"] = np.vstack(pts)
        d["a_color"] = np.vstack(cols)
        self.foot_vb = gloo.VertexBuffer(d)
        self.dirty = True

    def set_pick(self, ra, dec):
        p = np.zeros(1, MARK_DTYPE)
        p["a_pos"] = cat.radec_to_xyz(ra, dec)
        p["a_color"] = (0.2, 1.0, 0.9, 1.0)
        p["a_size"] = -40.0
        self.pick_vb.set_data(p)
        self.pick_xyz = p["a_pos"][0]
        self.dirty = True

    # ---------------------------------------------------------------- camera
    @property
    def scale(self):
        return 1.0 / (2.0 * math.tan(math.radians(self.fov) / 4.0))

    @property
    def aspect(self):
        w, h = self.size
        return w / max(h, 1)

    def view_radius(self):
        """Angular distance (deg) from the view centre to a screen corner."""
        r = math.hypot(self.aspect, 1.0) / self.scale
        return math.degrees(2.0 * math.atan(r / 2.0))

    MAX_FOV_WIDE = 120.0      # deg across the widest screen dimension: the whole sky never fits
    MIN_FOV = 0.03

    def max_fov(self):
        """Largest vertical fov (deg) so that the wider screen side spans at most MAX_FOV_WIDE."""
        a = max(self.aspect, 1.0)
        return math.degrees(4.0 * math.atan(math.tan(math.radians(self.MAX_FOV_WIDE) / 4.0) / a))

    def fov_wide(self):
        """Field of view (deg) across the wider screen side."""
        a = max(self.aspect, 1.0)
        return math.degrees(4.0 * math.atan(a * math.tan(math.radians(self.fov) / 4.0)))

    def set_view(self, ra=None, dec=None, fov=None):
        if ra is not None:
            self.ra0 = ra % 360.0
        if dec is not None:
            self.dec0 = max(-89.9, min(89.9, dec))
        if fov is not None:
            self.fov = max(self.MIN_FOV, min(self.max_fov(), fov))
            self.at_widest = fov >= self.max_fov() - 1e-6
        self.dirty = self._lod_dirty = self._labels_dirty = True

    def pick(self, px, py):
        w, h = self.size
        x = (2.0 * px / w - 1.0) * self.aspect / self.scale
        y = (1.0 - 2.0 * py / h) / self.scale
        s = (x * x + y * y) / 4.0
        cam = np.array([x / (1 + s), y / (1 + s), (1 - s) / (1 + s)])
        return xyz_to_radec(basis(self.ra0, self.dec0).T @ cam)

    def project_xyz(self, xyz):
        """(N,3) -> (N,2) logical pixels and a mask of points in front of the camera."""
        w, h = self.size
        cam = np.asarray(xyz, np.float64).reshape(-1, 3) @ basis(self.ra0, self.dec0).T
        den = 1.0 + np.maximum(cam[:, 2], -0.98)
        px = (cam[:, 0] * 2 / den * self.scale / self.aspect + 1) * w / 2
        py = (1 - cam[:, 1] * 2 / den * self.scale) * h / 2
        return np.stack([px, py], 1), cam[:, 2] > -0.2

    def project(self, ra, dec):
        (p,), (ok,) = self.project_xyz(cat.radec_to_xyz(ra, dec))
        return (float(p[0]), float(p[1])) if ok else None

    def pan_pixels(self, dx, dy):
        rad_pp = 2.0 / (self.size[1] * self.scale)
        d = math.degrees(rad_pp)
        self.set_view(ra=self.ra0 + dx * d / max(math.cos(math.radians(self.dec0)), 0.05),
                      dec=self.dec0 + dy * d)

    def zoom_at(self, factor, px=None, py=None):
        """Zoom by factor. With a pixel (cursor, pinch centre) the sky point under it stays on it: change the
        field, then move the centre to the sky point at (centre + error) until that point is back on its pixel
        (the projection is not uniform, so a few rounds; converges to < 0.01 px)."""
        if px is None:
            self.set_view(fov=self.fov * factor)
            return
        ra_b, dec_b = self.pick(px, py)
        self.set_view(fov=self.fov * factor)
        w, h = self.size
        for _ in range(5):
            p = self.project(ra_b, dec_b)
            if p is None:
                break
            ex, ey = p[0] - px, p[1] - py
            if math.hypot(ex, ey) < 0.01:
                break
            ra_c, dec_c = self.pick(w / 2.0 + ex, h / 2.0 + ey)
            self.set_view(ra=ra_c, dec=dec_c)

    def fly_to(self, ra, dec, fov=None, duration=None):
        fov = self.fov if fov is None else max(self.MIN_FOV, min(self.max_fov(), fov))
        a = cat.radec_to_xyz(self.ra0, self.dec0)
        b = cat.radec_to_xyz(ra, dec)
        sep = math.degrees(math.acos(max(-1.0, min(1.0, float(a @ b)))))
        if duration is None:
            duration = min(2.6, 0.9 + 0.7 * math.log10(1 + sep) + 0.15 * abs(math.log10(fov / self.fov)))
        lf0, lf1 = math.log(self.fov), math.log(max(fov, 0.03))
        bump = max(0.0, math.log(min(max(sep * 1.3, 1e-3), self.max_fov())) - max(lf0, lf1))
        self._anim = {"t0": time.perf_counter(), "T": duration, "a": a, "b": b, "sep": math.radians(sep),
                      "lf0": lf0, "lf1": lf1, "bump": bump}

    def _step_anim(self):
        an = self._anim
        t = min(1.0, (time.perf_counter() - an["t0"]) / an["T"])
        e = t * t * (3 - 2 * t)
        om = an["sep"]
        if om < 1e-9:
            v = an["b"]
        else:
            v = (math.sin((1 - e) * om) * an["a"] + math.sin(e * om) * an["b"]) / math.sin(om)
        ra, dec = xyz_to_radec(v)
        lf = (1 - e) * an["lf0"] + e * an["lf1"] + an["bump"] * 4 * e * (1 - e)
        self.set_view(ra, dec, math.exp(lf))
        if t >= 1.0:
            self._anim = None

    @property
    def animating(self):
        return self._anim is not None

    # ---------------------------------------------------------------- LOD
    def tick(self):
        """Called by the GUI timer (~60 Hz): animation, finished tiles, LOD, redraw if needed."""
        if self._anim is not None:
            self._step_anim()
        self._drain_tiles()
        now = time.perf_counter()
        if self._lod_dirty and now - self._last_lod > 0.2 and self.hp_ready.is_set():
            self._last_lod = now
            self._lod_dirty = False
            self._update_lod()
        if self.dirty:
            self.update()

    def _update_lod(self):
        maglim = cat.maglim_for_fov(self.fov)
        rad = self.view_radius()
        scored = cat.wanted_tiles((self.ra0, self.dec0), rad, self.fov, self.hp_cache)
        self.wanted = {k for _, k in scored}
        for k in self.wanted:
            if k in self.resident:
                self.resident.move_to_end(k)
        self.loader.want(scored, self.resident)
        n = self.count_in_view(maglim)
        self.stats.update(stars_view=n, maglim=maglim, radius=rad)

    def count_in_view(self, maglim=None):
        """Stars actually drawn: inside the screen rectangle and brighter than the limit."""
        maglim = cat.maglim_for_fov(self.fov) if maglim is None else maglim
        parts = []
        if self.base is not None:
            parts.append(self.base[:int(np.searchsorted(self.base[:, 3], maglim + 0.25)), :3])
        for k in self.wanted:
            t = self.resident.get(k)
            if t is not None and t["n"]:
                parts.append(t["xyz"][:int(np.searchsorted(t["mag"], maglim + 0.25))])
        if not parts:
            return 0
        xyz = np.concatenate(parts)
        cam = xyz @ basis(self.ra0, self.dec0).T.astype(np.float32)
        ok = cam[:, 2] > -0.2
        den = 1.0 + cam[:, 2]
        x = np.abs(2 * cam[:, 0] / den * self.scale / self.aspect)
        y = np.abs(2 * cam[:, 1] / den * self.scale)
        return int((ok & (x <= 1.0) & (y <= 1.0)).sum())

    def _drain_tiles(self):
        got = False
        t_end = time.perf_counter() + 0.008              # at most ~8 ms of uploads per frame
        while time.perf_counter() < t_end:
            try:
                key, arr, info = self.loader.results.get_nowait()
            except queue.Empty:
                break
            if key == ("base",):
                if arr is not None:
                    self._set_base(arr)
                    got = True
                continue
            self.tile_log.append((time.perf_counter(), key, 0 if arr is None else len(arr), info.get("src"), info.get("s", 0)))
            if arr is None or key in self.resident or key not in self.wanted or len(arr) == 0:
                if arr is not None and len(arr) == 0:
                    self.resident[key] = {"h": None, "n": 0, "mag": arr[:, 3].copy(), "xyz": arr[:, :3]}
                continue
            self._make_room(len(arr))
            h = self.pool.alloc(arr)
            if h is None:
                self.dropped += 1
                continue
            self.resident[key] = {"h": h, "n": len(arr), "mag": arr[:, 3].copy(), "xyz": arr[:, :3]}
            got = True
        if got:
            self.dirty = True
            self._lod_dirty = True                      # refresh the star count

    def _make_room(self, n):
        while self.pool.used + n > self.max_stars or not self.pool.fits(n):
            victim = next((k for k in self.resident if k not in self.wanted), None)
            if victim is None:
                return
            t = self.resident.pop(victim)
            if t["h"] is not None:
                self.pool.free(t["h"])

    @property
    def stars_resident(self):
        return self.pool.used

    # ---------------------------------------------------------------- vispy events
    def on_resize(self, ev):
        if not hasattr(self, "labels"):
            return
        gloo.set_viewport(0, 0, *self.physical_size)
        self.labels.transforms.configure(canvas=self, viewport=(0, 0) + tuple(self.physical_size))
        self.hud_text.transforms.configure(canvas=self, viewport=(0, 0) + tuple(self.physical_size))
        self.hud_info.transforms.configure(canvas=self, viewport=(0, 0) + tuple(self.physical_size))
        self.fov = self.max_fov() if getattr(self, "at_widest", False) else max(self.MIN_FOV, min(self.max_fov(), self.fov))
        self.dirty = self._lod_dirty = self._labels_dirty = True

    def on_mouse_press(self, ev):
        self._press = (ev.pos[0], ev.pos[1], ev.pos[0], ev.pos[1], 0.0)
        self._anim = None

    def on_mouse_move(self, ev):
        if self._press is None or not ev.is_dragging:
            return
        x0, y0, lx, ly, tot = self._press
        dx, dy = ev.pos[0] - lx, ev.pos[1] - ly
        self.pan_pixels(dx, dy)
        self._press = (x0, y0, ev.pos[0], ev.pos[1], tot + abs(dx) + abs(dy))

    def on_mouse_release(self, ev):
        if self._press is None:
            return
        x0, y0, _, _, tot = self._press
        self._press = None
        if tot < 4 and ev.button == 1:
            ra, dec = self.pick(ev.pos[0], ev.pos[1])
            self.set_pick(ra, dec)
            if self.on_pick:
                self.on_pick(ra, dec)

    def on_mouse_wheel(self, ev):
        self._anim = None
        self.zoom_at(0.85 ** ev.delta[1], ev.pos[0], ev.pos[1])

    def on_key_press(self, ev):
        k = ev.key.name if ev.key else ""
        step = 40
        if k == "Left":
            self.pan_pixels(step, 0)
        elif k == "Right":
            self.pan_pixels(-step, 0)
        elif k == "Up":
            self.pan_pixels(0, step)
        elif k == "Down":
            self.pan_pixels(0, -step)
        elif ev.text in ("+", "="):
            self.zoom_at(0.8)
        elif ev.text in ("-", "_"):
            self.zoom_at(1.25)
        elif ev.text in ("g", "G"):
            self.show_grid = not self.show_grid
            self.dirty = True
        elif ev.text in ("r", "R"):
            self.fly_to(266.4, -29.0, self.max_fov())

    # ---------------------------------------------------------------- drawing
    def _uniforms(self, prog):
        prog["u_rot"] = basis(self.ra0, self.dec0).astype(np.float32)   # used as v * u_rot -> M @ v
        prog["u_scale"] = self.scale
        prog["u_aspect"] = self.aspect

    def _update_labels(self):
        if not len(self.label_names):
            return
        xy, ok = self.project_xyz(self.label_xyz)
        w, h = self.size
        inside = ok & self.label_show & (xy[:, 0] > -50) & (xy[:, 0] < w) & (xy[:, 1] > 0) & (xy[:, 1] < h + 20)
        pr = self.pixel_scale
        pos = np.where(inside[:, None], (xy + [9, -6]) * pr, -10000.0)
        self.labels.pos = pos.astype(np.float32)
        self._labels_dirty = False

    def on_draw(self, ev):
        if not hasattr(self, "pick_vb"):          # a draw event can arrive during __init__
            return
        t0 = time.perf_counter()
        self.dirty = False
        gloo.set_viewport(0, 0, *self.physical_size)   # Qt does not always set it before paintGL
        gloo.clear()
        # 1. Milky Way (opaque, sets the background)
        gloo.set_state(blend=False, depth_test=False)
        pw, ph = self.physical_size
        w2, h2 = max(8, pw // 2), max(8, ph // 2)
        key = (self.ra0, self.dec0, self.fov, w2, h2)
        if not self.show_milky_way:
            key = None
            self.mw_key = None
        elif key != self.mw_key:
            if self.mw_tex.shape[:2] != (h2, w2):
                self.mw_tex.resize((h2, w2, 3))
            self._uniforms(self.p_mw)      # GLSL sees the numpy matrix transposed: u_rot * cam = R^T cam
            self.p_mw["u_gain"] = 0.26 if self.fov > 20 else 0.26 * (0.55 + 0.45 * self.fov / 20)
            with self.mw_fbo:
                gloo.set_viewport(0, 0, w2, h2)
                self.p_mw.draw("triangle_strip")
            gloo.set_viewport(0, 0, pw, ph)
            self.mw_key = key
        if self.show_milky_way:
            self.p_blit.draw("triangle_strip")
        # 2. lines
        gloo.set_state(blend=True, blend_func=("src_alpha", "one_minus_src_alpha"))
        self._uniforms(self.p_line)
        for vb, col, on in ((self.vb_grid, (0.35, 0.5, 0.8, 0.22), self.show_grid),
                            (self.vb_gal, (0.6, 0.45, 0.8, 0.22), self.show_grid),
                            (self.vb_ecl, (0.95, 0.8, 0.3, 0.45), True)):
            if on and self.show_lines:
                self.p_line["u_color"] = col
                self.p_line["a_pos"] = vb
                self.p_line.draw("lines")
        # 3. stars (additive)
        gloo.set_state(blend=True, blend_func=("one", "one"))
        self._uniforms(self.p_star)
        self.p_star["u_maglim"] = cat.maglim_for_fov(self.fov)
        self.p_star["u_dpr"] = float(self.pixel_scale)
        if self.show_stars:
            self.pool.draw(self.p_star)
        if self.show_footprints and self.foot_vb is not None:
            gloo.set_state(blend=True, blend_func=("src_alpha", "one_minus_src_alpha"))
            self._uniforms(self.p_foot)
            # SPHEREx images are 3.5 deg wide: when zoomed in far, their edges only cross the view
            self.p_foot["u_alpha"] = float(np.clip((self.fov_wide() - 1.5) / 6.0, 0.12, 1.0))
            self.p_foot.bind(self.foot_vb)
            self.p_foot.draw("lines")
        # 4. markers + labels
        gloo.set_state(blend=True, blend_func=("src_alpha", "one_minus_src_alpha"))
        self._uniforms(self.p_mark)
        self.p_mark["u_dpr"] = float(self.pixel_scale)
        if self.mark_vb is not None and self.show_markers:
            self.p_mark.bind(self.mark_vb)
            self.p_mark.draw("points")
        if self.pick_xyz is not None:
            self.p_mark.bind(self.pick_vb)
            self.p_mark.draw("points")
        if len(self.label_names) and self.show_markers:
            if self._labels_dirty:
                self._update_labels()
            self.labels.draw()
        if self.show_compass:
            self._draw_compass()
        if self.finish_gl:
            gloo.flush()
            gloo.gl.glFinish()
        t1 = time.perf_counter()
        self.frame_times.append(t1)
        self.draw_ms.append((t1 - t0) * 1000)
        if self.first_frame_s is None:
            self.first_frame_s = t1

    def compass_directions(self):
        """Screen directions (x right, y up) of celestial north and east at the view centre,
        measured by projecting two points 0.5% of the field away from the centre."""
        d = self.fov * 0.005
        c = self.project(self.ra0, self.dec0)
        dec_n = self.dec0 + d if self.dec0 + d <= 90 else self.dec0 - d
        n = self.project(self.ra0, dec_n)
        e = self.project(self.ra0 + d / max(math.cos(math.radians(self.dec0)), 1e-3), self.dec0)
        out = []
        for q, sgn in ((n, 1.0 if dec_n > self.dec0 else -1.0), (e, 1.0)):
            v = np.array([q[0] - c[0], c[1] - q[1]]) * sgn
            out.append(v / max(np.linalg.norm(v), 1e-9))
        return out

    def _draw_compass(self):
        w, h = self.size
        pr = self.pixel_scale
        R = 30.0
        cx, cy = 18 + R, h - 18 - R - 14                  # logical px, y down
        north, east = self.compass_dirs = self.compass_directions()

        def ndc(x, y):                                   # logical px (y down) -> NDC
            return (2 * x / w - 1, 1 - 2 * y / h)
        t = np.linspace(0, 2 * np.pi, 33)
        ring = [ndc(cx + R * math.cos(a), cy + R * math.sin(a)) for a in t]
        segs = []
        for i in range(32):
            segs += [ring[i], ring[i + 1]]
        arrows = []
        for v, L in ((north, R * 0.95), (east, R * 0.7)):
            tip = (cx + v[0] * L, cy - v[1] * L)
            side = (-v[1], v[0])
            base = (cx + v[0] * (L - 7), cy - v[1] * (L - 7))
            arrows.append([ndc(cx, cy), ndc(*tip),
                           ndc(*tip), ndc(base[0] + side[0] * 4, base[1] - side[1] * 4),
                           ndc(*tip), ndc(base[0] - side[0] * 4, base[1] + side[1] * 4)])
        data = np.array(segs + arrows[0] + arrows[1], np.float32)
        self.hud_vb.set_data(data)
        self.p_hud["a_xy"] = self.hud_vb
        gloo.set_state(blend=True, blend_func=("src_alpha", "one_minus_src_alpha"))
        n_ring = len(segs)
        self.p_hud["u_color"] = (0.6, 0.7, 0.9, 0.55)
        self.p_hud.draw("lines", self.hud_idx[0])
        self.p_hud["u_color"] = (1.0, 0.45, 0.35, 0.95)
        self.p_hud.draw("lines", self.hud_idx[1])
        self.p_hud["u_color"] = (0.45, 0.85, 1.0, 0.95)
        self.p_hud.draw("lines", self.hud_idx[2])
        lab_n = (cx + north[0] * (R + 10), cy - north[1] * (R + 10))
        lab_e = (cx + east[0] * (R * 0.7 + 10), cy - east[1] * (R * 0.7 + 10))
        self.hud_text.pos = np.array([lab_n, lab_e], np.float32) * pr
        self.hud_text.draw()
        ra_h = (self.ra0 % 360) / 15.0
        txt = (f"looking at RA {int(ra_h):02d}h{(ra_h % 1) * 60:04.1f}m  Dec {self.dec0:+05.1f}\u00b0   "
                              f"field {self.fov_wide():.3g}\u00b0 x {self.fov:.3g}\u00b0")
        if txt != self._hud_info_text:
            self.hud_info.text = self._hud_info_text = txt
        self.hud_info.pos = (np.array([cx + R + 22, cy + R - 2], np.float32) * pr)
        self.hud_info.draw()

    def fps(self, window=1.0):
        if len(self.frame_times) < 2:
            return 0.0
        now = time.perf_counter()
        ts = [t for t in self.frame_times if now - t <= window]
        if len(ts) < 2:
            return 0.0
        return (len(ts) - 1) / max(ts[-1] - ts[0], 1e-6)

    def close_loader(self):
        self.loader.close()


class TileLoaderProxy:
    """Starts the TileLoader threads lazily (first LOD request), so start-up stays light."""

    def __init__(self, canvas):
        self._canvas = canvas
        self._loader = None
        self.results = queue.Queue()

    def _get(self):
        if self._loader is None:
            self._loader = cat.TileLoader()
            self._loader.results = self.results
        return self._loader

    def want(self, scored, resident):
        if not self._canvas.network:
            # offline: only what is on disk
            scored = [(s, k) for s, k in scored if cat.tile_path(cat.LEVELS[k[0]], k[1]).exists()]
        if scored or self._loader is not None:
            self._get().want(scored, resident)

    @property
    def pending(self):
        return self._loader.pending if self._loader else 0

    @property
    def stats(self):
        return self._loader.stats if self._loader else {"net": 0, "disk": 0, "fail": 0, "net_s": 0.0, "fallback": 0}

    def close(self):
        if self._loader:
            self._loader.close()
