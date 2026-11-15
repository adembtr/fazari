// A small one-page PDF writer for the result report (js/cp_save.js). Written for this site (no outside code), after
// the PDF 1.4 specification:
//   - text in the standard Helvetica fonts (nothing embedded), WinAnsi encoding plus the Turkish letters ğ Ğ ş Ş ı İ and
//     the minus sign through a /Differences table, so the text stays selectable and searchable;
//   - JPEG pictures as they are (DCTDecode), filled rectangles, lines and clickable web links.
// Coordinates are in points from the TOP-LEFT corner of the page (converted to PDF's bottom-left here).
//   const d = pdfPage({ title }); d.text(x, y, "…", { size, bold, color }); d.image(jpegBytes, pw, ph, x, y, w, h);
//   d.rect(x, y, w, h, color); d.line(x1, y1, x2, y2, color, width); d.link(x, y, w, h, url); d.bytes() -> Uint8Array

export const A4 = { w: 595.28, h: 841.89 };

// ---- text encoding -------------------------------------------------------------------------------------------
// Unused / rarely used WinAnsi codes carry the letters WinAnsi lacks (glyph names of the standard Latin set).
const EXTRA = { "ğ": [0x81, "gbreve"], "İ": [0x8a, "Idotaccent"], "Ğ": [0x8d, "Gbreve"], "ş": [0x8f, "scedilla"], "Ş": [0x90, "Scedilla"],
  "−": [0x9a, "minus"], "ı": [0x9d, "dotlessi"] };
const CP1252 = { "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84, "…": 0x85, "†": 0x86, "‡": 0x87, "ˆ": 0x88, "‰": 0x89, "‹": 0x8b, "Œ": 0x8c,
  "Ž": 0x8e, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97, "˜": 0x98, "™": 0x99, "›": 0x9b, "œ": 0x9c, "ž": 0x9e, "Ÿ": 0x9f };
// characters the fonts do not have: a plain stand-in
const SWAP = { "″": "\"", "′": "'", "≈": "~", "→": "->", "←": "<-", "≤": "<=", "≥": ">=", " ": " ", " ": " ", " ": " ", "‑": "-",
  "✓": "", "↗": "", "↻": "", "▾": "", "⁻": "-", "¹": "1" };

/** One character -> one byte of the font's encoding (or a short stand-in string). */
function enc(ch) {
  if (EXTRA[ch]) return [EXTRA[ch][0]];
  const c = ch.codePointAt(0);
  if (c >= 32 && c <= 126) return [c];
  if (c >= 0xa1 && c <= 0xff) return [c];
  if (CP1252[ch]) return [CP1252[ch]];
  if (ch in SWAP) return [...SWAP[ch]].map((s) => s.charCodeAt(0));
  const base = ch.normalize("NFD")[0];                  // a letter with an accent the encoding lacks: the letter
  if (base && base !== ch && base.charCodeAt(0) < 127) return [base.charCodeAt(0)];
  return [63];                                          // "?"
}
const encode = (s) => { const out = []; for (const ch of String(s ?? "")) out.push(...enc(ch)); return out; };

// ---- widths of the standard fonts (1/1000 em), for line breaking ----------------------------------------------
const REG = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556,
  278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722,
  667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556,
  333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556,
  333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722,
  667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611,
  389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];
const SYM = { 0x81: [556, 611], 0x8a: [278, 278], 0x8d: [778, 778], 0x8f: [500, 556], 0x90: [667, 667], 0x9a: [584, 584], 0x9d: [278, 278],
  0x85: [1000, 1000], 0x96: [556, 556], 0x97: [1000, 1000], 0x91: [222, 278], 0x92: [222, 278], 0x93: [333, 500], 0x94: [333, 500], 0x95: [350, 350],
  0xb0: [400, 400], 0xb1: [584, 584], 0xb5: [556, 611], 0xb7: [278, 278], 0xd7: [584, 584], 0xf7: [584, 584], 0xa9: [737, 737], 0xae: [737, 737] };
const LATIN = "ÀÁÂÃÄÅAÇCÈÉÊËEÌÍÎÏIÑNÒÓÔÕÖOÙÚÛÜUÝYàáâãäåaçcèéêëeìíîïiñnòóôõöoùúûüuýyÿy";
function glyphW(code, bold) {
  if (code >= 32 && code <= 126) return (bold ? BOLD : REG)[code - 32];
  if (SYM[code]) return SYM[code][bold ? 1 : 0];
  const ch = String.fromCharCode(code), i = LATIN.indexOf(ch);
  if (i >= 0) { let j = i; while (j < LATIN.length && LATIN.charCodeAt(j) > 127) j++; return glyphW(LATIN.charCodeAt(j), bold); }
  return bold ? 611 : 556;
}
/** Width of a string in points. */
export function textWidth(s, size, bold = false) { return encode(s).reduce((a, c) => a + glyphW(c, bold), 0) * size / 1000; }
/** Lines of at most maxW points (breaks at spaces; a word longer than a line is cut). */
export function wrap(s, size, maxW, bold = false) {
  const out = [];
  for (const para of String(s ?? "").split("\n")) {
    let line = "";
    for (const w of para.split(/ +/)) {
      const t = line ? line + " " + w : w;
      if (textWidth(t, size, bold) <= maxW) { line = t; continue; }
      if (line) out.push(line);
      line = "";
      for (const ch of w) { if (line && textWidth(line + ch, size, bold) > maxW) { out.push(line); line = ""; } line += ch; }   // a word longer than a line (a link): cut
    }
    out.push(line);
  }
  return out;
}

// ---- the document -------------------------------------------------------------------------------------------
const num = (v) => (Math.round(v * 100) / 100).toString();
const hex = (bytes) => bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
const rgb = (c) => {                                     // "#rrggbb" -> "r g b" in 0..1
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c || "#000000") || [0, "00", "00", "00"];
  return [1, 2, 3].map((k) => num(parseInt(m[k], 16) / 255)).join(" ");
};
/** A text string for the document information: UTF-16BE with its byte-order mark. */
function infoString(s) {
  const b = [0xfe, 0xff];
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    if (c > 0xffff) { const v = c - 0x10000, hi = 0xd800 + (v >> 10), lo = 0xdc00 + (v & 1023); b.push(hi >> 8, hi & 255, lo >> 8, lo & 255); }
    else b.push(c >> 8, c & 255);
  }
  return "<" + hex(b) + ">";
}

export function pdfPage({ title = "", subject = "", lang = "en", w = A4.w, h = A4.h } = {}) {
  const ops = [], images = [], links = [];
  const Y = (y) => num(h - y);
  const api = {
    w, h,
    /** Text with its baseline at y. opts: size, bold, color, align ("left" | "right" | "center"). Returns its width. */
    text(x, y, s, { size = 10, bold = false, color = "#000000", align = "left" } = {}) {
      const b = encode(s);
      if (!b.length) return 0;
      const tw = textWidth(s, size, bold), x0 = align === "right" ? x - tw : align === "center" ? x - tw / 2 : x;
      ops.push(`BT /${bold ? "F2" : "F1"} ${num(size)} Tf ${rgb(color)} rg ${num(x0)} ${Y(y)} Td <${hex(b)}> Tj ET`);
      return tw;
    },
    /** Wrapped text from the top line's baseline y; returns the y under the last line. */
    para(x, y, s, maxW, { size = 10, bold = false, color = "#000000", lead = 1.32 } = {}) {
      const lines = wrap(s, size, maxW, bold);
      lines.forEach((l, i) => api.text(x, y + i * size * lead, l, { size, bold, color }));
      return y + lines.length * size * lead;
    },
    rect(x, y, rw, rh, color = "#000000") { ops.push(`${rgb(color)} rg ${num(x)} ${num(h - y - rh)} ${num(rw)} ${num(rh)} re f`); },
    line(x1, y1, x2, y2, color = "#000000", lw = 0.5) { ops.push(`${rgb(color)} RG ${num(lw)} w ${num(x1)} ${Y(y1)} m ${num(x2)} ${Y(y2)} l S`); },
    /** A JPEG (bytes, its size in pixels) drawn into the box x, y, w, h. */
    image(jpeg, pw, ph, x, y, iw, ih) {
      const name = "Im" + (images.length + 1);
      images.push({ name, jpeg, pw, ph });
      ops.push(`q ${num(iw)} 0 0 ${num(ih)} ${num(x)} ${num(h - y - ih)} cm /${name} Do Q`);
    },
    link(x, y, lw, lh, url) { links.push({ rect: [x, h - y - lh, x + lw, h - y], url: String(url) }); },
    /** The finished file. */
    bytes() {
      const parts = [], offs = [];
      let len = 0;
      const te = new TextEncoder();
      const put = (x) => { const b = typeof x === "string" ? te.encode(x) : x; parts.push(b); len += b.length; };
      const obj = (n, body, stream) => {
        offs[n] = len;
        put(`${n} 0 obj\n${body}\n`);
        if (stream) { put("stream\n"); put(stream); put("\nendstream\n"); }
        put("endobj\n");
      };
      // object numbers: 1 catalog, 2 pages, 3 page, 4 F1, 5 F2, 6 encoding, 7 contents, 8 info, 9.. images, then links
      const nImg = images.length, firstLink = 9 + nImg;
      put(new Uint8Array([...te.encode("%PDF-1.4\n%"), 0xe2, 0xe3, 0xcf, 0xd3, 10]));     // header and the binary marker line
      const L = String(lang || "en").replace(/[^A-Za-z-]/g, "") || "en";
      obj(1, `<< /Type /Catalog /Pages 2 0 R /Lang (${L}) /ViewerPreferences << /DisplayDocTitle true >> >>`);
      obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
      const xo = images.map((im, i) => `/${im.name} ${9 + i} 0 R`).join(" ");
      const an = links.length ? ` /Annots [${links.map((_, i) => `${firstLink + i} 0 R`).join(" ")}]` : "";
      obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(w)} ${num(h)}] /Resources << /Font << /F1 4 0 R /F2 5 0 R >>` +
        (xo ? ` /XObject << ${xo} >>` : "") + ` /ProcSet [/PDF /Text /ImageC] >> /Contents 7 0 R${an} >>`);
      obj(4, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding 6 0 R >>");
      obj(5, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding 6 0 R >>");
      const diff = Object.values(EXTRA).sort((a, b) => a[0] - b[0]).map(([c, g]) => `${c} /${g}`).join(" ");
      obj(6, `<< /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences [${diff}] >>`);
      const content = te.encode(ops.join("\n"));
      obj(7, `<< /Length ${content.length} >>`, content);
      const d = new Date(), p2 = (v) => String(v).padStart(2, "0");
      const stamp = `D:${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}Z`;
      obj(8, `<< /Title ${infoString(title)} /Subject ${infoString(subject)} /Creator (Fazari) /Producer (Fazari pdf_min.js) /CreationDate (${stamp}) >>`);
      images.forEach((im, i) => obj(9 + i, `<< /Type /XObject /Subtype /Image /Width ${im.pw} /Height ${im.ph} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${im.jpeg.length} >>`, im.jpeg));
      links.forEach((l, i) => {
        const uri = encode(l.url).map((c) => (c === 40 || c === 41 || c === 92 ? "\\" : "") + String.fromCharCode(c)).join("");
        obj(firstLink + i, `<< /Type /Annot /Subtype /Link /Rect [${l.rect.map(num).join(" ")}] /Border [0 0 0] /A << /S /URI /URI (${uri}) >> >>`);
      });
      const n = firstLink + links.length, xref = len;
      let x = `xref\n0 ${n}\n0000000000 65535 f \n`;
      for (let i = 1; i < n; i++) x += String(offs[i]).padStart(10, "0") + " 00000 n \n";
      put(x + `trailer\n<< /Size ${n} /Root 1 0 R /Info 8 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
      const out = new Uint8Array(len);
      let o = 0;
      for (const b of parts) { out.set(b, o); o += b.length; }
      return out;
    },
  };
  return api;
}
