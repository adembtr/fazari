// Post-step outputs that arrive after the result is on screen (ornek.html, local Python engine).
//
// A local job (ornek.html?data=/jobs/<id>/) is shown as soon as blink.py wrote meta.json and the
// frames. Its post-steps (spectrum, candidates, faint: POST_STEPS in local/job_worker.py) run
// afterwards in the server's post lane; until they are all done the job status (GET /api/jobs/<id>)
// has post_pending {steps, state}, and post.<step> appears as each one finishes.
//
// watchPostSteps(base, onStep) polls that status while post_pending is there. For every step that
// finished it calls onStep(step, result), fires the document event "fazari:post"
// {detail: {step, result, pending}} (modules that read their file once, e.g. js/faint_view.js,
// look again on it) and tells the parent page (the explorer) with
// postMessage({type: "fazari-post", job, step, pending}). Static site / no local engine / nothing
// pending: it stops after one request.

export function watchPostSteps(base, onStep, { interval = 4000, maxMinutes = 90 } = {}) {
  const m = /(?:^|\/)jobs\/([a-z0-9][a-z0-9_.-]{0,95})\/?$/.exec(String(base || ""));
  if (!m || !/^https?:$/.test(location.protocol)) return null;
  const id = m[1];
  const url = `/api/jobs/${encodeURIComponent(id)}`;
  const t0 = Date.now();
  const announced = new Set();
  let first = null, timer = 0, stopped = false, misses = 0;

  const tell = (step, result) => {
    announced.add(step);
    const pending = first.steps.filter((x) => !announced.has(x));
    try { if (onStep) onStep(step, result); } catch (e) { console.warn("post_watch.js", e); }
    document.dispatchEvent(new CustomEvent("fazari:post", { detail: { step, result, pending } }));
    try { if (parent !== window) parent.postMessage({ type: "fazari-post", job: id, step, pending }, location.origin); } catch (_) { /* other origin */ }
  };

  const tick = async () => {
    if (stopped) return;
    let j = null;
    try {
      const r = await fetch(url, { cache: "no-store" });
      j = r.ok ? await r.json() : null;
    } catch (_) { /* engine stopped or restarting */ }
    if (stopped) return;
    if (!j) {
      if (!first || ++misses > 30) return;               // no local engine here, or gone for good
      timer = setTimeout(tick, interval * 2);
      return;
    }
    misses = 0;
    const post = j.post || {};
    const pend = (j.post_pending && j.post_pending.steps) || [];
    if (!first) {
      if (!pend.length) return;                          // nothing pending: every output was there at load
      first = { steps: pend.slice(), before: Object.fromEntries(pend.map((n) => [n, JSON.stringify(post[n] || null)])) };
    }
    for (const n of first.steps) {
      if (announced.has(n)) continue;
      const finished = post[n] && JSON.stringify(post[n]) !== first.before[n];   // a rerun replaces an older entry
      if (finished || !pend.includes(n)) tell(n, post[n] || null);
    }
    if (!pend.length || Date.now() - t0 > maxMinutes * 60e3) return;
    timer = setTimeout(tick, interval);
  };
  tick();
  return { stop() { stopped = true; clearTimeout(timer); } };
}

// The explorer sends the quick decision (local/quick.py, "does the clicked object move?") while a
// preview is on screen: {type: "fazari-quick", text, line2, sure}. It is shown under the stage line
// (#stagebar), labelled preliminary by the explorer's own wording; the full result replaces the page.
if (typeof window !== "undefined") {
  window.addEventListener("message", (ev) => {
    const d = ev.data;
    if (ev.origin !== location.origin || !d || d.type !== "fazari-quick" || ev.source !== window.parent) return;
    const bar = document.getElementById("stagebar");
    if (!bar) return;
    let el = bar.querySelector(".fz-quick");
    if (!el) {
      el = document.createElement("span");
      el.className = "fz-quick";
      el.style.cssText = "display:block;margin-top:4px";
      el.innerHTML = "<b></b><br><small></small>";
      bar.appendChild(el);
    }
    el.querySelector("b").textContent = String(d.text || "");
    el.querySelector("small").textContent = [d.line2, d.sure].filter(Boolean).join(" ");
    bar.hidden = false;
  });
}
