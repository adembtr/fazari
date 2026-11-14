// "Is there new data?" (challenge item: a design that is easy to update as new SPHEREx data arrive).
// Two checks, both from the static site (no server):
//  1. our static sky index (site/index/, pipeline/sky_index.py): SPHEREx images of this point newer than
//     the newest image in the result on screen;
//  2. the archive itself: the public S3 bucket listing (CORS allowed; IRSA SIA/TAP send no CORS headers)
//     for weekly folders that the index does not have yet. A new folder may or may not cover this point:
//     that needs the index refresh (one command), so the text says exactly that.
import { T, esc, dayText, L } from "./ch_common.js";

const S3 = "https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/";
const INDEX_MODULES = ["./skyindex.js", "./skyindex_dev.js"];

async function fetchText(url, ms = 15000) {
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {      // the network drops for minutes: retry, then give up gently
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    try {
      const r = await fetch(url, { signal: ctl.signal, cache: "no-store", mode: "cors" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.text();
    } catch (e) { last = e; } finally { clearTimeout(timer); }
    await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
  }
  throw last || new Error("no answer");
}

async function listPrefixes(prefix) {
  const out = [];
  let token = null;
  for (let page = 0; page < 6; page++) {
    const q = `?list-type=2&delimiter=/&prefix=${encodeURIComponent(prefix)}` + (token ? `&continuation-token=${encodeURIComponent(token)}` : "");
    const xml = await fetchText(S3 + q);
    for (const m of xml.matchAll(/<CommonPrefixes><Prefix>([^<]*)<\/Prefix><\/CommonPrefixes>/g)) out.push(m[1]);
    const tr = /<IsTruncated>true<\/IsTruncated>/.test(xml), nt = /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml);
    if (!tr || !nt) break;
    token = nt[1].replace(/&amp;/g, "&");
  }
  return out;
}

/** "2026W40_2A" -> Monday of ISO week 40 of 2026 (Date) or null. */
export function planDate(plan) {
  const m = /^(\d{4})W(\d{2})/.exec(plan || "");
  if (!m) return null;
  const y = +m[1], w = +m[2];
  const jan4 = new Date(Date.UTC(y, 0, 4));
  const mon1 = new Date(jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * 864e5);
  return new Date(mon1.getTime() + (w - 1) * 7 * 864e5);
}
const isoMjd = (iso) => Date.parse(String(iso).slice(0, 10) + "T00:00:00Z") / 864e5 + 40587;
const mjdIso = (mjd) => new Date((mjd - 40587) * 864e5).toISOString().slice(0, 10);

/** Archive check: weekly folders in S3 that are not in the index manifest. */
export async function archiveCheck(manifest) {
  const known = new Set(manifest.plans.map((p) => `${p.rel}/${p.plan}`));
  const rels = Object.keys(manifest.collections || {});
  const maxOf = (kind) => Math.max(0, ...rels.filter((r) => r.startsWith(kind)).map((r) => +r.slice(2) || 0));
  const top = (await listPrefixes("")).map((p) => p.replace(/\/$/, ""));
  // releases to look in: the index's own, plus newer ones (dr2, qr4, ...); older quick releases (qr2) are superseded
  const look = top.filter((r) => rels.includes(r) || (/^(dr|qr)\d+$/.test(r) && +r.slice(2) > maxOf(r.slice(0, 2))));
  const newPlans = [];
  for (const rel of look) {
    const plans = (await listPrefixes(`${rel}/level2/`)).map((p) => p.split("/")[2]).filter(Boolean);
    for (const p of plans) if (!known.has(`${rel}/${p}`)) newPlans.push({ rel, plan: p, date: planDate(p) });
  }
  newPlans.sort((a, b) => (a.date || 0) - (b.date || 0));
  const lastKnown = manifest.plans.map((p) => p.plan).sort().pop();
  return { ok: true, newPlans, newReleases: look.filter((r) => !rels.includes(r)), lastPlan: lastKnown, lastPlanDate: planDate(lastKnown) };
}

/**
 * @param o.ra, o.dec   the point (deg)
 * @param o.lastDate    newest image date in the result on screen ("YYYY-MM-DD")
 * Returns {built, lastDate, newer: [images], newestIndex, archive: {...} | {ok: false, error}}.
 */
export async function checkNewData({ ra, dec, lastDate }) {
  let mod = null;
  for (const m of INDEX_MODULES) { try { mod = await import(m); if (mod.findImages) break; } catch (_) { mod = null; } }
  if (!mod) throw new Error("sky index not available");
  const manifest = mod.skyIndexManifest ? await mod.skyIndexManifest() : null;
  const images = await mod.findImages(ra, dec);
  // "new" = images of an observing season that starts after the result's last season (seasons are split at
  // gaps > 30 days, as the blink does); other images of a season already in the result are not new data
  const lastMjd = isoMjd(lastDate) + 1;                 // the whole last day of the result
  const times = images.map((i) => i.mjd).sort((a, b) => a - b);
  let seasonEnd = lastMjd;
  for (const m of times) { if (m <= seasonEnd) continue; if (m - seasonEnd <= 30) seasonEnd = m; else break; }
  const sameSeason = images.filter((i) => i.mjd > lastMjd && i.mjd <= seasonEnd).length;
  const newer = images.filter((i) => i.mjd > seasonEnd);
  const out = { built: manifest ? manifest.built : null, lastDate, newer, sameSeason, nIndex: images.length,
                newestIndex: images.length ? mjdIso(Math.max(...images.map((i) => i.mjd))) : null, archive: null };
  try { out.archive = manifest ? await archiveCheck(manifest) : { ok: false, error: "no manifest" }; }
  catch (e) { out.archive = { ok: false, error: e.message || String(e) }; }
  return out;
}

/** The answer as HTML (one or two short sentences; the image list only in Detailed mode). */
export function newDataHtml(res, { addHref = null } = {}) {
  const built = res.built ? dayText(res.built) : "?";
  let h = "";
  if (res.newer.length) {
    const d0 = mjdIso(res.newer[0].mjd), d1 = mjdIso(res.newer[res.newer.length - 1].mjd);
    h += `<b>${esc(res.newer.length === 1 ? T("ch.nd.new1", "1 new SPHEREx image of this point since {date} ({a}).", { date: dayText(res.lastDate), a: dayText(d0) })
      : T("ch.nd.newN", "{n} new SPHEREx images of this point since {date} ({a} – {b}).", { n: res.newer.length, date: dayText(res.lastDate), a: dayText(d0), b: dayText(d1) }))}</b>`;
    if (addHref) h += ` <a class="ch-btn" href="${esc(addHref)}">${esc(T("ch.nd.add", "Add them to the blink"))}</a>`;
    h += `<span class="ch-only-d"><span class="ch-tw"><table><tr><th>obs_id</th><th>${esc(T("ch.nd.th.date", "Date"))}</th><th>${esc(T("ch.nd.th.det", "Detector"))}</th></tr>`
      + res.newer.slice(0, 200).map((i) => `<tr><td>${esc(i.obs_id)}</td><td>${esc(mjdIso(i.mjd))}</td><td>D${i.detector}</td></tr>`).join("") + "</table></span></span>";
  } else {
    h += `<b>${esc(T("ch.nd.none", "Nothing new since {date}.", { date: dayText(res.lastDate) }))}</b> `
      + esc(!res.newestIndex ? "" : res.newestIndex > res.lastDate
        ? T("ch.nd.newestSame", "The sky index has images of this point up to {d}, all from the same season (other wavelengths, or more than the blink uses per season), but no newer season.", { d: dayText(res.newestIndex) })
        : T("ch.nd.newest", "The newest SPHEREx image of this point in our sky index is from {d}.", { d: dayText(res.newestIndex) }));
  }
  const a = res.archive;
  let tail;
  if (a && a.ok && !a.newPlans.length) {
    tail = T("ch.nd.arcSame", "Archive checked just now: no SPHEREx week newer than our sky index (built {built}; last week {plan}, from {d}).",
      { built, plan: a.lastPlan, d: a.lastPlanDate ? dayText(a.lastPlanDate.toISOString()) : "?" });
  } else if (a && a.ok) {
    const p0 = a.newPlans[0], p1 = a.newPlans[a.newPlans.length - 1];
    tail = T("ch.nd.arcNew", "The archive has {k} newer weekly folders ({a} – {b}) that our sky index (built {built}) does not have yet; they may hold new images of this point. The index is refreshed with one command (pipeline/sky_index.py build) and the site republished.",
      { k: a.newPlans.length, a: p0.plan, b: p1.plan, built });
  } else {
    tail = T("ch.nd.arcFail", "Could not reach the archive listing just now. Our sky index was built on {built}; it is refreshed with one command (pipeline/sky_index.py build).", { built });
  }
  h += `<span class="ch-msg">${esc(tail)}</span>`;
  return h;
}

/** Mount the button + answer line into `host`. getArgs() -> {ra, dec, lastDate, addHref} or null (not ready). */
export function mountNewData(host, getArgs) {
  const wrap = document.createElement("div");
  wrap.className = "ch-new";
  wrap.id = "chNew";
  wrap.innerHTML = `<span class="ch-idx" id="chIdx"></span><button type="button" class="ch-btn" id="chNewBtn"></button><span class="ch-msg" id="chNewMsg" aria-live="polite"></span>`;
  host.appendChild(wrap);
  const btn = wrap.querySelector("#chNewBtn"), msg = wrap.querySelector("#chNewMsg"), idx = wrap.querySelector("#chIdx");
  let last = null, busy = false, man = null;
  // one line: when the static sky index was built and what it holds (read from index/manifest.json)
  (async () => {
    for (const m of INDEX_MODULES) {
      try { const mod = await import(m); if (mod.skyIndexManifest) { man = await mod.skyIndexManifest(); break; } } catch (_) { /* next */ }
    }
    paint();
  })();
  const paint = () => {
    if (man && man.built) {
      const cols = Object.entries(man.collections || {});
      const lastMjd = Math.max(...cols.map(([, c]) => +c.mjd_max || 0));
      idx.textContent = T("ch.nd.index", "Sky index: {date}, {rel} (images up to {last}).", { date: dayText(man.built), rel: cols.map(([k]) => k.toUpperCase()).join(" + "),
        last: lastMjd > 0 ? dayText(mjdIso(lastMjd)) : "?" }) + " ";
      window.__chIndexLine = idx.textContent;
    }
    btn.textContent = T("ch.nd.btn", "Is there new data?");
    btn.title = T("ch.nd.tip", "Look for SPHEREx images of this point newer than the ones in this result (our sky index and the archive listing).");
    if (busy) msg.textContent = T("ch.nd.busy", "Checking the sky index and the archive…");
    else if (last && last.error) msg.textContent = last.error;
    else if (last) msg.innerHTML = newDataHtml(last.res, { addHref: last.addHref });
  };
  btn.onclick = async () => {
    const a = getArgs();
    if (!a) { last = { error: T("ch.nd.notReady", "Wait until the result is on screen, then ask again.") }; paint(); return; }
    busy = true; btn.disabled = true; paint();
    try {
      last = { res: await checkNewData(a), addHref: a.addHref };
      window.__chNewData = { ...last.res, newer: last.res.newer.length };     // headless checks
    } catch (e) {
      last = { error: T("ch.nd.fail", "The check did not work just now ({msg}). Try again in a minute.", { msg: e.message || String(e) }) };
    } finally { busy = false; btn.disabled = false; paint(); }
  };
  paint();
  return { paint, el: wrap };
}
export { L };
