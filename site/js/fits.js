// Minimal FITS reader for remote SPHEREx L2 files, driven by HTTP Range reads.
// Only header blocks are walked; data is read as row ranges (one request per layer).
// Layout of the S3 files: pipeline/S3_LAYOUT.md. FLAGS is a RICE_1 tile-compressed image
// (one tile per row); IMAGE / ZODI / VARIANCE are plain big-endian float32.
//
// A "source" is {read(start, end) -> Promise<Uint8Array>, readSuffix?(n)}; see net.js
// (S3) and tests/ (local files).

export const BLOCK = 2880;
const pad = (n) => Math.ceil(n / BLOCK) * BLOCK;

// ---- header parsing ----------------------------------------------------------------------
function parseValue(raw) {
  const s = raw.trim();
  if (s.startsWith("'")) {                      // string, '' escapes a quote
    let out = "", i = 1;
    while (i < s.length) {
      if (s[i] === "'") {
        if (s[i + 1] === "'") { out += "'"; i += 2; continue; }
        break;
      }
      out += s[i++];
    }
    return { value: out.replace(/\s+$/, ""), rest: s.slice(i + 1) };
  }
  const slash = s.indexOf("/");
  const v = (slash >= 0 ? s.slice(0, slash) : s).trim();
  if (v === "T") return { value: true };
  if (v === "F") return { value: false };
  if (v === "") return { value: null };
  const num = Number(v.replace(/[dD]/, "e"));
  return { value: Number.isNaN(num) ? v : num };
}

/**
 * Parse header cards from bytes (latin1). Returns {cards: Map, endIndex} where endIndex is
 * the byte length of the header padded to 2880, or -1 when END was not found in `bytes`.
 */
export function parseHeader(bytes) {
  const cards = new Map();
  const n = Math.floor(bytes.length / 80);
  for (let i = 0; i < n; i++) {
    let card = "";
    for (let k = 0; k < 80; k++) card += String.fromCharCode(bytes[i * 80 + k]);
    const key = card.slice(0, 8).trim();
    if (key === "END") return { cards, length: pad((i + 1) * 80) };
    if (card.slice(8, 10) !== "= " || !key) continue;
    if (!cards.has(key)) cards.set(key, parseValue(card.slice(10)).value);
  }
  return { cards, length: -1 };
}

/** Header helper: h.get('NAXIS1'), h.num('X', default), h.str(...). */
export class Header {
  constructor(cards) { this.cards = cards; }
  has(k) { return this.cards.has(k); }
  get(k, d = undefined) { return this.cards.has(k) ? this.cards.get(k) : d; }
  num(k, d = undefined) { const v = this.cards.get(k); return typeof v === "number" ? v : d; }
  str(k, d = "") { const v = this.cards.get(k); return v == null ? d : String(v).trim(); }
}

function dataSize(h) {
  const naxis = h.num("NAXIS", 0);
  if (!naxis) return 0;
  let n = 1;
  for (let i = 1; i <= naxis; i++) n *= h.num(`NAXIS${i}`, 0);
  return (Math.abs(h.num("BITPIX", 8)) / 8) * h.num("GCOUNT", 1) * (h.num("PCOUNT", 0) + n);
}

/**
 * Read the HDU header that starts at `offset`. First reads `guess` bytes, extends if END is
 * not found. Returns {name, offset, header, headerLength, dataOffset, dataSize, nextOffset,
 * extra} where extra = bytes read past the header (may hold the start of the data).
 */
export async function readHduAt(src, offset, guess = 8 * BLOCK) {
  let buf = await src.read(offset, offset + guess);
  for (let tries = 0; tries < 8; tries++) {
    const first = String.fromCharCode(...buf.subarray(0, 8));
    if (first !== "XTENSION" && first !== "SIMPLE  ") {
      throw new Error(`no FITS header at byte ${offset}`);
    }
    const { cards, length } = parseHeader(buf);
    if (length > 0) {
      const header = new Header(cards);
      const size = dataSize(header);
      return {
        name: header.str("EXTNAME", offset === 0 ? "PRIMARY" : ""),
        offset, header, headerLength: length,
        dataOffset: offset + length, dataSize: size,
        nextOffset: offset + length + pad(size),
        extra: buf.subarray(length),
      };
    }
    const more = await src.read(offset + buf.length, offset + buf.length + 8 * BLOCK);
    if (!more.length) break;
    const b2 = new Uint8Array(buf.length + more.length);
    b2.set(buf); b2.set(more, buf.length);
    buf = b2;
  }
  throw new Error(`header at byte ${offset} has no END card`);
}

/** Find a header with EXTNAME `name` among 2880-byte blocks of `bytes` (e.g. a suffix read). */
function findHduInBuffer(bytes, name) {
  for (let off = 0; off + BLOCK <= bytes.length; off += BLOCK) {
    if (String.fromCharCode(...bytes.subarray(off, off + 8)) !== "XTENSION") continue;
    const { cards, length } = parseHeader(bytes.subarray(off));
    if (length < 0) continue;
    const h = new Header(cards);
    if (h.str("EXTNAME") !== name) continue;
    const size = dataSize(h);
    if (off + length + size > bytes.length) return null;
    return { header: h, data: bytes.subarray(off + length, off + length + size) };
  }
  return null;
}

// ---- binary tables --------------------------------------------------------------------
const TYPES = { L: 1, X: 0, B: 1, I: 2, J: 4, K: 8, A: 1, E: 4, D: 8, C: 8, M: 16, P: 8, Q: 16 };

function parseTform(tf) {
  const m = /^\s*(\d*)([LXBIJKAEDCMPQ])/.exec(tf);
  if (!m) throw new Error(`unsupported TFORM ${tf}`);
  const repeat = m[1] === "" ? 1 : Number(m[1]);
  const code = m[2];
  return { repeat, code, width: code === "X" ? Math.ceil(repeat / 8) : repeat * TYPES[code] };
}

/** Decode all rows of a (small) binary table. Returns {COLNAME: [rowValues...]} (numbers). */
export function readBinTable(header, data) {
  const nf = header.num("TFIELDS");
  const rowLen = header.num("NAXIS1");
  const nrows = header.num("NAXIS2");
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const cols = {};
  let colOff = 0;
  for (let f = 1; f <= nf; f++) {
    const name = header.str(`TTYPE${f}`, `COL${f}`);
    const tf = parseTform(header.str(`TFORM${f}`));
    const rows = [];
    for (let r = 0; r < nrows; r++) {
      const base = r * rowLen + colOff;
      const vals = new Array(tf.repeat);
      for (let k = 0; k < tf.repeat; k++) {
        const o = base + k * (TYPES[tf.code] || 1);
        switch (tf.code) {
          case "B": vals[k] = dv.getUint8(o); break;
          case "I": vals[k] = dv.getInt16(o, false); break;
          case "J": vals[k] = dv.getInt32(o, false); break;
          case "K": vals[k] = Number(dv.getBigInt64(o, false)); break;
          case "E": vals[k] = dv.getFloat32(o, false); break;
          case "D": vals[k] = dv.getFloat64(o, false); break;
          default: vals[k] = null;
        }
      }
      rows.push(vals);
    }
    cols[name] = rows;
    colOff += tf.width;
  }
  return cols;
}

// ---- RICE_1 decompression (cfitsio fits_rdecomp, 32-bit pixels) ---------------------------
/** Decode one RICE_1 tile of `n` int32 pixels into out[outOff ...]. */
export function riceDecode32(c, n, nblock, out, outOff = 0) {
  const fsbits = 5, fsmax = 25, bbits = 32;
  let p = 0;
  let lastpix = ((c[0] << 24) | (c[1] << 16) | (c[2] << 8) | c[3]) | 0;
  p = 4;
  let b = c[p++];           // bit buffer
  let nbits = 8;            // valid bits in b
  for (let i = 0; i < n;) {
    nbits -= fsbits;
    while (nbits < 0) { b = ((b << 8) | c[p++]) >>> 0; nbits += 8; }
    const fs = (b >>> nbits) - 1;
    b &= (1 << nbits) - 1;
    const imax = Math.min(i + nblock, n);
    if (fs < 0) {
      for (; i < imax; i++) out[outOff + i] = lastpix;
    } else if (fs === fsmax) {
      for (; i < imax; i++) {
        let k = bbits - nbits;
        let diff = k >= 32 ? 0 : (b << k) >>> 0;
        for (k -= 8; k >= 0; k -= 8) { b = c[p++]; diff = (diff | (b << k)) >>> 0; }
        if (nbits > 0) { b = c[p++]; diff = (diff | (b >>> -k)) >>> 0; b &= (1 << nbits) - 1; }
        else b = 0;
        diff = (diff & 1) === 0 ? diff >>> 1 : ~(diff >>> 1);
        lastpix = (diff + lastpix) | 0;
        out[outOff + i] = lastpix;
      }
    } else {
      for (; i < imax; i++) {
        while (b === 0) { nbits += 8; b = c[p++]; }
        const nzero = nbits - (32 - Math.clz32(b));
        nbits -= nzero + 1;
        b ^= 1 << nbits;
        nbits -= fs;
        while (nbits < 0) { b = ((b << 8) | c[p++]) >>> 0; nbits += 8; }
        let diff = ((nzero << fs) | (b >>> nbits)) >>> 0;
        b &= (1 << nbits) - 1;
        diff = (diff & 1) === 0 ? diff >>> 1 : ~(diff >>> 1);
        lastpix = (diff + lastpix) | 0;
        out[outOff + i] = lastpix;
      }
    }
  }
  return out;
}

// ---- remote SPHEREx L2 file -----------------------------------------------------------------
const FIRST_READ = 12 * BLOCK;        // PRIMARY + IMAGE header (23040 or 25920 bytes seen)
const WAVE_TAIL = 2 * BLOCK;          // WCS-WAVE header + data = last 5760 bytes
const VAR_HDR_GUESS = 4 * BLOCK;      // VARIANCE header length seen in all files (11520)

/**
 * A SPHEREx L2 file. open() reads PRIMARY+IMAGE header and the WCS-WAVE tail;
 * openLayers() locates FLAGS and ZODI by walking headers; readRegion() reads rows.
 */
export class SpherexFile {
  constructor(src) { this.src = src; }

  /** Stage 1: IMAGE header (WCS) + WCS-WAVE table. Two parallel requests. */
  async open() {
    const [head, tail] = await Promise.all([
      this.src.read(0, FIRST_READ),
      this.src.readSuffix ? this.src.readSuffix(WAVE_TAIL).catch(() => null) : Promise.resolve(null),
    ]);
    const prim = parseHeader(head);
    if (prim.length < 0) throw new Error("primary header too long");
    const imageOff = prim.length + pad(dataSize(new Header(prim.cards)));
    let image;
    const rest = head.subarray(imageOff);
    const ph = parseHeader(rest);
    if (ph.length > 0 && String.fromCharCode(...rest.subarray(0, 8)) === "XTENSION") {
      const header = new Header(ph.cards);
      const size = dataSize(header);
      image = { name: header.str("EXTNAME"), offset: imageOff, header, headerLength: ph.length,
                dataOffset: imageOff + ph.length, dataSize: size, nextOffset: imageOff + ph.length + pad(size) };
    } else {
      image = await readHduAt(this.src, imageOff);
    }
    if (image.name !== "IMAGE") throw new Error(`HDU 1 is ${image.name}, expected IMAGE`);
    this.image = image;
    this.header = image.header;
    let wave = tail ? findHduInBuffer(tail, "WCS-WAVE") : null;
    if (!wave) wave = await this._walkToWave();
    this.waveTable = readBinTable(wave.header, wave.data);
    return this;
  }

  async _walkToWave() {
    await this.openLayers();
    let off = this.zodi.nextOffset;
    for (let i = 0; i < 4; i++) {
      const h = await readHduAt(this.src, off, 2 * BLOCK);
      if (h.name === "WCS-WAVE") {
        const data = await this.src.read(h.dataOffset, h.dataOffset + h.dataSize);
        return { header: h.header, data };
      }
      off = h.nextOffset;
    }
    throw new Error("WCS-WAVE extension not found");
  }

  /** Stage 2: FLAGS header + tile descriptors, then the ZODI header (VARIANCE is skipped). */
  async openLayers() {
    if (this._layers) return this._layers;
    this._layers = (async () => {
      await this.openFlags();
      // VARIANCE follows FLAGS; ZODI follows VARIANCE. Guess the VARIANCE header length (11520
      // in all files seen), check that the guess lands on the ZODI header, else walk.
      const varOff = this.flags.nextOffset;
      const imgBytes = this.image.dataSize;
      let zodi = null;
      try {
        const z = await readHduAt(this.src, varOff + VAR_HDR_GUESS + pad(imgBytes), 4 * BLOCK);
        if (z.name === "ZODI") zodi = z;
      } catch (_) { /* fall back */ }
      if (!zodi) {
        const v = await readHduAt(this.src, varOff, 4 * BLOCK);
        zodi = await readHduAt(this.src, v.nextOffset, 4 * BLOCK);
      }
      if (zodi.name !== "ZODI") throw new Error(`expected ZODI, found ${zodi.name}`);
      delete zodi.extra;
      this.zodi = zodi;
      return this;
    })();
    try { return await this._layers; } catch (e) { this._layers = null; throw e; }
  }

  /** FLAGS header + tile descriptors only (one request; enough for a region without ZODI). */
  async openFlags() {
    if (this._flags) return this._flags;
    this._flags = (async () => {
      const flagsOff = this.image.nextOffset;
      const descBytes = 8 * 2040;
      const flags = await readHduAt(this.src, flagsOff, 6 * BLOCK + descBytes);
      if (flags.name !== "FLAGS") throw new Error(`expected FLAGS at ${flagsOff}, found ${flags.name}`);
      const fh = flags.header;
      const compressed = fh.get("ZIMAGE") === true;
      if (compressed) {
        const nrows = fh.num("NAXIS2");
        const rowLen = fh.num("NAXIS1");
        let tbl = flags.extra.subarray(0, nrows * rowLen);
        if (tbl.length < nrows * rowLen) tbl = await this.src.read(flags.dataOffset, flags.dataOffset + nrows * rowLen);
        const tf = parseTform(fh.str("TFORM1"));
        if (tf.code !== "P" && tf.code !== "Q") throw new Error("FLAGS: unexpected TFORM1 " + fh.str("TFORM1"));
        const cmp = fh.str("ZCMPTYPE");
        if (cmp !== "RICE_1") throw new Error(`FLAGS: compression ${cmp} not supported`);
        const dv = new DataView(tbl.buffer, tbl.byteOffset, tbl.byteLength);
        const count = new Float64Array(nrows), off = new Float64Array(nrows);
        for (let r = 0; r < nrows; r++) {
          if (tf.code === "P") { count[r] = dv.getInt32(r * rowLen, false); off[r] = dv.getInt32(r * rowLen + 4, false); }
          else { count[r] = Number(dv.getBigInt64(r * rowLen, false)); off[r] = Number(dv.getBigInt64(r * rowLen + 8, false)); }
        }
        let blocksize = 32, bytepix = 4;
        for (let i = 1; i <= 9; i++) {
          const n = fh.str(`ZNAME${i}`);
          if (n === "BLOCKSIZE") blocksize = fh.num(`ZVAL${i}`);
          if (n === "BYTEPIX") bytepix = fh.num(`ZVAL${i}`);
        }
        if (fh.num("ZBITPIX") !== 32 || bytepix !== 4) throw new Error("FLAGS: only 32-bit RICE supported");
        flags.tiles = {
          count, off, blocksize,
          heap: flags.dataOffset + fh.num("THEAP", nrows * rowLen),
          nx: fh.num("ZNAXIS1"), ny: fh.num("ZNAXIS2"),
          tileX: fh.num("ZTILE1", fh.num("ZNAXIS1")), tileY: fh.num("ZTILE2", 1),
        };
        if (flags.tiles.tileX !== flags.tiles.nx) throw new Error("FLAGS: tiles must span full rows");
      }
      delete flags.extra;
      this.flags = flags;
      return this;
    })();
    try { return await this._flags; } catch (e) { this._flags = null; throw e; }
  }

  /** Rows y0..y1 (0-based, inclusive) of a float32 image HDU -> Float32Array (ny x NAXIS1). */
  async readFloatRows(hdu, y0, y1) {
    const nx = hdu.header.num("NAXIS1");
    const bp = hdu.header.num("BITPIX");
    if (bp !== -32) throw new Error(`${hdu.name}: BITPIX ${bp} not supported`);
    const start = hdu.dataOffset + y0 * nx * 4;
    const bytes = await this.src.read(start, hdu.dataOffset + (y1 + 1) * nx * 4);
    const n = (y1 - y0 + 1) * nx;
    const out = new Float32Array(n);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const bscale = hdu.header.num("BSCALE", 1), bzero = hdu.header.num("BZERO", 0);
    for (let i = 0; i < n; i++) out[i] = dv.getFloat32(4 * i, false);
    if (bscale !== 1 || bzero !== 0) for (let i = 0; i < n; i++) out[i] = out[i] * bscale + bzero;
    return out;
  }

  /** Rows y0..y1 of FLAGS -> Int32Array (ny x nx). One heap request. */
  async readFlagRows(y0, y1) {
    const f = this.flags;
    if (!f.tiles) {   // plain int32 image (cutouts)
      const nx = f.header.num("NAXIS1");
      const bytes = await this.src.read(f.dataOffset + y0 * nx * 4, f.dataOffset + (y1 + 1) * nx * 4);
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const out = new Int32Array((y1 - y0 + 1) * nx);
      for (let i = 0; i < out.length; i++) out[i] = dv.getInt32(4 * i, false);
      return out;
    }
    const t = f.tiles;
    const ty0 = Math.floor(y0 / t.tileY), ty1 = Math.floor(y1 / t.tileY);
    let lo = Infinity, hi = -Infinity;
    for (let k = ty0; k <= ty1; k++) { lo = Math.min(lo, t.off[k]); hi = Math.max(hi, t.off[k] + t.count[k]); }
    const heap = await this.src.read(t.heap + lo, t.heap + hi);
    const out = new Int32Array((y1 - y0 + 1) * t.nx);
    const tilePix = t.nx * t.tileY;
    const tmp = new Int32Array(tilePix);
    for (let k = ty0; k <= ty1; k++) {
      const c = heap.subarray(t.off[k] - lo, t.off[k] - lo + t.count[k]);
      const rows = Math.min(t.tileY, t.ny - k * t.tileY);
      riceDecode32(c, t.nx * rows, t.blocksize, tmp, 0);
      for (let r = 0; r < rows; r++) {
        const y = k * t.tileY + r;
        if (y < y0 || y > y1) continue;
        out.set(tmp.subarray(r * t.nx, (r + 1) * t.nx), (y - y0) * t.nx);
      }
    }
    return out;
  }

  /** ZODI on rows y0..y1 from SPARSE_ROWS full rows: per column a quadratic in y (least squares).
   * ZODI is a smooth model: tested on 45 0.4 deg cutouts, 99 % of the pixels within 0.03 sigma of the
   * real layer (pipeline/fetch_region.py model_zodi, same method); ~40 kB instead of 8 kB per row. */
  async readZodiSparse(y0, y1) {
    const H = y1 - y0 + 1;
    const ys = [...new Set(Array.from({ length: Math.min(SPARSE_ROWS, H) }, (_, i) =>
      Math.round(y0 + (i * (H - 1)) / Math.max(1, Math.min(SPARSE_ROWS, H) - 1))))];
    if (ys.length < 4) return this.readFloatRows(this.zodi, y0, y1);
    const rows = await Promise.all(ys.map((y) => this.readFloatRows(this.zodi, y, y)));
    const nx = this.zodi.header.num("NAXIS1");
    // normal equations of [1, t, t^2] at the sampled t = y - y0, solved once (same for every column)
    const t = ys.map((y) => y - y0);
    const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (const v of t) for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) M[a][b] += v ** (a + b);
    const inv = inv3(M);
    const W = t.map((v) => [0, 1, 2].map((a) => inv[a][0] + inv[a][1] * v + inv[a][2] * v * v));   // coef_a = sum_k W[k][a] z_k
    const out = new Float32Array(H * nx);
    for (let x = 0; x < nx; x++) {
      let c0 = 0, c1 = 0, c2 = 0, bad = false, sum = 0;
      for (let k = 0; k < ys.length; k++) {
        const z = rows[k][x];
        if (!Number.isFinite(z)) { bad = true; continue; }
        sum += z; c0 += W[k][0] * z; c1 += W[k][1] * z; c2 += W[k][2] * z;
      }
      if (bad) { const m = sum / ys.length; for (let j = 0; j < H; j++) out[j * nx + x] = m; continue; }
      for (let j = 0; j < H; j++) out[j * nx + x] = c0 + c1 * j + c2 * j * j;
    }
    return out;
  }

  /** IMAGE, FLAGS and ZODI rows y0..y1 (in parallel; ZODI from SPARSE_ROWS rows, see readZodiSparse).
   * zodi: false skips the ZODI header and rows (the quick preview subtracts a median instead); zodi is
   * then null. zodi: "full" reads every ZODI row. */
  async readRegion(y0, y1, { zodi: withZodi = true } = {}) {
    if (withZodi) await this.openLayers(); else await this.openFlags();
    const [image, flags, zodi] = await Promise.all([
      this.readFloatRows(this.image, y0, y1),
      this.readFlagRows(y0, y1),
      !withZodi ? Promise.resolve(null)
        : withZodi === "full" ? this.readFloatRows(this.zodi, y0, y1) : this.readZodiSparse(y0, y1),
    ]);
    return { y0, y1, nx: this.image.header.num("NAXIS1"), image, flags, zodi };
  }
}

const SPARSE_ROWS = 5;

function inv3(m) {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [[A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
          [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
          [C / det, -(a * h - b * g) / det, (a * e - b * d) / det]];
}

/** Flag bit masks by name, from the MSKNnnnn keywords of a header (FLAGS or IMAGE). */
export function flagBits(header) {
  const bits = {};
  for (const [k, v] of header.cards) {
    const m = /^MSKN(\d{4})$/.exec(k);
    if (m) bits[String(v).trim()] = 2 ** Number(m[1]);
  }
  return bits;
}
