// Small animated GIF (GIF89a) encoder for the "Save GIF" button of the result layout (js/cp_save.js).
// Written for this site (no outside code): one fixed 256-colour palette (128 greys for the sky picture, a small
// colour cube for the rings, arrows and labels), LZW compression as in the GIF89a specification, endless loop.
//   encodeGif([{ rgba, w, h }], { delayMs }) -> Uint8Array (all frames the same size)

const GREYS = 128;                                   // indices 0..127: grey levels
const CR = 5, CG = 5, CB = 4;                        // indices 128..227: colour cube 5 x 5 x 4

/** The palette, 256 x RGB. */
function palette() {
  const p = new Uint8Array(768);
  for (let i = 0; i < GREYS; i++) { const v = Math.round(i * 255 / (GREYS - 1)); p[3 * i] = p[3 * i + 1] = p[3 * i + 2] = v; }
  let k = GREYS;
  for (let r = 0; r < CR; r++) for (let g = 0; g < CG; g++) for (let b = 0; b < CB; b++, k++) {
    p[3 * k] = Math.round(r * 255 / (CR - 1)); p[3 * k + 1] = Math.round(g * 255 / (CG - 1)); p[3 * k + 2] = Math.round(b * 255 / (CB - 1));
  }
  return p;                                          // 228..255 stay black (unused)
}

/** RGBA pixels -> palette indices: near-grey pixels to the grey ramp, coloured ones to the cube. */
export function indexPixels(rgba, n) {
  const out = new Uint8Array(n);
  for (let i = 0, o = 0; i < n; i++, o += 4) {
    const r = rgba[o], g = rgba[o + 1], b = rgba[o + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx - mn <= 18) out[i] = Math.round((r * 0.299 + g * 0.587 + b * 0.114) * (GREYS - 1) / 255);
    else out[i] = GREYS + Math.round(r * (CR - 1) / 255) * CG * CB + Math.round(g * (CG - 1) / 255) * CB + Math.round(b * (CB - 1) / 255);
  }
  return out;
}

/** A growable byte buffer. */
function bytes() {
  let buf = new Uint8Array(1 << 16), n = 0;
  const grow = (k) => { if (n + k <= buf.length) return; let m = buf.length * 2; while (m < n + k) m *= 2; const b = new Uint8Array(m); b.set(buf.subarray(0, n)); buf = b; };
  return {
    byte(v) { grow(1); buf[n++] = v & 255; },
    u16(v) { grow(2); buf[n++] = v & 255; buf[n++] = (v >> 8) & 255; },
    all(a) { grow(a.length); buf.set(a, n); n += a.length; },
    str(s) { for (let i = 0; i < s.length; i++) this.byte(s.charCodeAt(i)); },
    done() { return buf.slice(0, n); },
  };
}

/** LZW codes of one frame (minimum code size 8), packed little-endian, before the split into sub-blocks. */
export function lzw(idx) {
  const MIN = 8, CLEAR = 1 << MIN, EOI = CLEAR + 1;
  const out = bytes();
  let size = MIN + 1, next = EOI + 1, cur = 0, bits = 0;
  let table = new Map();
  const emit = (c) => { cur |= c << bits; bits += size; while (bits >= 8) { out.byte(cur & 255); cur >>>= 8; bits -= 8; } };
  emit(CLEAR);
  let w = idx[0];
  for (let i = 1; i < idx.length; i++) {
    const k = idx[i], key = (w << 8) | k, c = table.get(key);
    if (c !== undefined) { w = c; continue; }
    emit(w);
    if (next === 4096) { emit(CLEAR); table = new Map(); next = EOI + 1; size = MIN + 1; }
    else { if (next >= (1 << size)) size++; table.set(key, next++); }
    w = k;
  }
  emit(w);
  emit(EOI);
  if (bits > 0) out.byte(cur & 255);
  return out.done();
}

/** frames: [{ rgba: Uint8ClampedArray, w, h }] of one size. delayMs: time per frame. */
export function encodeGif(frames, { delayMs = 800 } = {}) {
  if (!frames.length) throw new Error("no frames");
  const W = frames[0].w, H = frames[0].h, o = bytes();
  o.str("GIF89a");
  o.u16(W); o.u16(H);
  o.byte(0xf7); o.byte(0); o.byte(0);                // global colour table of 256 entries, 8 bits
  o.all(palette());
  o.byte(0x21); o.byte(0xff); o.byte(11); o.str("NETSCAPE2.0"); o.byte(3); o.byte(1); o.u16(0); o.byte(0);   // loop forever
  const cs = Math.max(2, Math.round(delayMs / 10));
  for (const f of frames) {
    if (f.w !== W || f.h !== H) throw new Error("frames differ in size");
    o.byte(0x21); o.byte(0xf9); o.byte(4); o.byte(0x04); o.u16(cs); o.byte(0); o.byte(0);    // graphic control: keep, delay
    o.byte(0x2c); o.u16(0); o.u16(0); o.u16(W); o.u16(H); o.byte(0);                         // image descriptor, no local table
    o.byte(8);
    const data = lzw(indexPixels(f.rgba, W * H));
    for (let p = 0; p < data.length; p += 255) { const n = Math.min(255, data.length - p); o.byte(n); o.all(data.subarray(p, p + n)); }
    o.byte(0);
  }
  o.byte(0x3b);
  return o.done();
}
