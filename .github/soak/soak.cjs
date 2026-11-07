// Phone soak: an emulated iPhone opens the live site, goes to EARTH > Hazards & Weather with the list full screen,
// scrolls to the bottom and stays there for 5 minutes while live updates arrive. Records every stall of the page
// (frames and timers that came back late, checks the page didn't answer), memory of the browser processes, errors,
// and a screenshot each minute. Then reopens the site in the same profile. Fails on a stall over 2 s or a page that
// stops answering. Usage: node soak.cjs <webkit|chromium> <url> [minutes]
const { execSync } = require("child_process"), fs = require("fs");
const pw = require("playwright");
const MODE = process.argv[2] || "webkit", DESK = MODE === "desktop", ENGINE = DESK ? "chromium" : MODE, URL0 = process.argv[3], MIN = Number(process.argv[4] || 5);
fs.mkdirSync("out", { recursive: true });
const t0 = Date.now(), log = (...a) => { const l = `${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s ${a.join(" ")}`; console.log(l); fs.appendFileSync("out/log.txt", l + "\n"); };
const fails = []; const fail = (m) => { fails.push(m); log("FAIL", m); };
const rss = () => { try { const pat = ENGINE === "webkit" ? /WebKit|MiniBrowser|pw_run/ : /chrom/i; return execSync("ps -eo rss=,args=", { encoding: "utf8" }).split("\n").filter((l) => pat.test(l)).reduce((s, l) => s + (parseInt(l, 10) || 0), 0) / 1024; } catch { return -1; } };
const procs = () => { try { return execSync("ps -eo rss=,comm=", { encoding: "utf8" }).split("\n").filter((l) => /WebKit|chrom/i.test(l)).map((l) => l.trim()).sort((a, b) => parseInt(b, 10) - parseInt(a, 10)).slice(0, 4).join(" | "); } catch { return ""; } };
const finish = () => { log(fails.length ? `SOAK FAILED (${fails.length})` : "SOAK PASSED"); process.exit(fails.length ? 1 : 0); };
setTimeout(() => { fail("soak ran out of time"); finish(); }, (MIN + 12) * 60e3);
(async () => {
  const dev = DESK ? { viewport: { width: 1466, height: 800 } } : pw.devices["iPhone 14 Pro"];
  const ctx = await pw[ENGINE].launchPersistentContext("prof", { ...dev, ...(ENGINE === "chromium" ? { args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] } : {}) });
  let p = ctx.pages()[0] || (await ctx.newPage());
  const errs = []; const watchPage = (pg) => { pg.on("pageerror", (e) => errs.push(e.message)); pg.on("crash", () => fail("page crashed")); pg.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|net::/.test(m.text())) errs.push(m.text().slice(0, 200)); }); };
  watchPage(p);
  let cdp = null;
  if (ENGINE === "chromium") { cdp = await ctx.newCDPSession(p); await cdp.send("Debugger.enable"); if (!DESK) { await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 }); log("chromium: CPU slowed 4x"); } else log("desktop chromium, full speed"); }
  else log("webkit: real Safari engine, CPU not slowed (WebKit has no throttle)");
  // every call into the page has a time limit, so a stuck page is reported instead of stalling the test
  const ev = (fn, arg, ms = 8000) => Promise.race([p.evaluate(fn, arg), new Promise((_, j) => setTimeout(() => j(new Error("page did not answer")), ms))]);
  let stacks = 0;
  const stuckStack = async (label) => { // Chrome only: pause the stuck page and record what is running
    if (!cdp || stacks >= 3) return; stacks++;
    try { const got = new Promise((r) => cdp.once("Debugger.paused", r)); cdp.send("Debugger.pause").catch(() => {}); const ev2 = await Promise.race([got, new Promise((r) => setTimeout(() => r(null), 10000))]);
      if (!ev2) { log("STACK (" + label + "): could not pause"); return; }
      log("STACK (" + label + "):"); for (const f of ev2.callFrames.slice(0, 25)) log("    at", f.functionName || "(anon)", `${(f.url || "").split("/").pop()}:${f.location.lineNumber + 1}:${f.location.columnNumber + 1}`);
      cdp.send("Debugger.resume").catch(() => {}); } catch (e) { log("stack failed", e.message); }
  };
  let hung = 0;
  const answers = async (label, ms = 5000) => { const s = Date.now(); try { await Promise.race([p.evaluate(() => 1), new Promise((_, j) => setTimeout(() => j(new Error("x")), ms))]); return Date.now() - s; } catch { hung++; fail(`page did not answer for ${ms / 1000} s (${label})`); if (hung > 3) { log("stuck for good: stopping"); finish(); } await stuckStack(label); await new Promise((r) => setTimeout(r, 2000)); await stuckStack(label + " +2 s"); return -1; } };
  const instrument = () => ev(() => { if (window.__m) return; const m = (window.__m = { frames: [], timers: [], worstFrame: 0, worstTimer: 0 });
    let l = performance.now(); const f = (t) => { const g = t - l; l = t; if (g > m.worstFrame) m.worstFrame = g; if (g > 250) m.frames.push([Math.round(t / 1000), Math.round(g)]); requestAnimationFrame(f); }; requestAnimationFrame(f);
    try { m.long = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.duration > 200) m.long.push([Math.round(e.startTime / 1000), Math.round(e.duration)]); }).observe({ type: "longtask", buffered: true }); } catch {}
    m.inp = []; const raw = "onpointerrawupdate" in window; m.inpKind = raw ? "pointerrawupdate" : "pointermove"; addEventListener(m.inpKind, (ev) => { if (ev.buttons) m.inp.push(Math.round(performance.now() - ev.timeStamp)); }, { capture: true, passive: true });
    let e = performance.now() + 100; setInterval(() => { const n = performance.now(), late = n - e; e = n + 100; if (late > m.worstTimer) m.worstTimer = late; if (late > 250) m.timers.push([Math.round(n / 1000), Math.round(late)]); }, 100); });
  const profTop = async (label) => { if (!cdp) return; const { profile } = await Promise.race([cdp.send("Profiler.stop"), new Promise((r) => setTimeout(() => r({ profile: null }), 15000))]); if (!profile) return;
    const self = new Map(), byId = new Map(profile.nodes.map((n) => [n.id, n])), dt = profile.timeDeltas, cnt = new Map(); profile.samples.forEach((id, i) => cnt.set(id, (cnt.get(id) || 0) + (dt[i] || 0)));
    for (const [id, us] of cnt) { const cf = byId.get(id).callFrame; const k = `${cf.functionName || "(anon)"} ${cf.url.split("/").pop()}:${cf.lineNumber + 1}:${cf.columnNumber + 1}`; self.set(k, (self.get(k) || 0) + us); }
    log(`profile ${label}`, Math.round((profile.endTime - profile.startTime) / 1000), "ms; top self time:"); [...self].sort((a, b) => b[1] - a[1]).slice(0, 30).forEach(([k, us]) => log("   ", Math.round(us / 1000), "ms", k)); };
  if (cdp) { await cdp.send("Profiler.enable"); await cdp.send("Profiler.setSamplingInterval", { interval: 1000 }); await cdp.send("Profiler.start"); }
  log("open", URL0);
  await p.goto(URL0, { waitUntil: "commit", timeout: 60000 });
  const up = await p.waitForFunction(() => !document.getElementById("boot") && document.querySelector(".cesium-widget canvas"), null, { timeout: 120000 }).then(() => true).catch(() => false);
  log(up ? "globe up" : "FAIL globe not up in 120 s"); if (!up) fail("globe not up");
  log("build", await ev(() => window.TERMINAL_CONFIG?.build).catch(() => "?"), "rss MB", rss().toFixed(0));
  await instrument().catch(() => {});
  for (let i = 0; i < 10; i++) { await p.waitForTimeout(2000); const a = await answers("first 20 s"); log(`first 20 s: answer ${a} ms, rss MB`, rss().toFixed(0)); if (a < 0) break; }
  await profTop("startup (first 20 s)");
  // spin the globe to the far side and back with drags, while it is still loading: every drag must be answered quickly
  const spinAt = await ev(() => performance.now()).catch(() => 0);
  { const vp = p.viewportSize() || { width: 390, height: 844 }, cx = Math.round(vp.width / 2), cy = Math.round(vp.height * 0.4); let worst = 0;
    for (let i = 0; i < 8; i++) { const dir = i < 4 ? 1 : -1, t = Date.now();
      try { await Promise.race([(async () => { await p.mouse.move(cx - 120 * dir, cy); await p.mouse.down(); for (let k = 1; k <= 8; k++) await p.mouse.move(cx - 120 * dir + 30 * k * dir, cy); await p.mouse.up(); })(), new Promise((_, j) => setTimeout(() => j(new Error("x")), 8000))]); }
      catch { fail(`drag ${i + 1} was not taken in 8 s`); await stuckStack("drag"); break; }
      const a = await answers(`after drag ${i + 1}`, 5000); worst = Math.max(worst, Date.now() - t); if (a < 0) break; }
    log("spun the globe 8 drags, slowest drag + answer", worst, "ms");
    const sp = await ev((t) => { const i = (__m.inp || []).slice().sort((a, b) => a - b); return { kind: __m.inpKind, n: i.length, p50: i[i.length >> 1], p90: i[Math.floor(i.length * 0.9)], max: i[i.length - 1], long: (__m.long || []).filter((x) => x[0] >= t) }; }, Math.floor(spinAt / 1000)).catch(() => null);
    log("spin: drag input delay ms", JSON.stringify(sp));
    if (sp) { if (!(sp.p90 <= 100)) fail(`drag input answered in ${sp.p90} ms (90th percentile), budget 100 ms`);
      const big = sp.long.filter((x) => x[1] > 200); if (big.length) fail(`${big.length} long tasks over 200 ms while spinning: ${JSON.stringify(big.slice(0, 8))}`); } }
  if (cdp) { await cdp.send("Profiler.enable"); await cdp.send("Profiler.setSamplingInterval", { interval: 1000 }); await cdp.send("Profiler.start"); }
  const shot = async (f) => { try { await p.screenshot({ path: f, timeout: 8000 }); return true; } catch { log("no frame for a screenshot in 8 s:", f); return false; } };
  await ev(() => { document.querySelector('.hud-ops [data-act="data"]')?.click(); }).catch((e) => log(e.message)); await p.waitForTimeout(1500);
  await ev(() => { document.querySelector('[data-group="earth"]')?.click(); }).catch((e) => log(e.message)); await p.waitForTimeout(2500);
  await ev(() => { document.querySelector('[data-sub="hazards"]')?.click(); }).catch((e) => log(e.message)); await p.waitForTimeout(2500);
  await ev(() => { if (!document.body.classList.contains("sheet-full")) document.querySelector(".sheet-grab")?.click(); }).catch((e) => log(e.message)); await p.waitForTimeout(2000);
  log("on EARTH > hazards:", await ev(() => [document.body.classList.contains("sheet-full"), document.querySelectorAll("#hazards li, #hazards .item, #hazards > *").length].join(" items ")).catch((e) => e.message));
  for (let i = 0; i < 10; i++) { await p.waitForTimeout(2000); const a = await answers("just opened"); const r = await ev(() => new Promise((res) => { const s = performance.now(); requestAnimationFrame(() => res(Math.round(performance.now() - s))); setTimeout(() => res(-1), 3000); })).catch(() => -2);
    const m = await ev(() => ({ wf: Math.round(__m.worstFrame), wt: Math.round(__m.worstTimer), f: __m.frames.slice(-3), t: __m.timers.slice(-3) })).catch(() => null); log(`answer ${a} ms, next frame ${r} ms`, JSON.stringify(m), "rss MB", rss().toFixed(0)); }
  if (cdp) { const { profile } = await Promise.race([cdp.send("Profiler.stop"), new Promise((r) => setTimeout(() => r({ profile: null }), 15000))]); if (profile) { const self = new Map(), total = profile.endTime - profile.startTime, byId = new Map(profile.nodes.map((n) => [n.id, n]));
    const dt = profile.timeDeltas, cnt = new Map(); profile.samples.forEach((id, i) => cnt.set(id, (cnt.get(id) || 0) + (dt[i] || 0)));
    for (const [id, us] of cnt) { const n = byId.get(id), cf = n.callFrame; const k = `${cf.functionName || "(anon)"} ${cf.url.split("/").pop()}:${cf.lineNumber + 1}:${cf.columnNumber + 1}`; self.set(k, (self.get(k) || 0) + us); }
    log("profile", Math.round(total / 1000), "ms; top self time:"); [...self].sort((a, b) => b[1] - a[1]).slice(0, 25).forEach(([k, us]) => log("   ", Math.round(us / 1000), "ms", k));
    fs.writeFileSync("out/profile.cpuprofile", JSON.stringify(profile)); } }
  await shot("out/0-hazards.png");
  // scroll to the bottom like a thumb: steps of a screen, then hold there
  const scrollDown = () => ev(async () => { const h = document.getElementById("hazards"); let s = h; while (s && s !== document.body && !(s.scrollHeight > s.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(s).overflowY))) s = s.parentElement;
    if (!s || s === document.body) return { err: "no scroller" }; for (let i = 0; i < 60 && s.scrollTop + s.clientHeight < s.scrollHeight - 2; i++) { s.scrollBy(0, s.clientHeight * 0.8); await new Promise((r) => setTimeout(r, 250)); }
    return { top: Math.round(s.scrollTop), height: s.scrollHeight, items: h.querySelectorAll("*").length }; }, undefined, 30000);
  log("scrolled", JSON.stringify(await scrollDown().catch((e) => ({ err: e.message })))); await answers("after scroll");
  const end = Date.now() + MIN * 60e3; let minute = 0;
  while (Date.now() < end) {
    await p.waitForTimeout(10000);
    const a = await answers("holding at the bottom");
    const m = await ev(() => ({ wf: Math.round(__m.worstFrame), wt: Math.round(__m.worstTimer), nf: __m.frames.length, nt: __m.timers.length, heap: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null, live: window.TERMINAL_CONFIG && document.querySelector("#liveStatus, .live-status")?.textContent?.slice(0, 60) })).catch(() => null);
    log(`answer ${a} ms`, "worst frame", m?.wf, "worst timer", m?.wt, "stalls", m?.nf, m?.nt, "heap MB", m?.heap, "rss MB", rss().toFixed(0), "|", procs());
    if (Date.now() > t0 + (minute + 1) * 60e3) { minute++; await shot(`out/${minute}-min.png`); log("scrolled", JSON.stringify(await scrollDown().catch((e) => ({ err: e.message })))); }
  }
  const m = await ev(() => __m).catch(() => null);
  if (m) { fs.writeFileSync("out/stalls.json", JSON.stringify(m)); log("stalls over 250 ms: frames", JSON.stringify(m.frames.slice(-30)), "timers", JSON.stringify(m.timers.slice(-30)), "long tasks over 200 ms", JSON.stringify((m.long || []).slice(-30)));
    if (m.worstTimer > 2000) fail(`a ${Math.round(m.worstTimer)} ms stall on EARTH > Hazards`); }
  // Gulf view (ships and air check): the Persian Gulf & Strait of Hormuz watch card, then military aircraft on AIR
  try {
    const before = errs.length;
    await ev(() => { document.querySelector('[data-group="intel"]')?.click(); }); await p.waitForTimeout(1500);
    await ev(() => { document.querySelector('[data-sub="ships"]')?.click(); }); await p.waitForTimeout(8000);
    const how = await ev(() => { const w = document.querySelector('li[data-navy-watch="0"]'); if (w) { w.click(); return "watch row"; } const tag = [...document.querySelectorAll(".gx-tag, .gx-name, [class*=tag]")].find((e) => /PERSIAN GULF/i.test(e.textContent || "") && e.offsetParent);
      if (tag) { tag.click(); return "globe tag"; }
      const row = [...document.querySelectorAll("li[data-navy]")].find((e) => /Arabian Sea|Persian Gulf|Hormuz/i.test(e.textContent)); if (row) { row.click(); return "row: " + row.querySelector(".title")?.textContent; }
      return "no tag or row (" + document.querySelectorAll("li[data-navy]").length + " rows)"; });
    log("gulf: opened via", how); await p.waitForTimeout(4000);
    if (!(await ev(() => !!document.querySelector('[data-nv-watch="0"]')))) log("gulf: watch card", await ev(() => { const l = [...document.querySelectorAll("button, a, [data-nv-watch], [data-navy], li")].find((e) => /Hormuz|Persian Gulf/i.test(e.textContent || "") && e.offsetParent && !e.closest("#subtabs")); if (l) { l.click(); return "clicked " + l.tagName + " " + (l.textContent || "").slice(0, 60); } return "nothing to click"; }));
    await p.waitForTimeout(20000);
    const g = await ev(() => { const c = document.querySelector('[data-nv-watch="0"]'); if (!c) return { card: false };
      const secs = [...c.querySelectorAll("*")].filter((e) => /WARNINGS TO SHIPS/i.test(e.textContent || "") && e.children.length < 3).pop();
      let warn = ""; if (secs) { let n = secs; for (let k = 0; k < 6 && n; k++) { warn += " | " + (n.textContent || "").trim().slice(0, 200); n = n.nextElementSibling; } }
      const sec = (re) => { const h = [...c.querySelectorAll("*")].filter((e) => re.test(e.textContent || "") && e.children.length < 3).pop(); let out = ""; let n = h; for (let k = 0; k < 6 && n; k++) { out += " | " + (n.innerText || "").replace(/\s+/g, " ").slice(0, 200); n = n.nextElementSibling; } return out.slice(0, 900); };
      return { card: true, grid: c.querySelector(".nv-tw")?.innerText.replace(/\s+/g, " "), shipping: sec(/SHIPPING THROUGH/i), heading: /SHIPPING THROUGH STRAIT OF HORMUZ/i.test(c.innerText), noAnswer: /did not answer just now/i.test(c.innerText), warnings: warn.slice(0, 900) }; }, undefined, 15000);
    log("gulf card:", JSON.stringify(g));
    await shot("out/gulf.png");
    await ev(() => { document.querySelector('[data-group="air"]')?.click(); }); await p.waitForTimeout(15000);
    const a = await ev(() => { const h = document.querySelector('[data-sec="milnow"]'); if (!h) return { milnow: false }; const li = []; let n = h.nextElementSibling; for (let k = 0; k < 4 && n; k++) { li.push((n.innerText || "").replace(/\s+/g, " ").slice(0, 200)); n = n.nextElementSibling; }
      return { milnow: h.innerText, next: li, chips: [...document.querySelectorAll("#air [data-milsec] .chip, #air [data-milsec] button, #air [data-milrole]")].map((e) => e.innerText.replace(/\s+/g, " ")).slice(0, 20) }; });
    log("air military:", JSON.stringify(a));
    await ev(() => { document.querySelector("#air li[data-airmilac]")?.click(); }); await p.waitForTimeout(6000);
    log("plane card:", JSON.stringify(await ev(() => { const adi = document.querySelector("[data-air-adi]"); const r = [...document.querySelectorAll(".k")].find((e) => e.textContent.trim() === "RADIO");
      return { adi: adi ? adi.innerText.replace(/\s+/g, " ").slice(0, 300) || adi.getAttribute("aria-label") || "(no text)" : null, radio: r ? (r.nextElementSibling?.innerText || "").replace(/\s+/g, " ").slice(0, 400) : null }; }).catch((e) => e.message)));
    log("gulf/air page errors:", JSON.stringify(errs.slice(before, before + 10)));
  } catch (e) { log("gulf check could not run:", e.message); }
  // ocean check: EARTH > OCEAN tiles read PortWatch and the warnings relay on the device
  try {
    const before = errs.length;
    await ev(() => { document.querySelector('[data-group="earth"]')?.click(); }); await p.waitForTimeout(1500);
    const arc = []; const t0a = new Map();
    const heap = () => ev(() => performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null).catch(() => null);
    p.on("request", (q) => { if (/arcgis\.com|amazonaws\.com|blob\.core\.windows/.test(q.url()) || (q.redirectedFrom() && t0a.has(q.redirectedFrom()))) t0a.set(q, Date.now()); });
    p.on("requestfailed", (q) => { if (t0a.has(q)) arc.push(`${q.method()} ${new URL(q.url()).pathname} FAILED ${q.failure()?.errorText} ${Date.now() - t0a.get(q)} ms`); });
    p.on("response", async (r) => { const q = r.request(); if (!t0a.has(q)) return; let b = "", n = "?"; try { const buf = await r.body(); n = buf.length; b = buf.slice(0, 200).toString(); } catch (e) { b = "(body not readable: " + e.message.slice(0, 60) + ")"; } const u = new URL(q.url()); arc.push(`${q.method()} ${u.host}${u.pathname.slice(0, 120)}${u.search.slice(0, 120)} ${r.status()} ${n} bytes ${Date.now() - t0a.get(q)} ms acao=${r.headers()["access-control-allow-origin"] || "none"} ${b}`); });
    log("ocean heap before MB:", await heap());
    await ev(() => { document.querySelector('[data-sub="ocean"]')?.click(); });
    { let last = null; for (let k = 0; k < 36; k++) { await p.waitForTimeout(5000); const t = await ev(() => document.querySelector('#ocean [data-oc-jump="choke"]')?.innerText.replace(/\s+/g, " ") ?? null).catch(() => null); if (t !== last) { log(`ocean choke tile at ${(k + 1) * 5} s: ${t} · heap MB ${await heap()}`); last = t; } } }
    log("ocean heap after 180 s MB:", await heap());
    log("ocean msgs:", JSON.stringify(await ev(() => [...document.querySelectorAll("#ocean li.oc-msg")].map((e) => e.innerText.replace(/\s+/g, " "))).catch((e) => e.message)));
    log("ocean t.ocean.choke:", await ev(() => { const v = localStorage.getItem("t.ocean.choke"); return v == null ? "missing" : "length " + v.length; }).catch((e) => e.message));
    log("ocean arcgis requests:", arc.length); arc.forEach((l) => log("   ", l));
    const o = await ev(() => { const t = (q) => document.querySelector(q)?.innerText.replace(/\s+/g, " ") ?? null;
      return { choke: t('#ocean [data-oc-jump="choke"]'), warn: t('#ocean [data-oc-jump="warn"]'),
        chokeMsg: [...document.querySelectorAll("#oc-choke li.oc-msg")].map((e) => e.innerText.replace(/\s+/g, " ")), warnMsg: [...document.querySelectorAll("#oc-warn li.oc-msg")].map((e) => e.innerText.replace(/\s+/g, " ")) }; }, undefined, 15000);
    log("ocean:", JSON.stringify(o)); log("ocean page errors:", JSON.stringify(errs.slice(before, before + 10)));
    try { const r = await fetch("https://relay.frelay.workers.dev/api/publications/broadcast-warn?h=msi.nga.mil&output=json&status=A"); log("relay NGA from runner:", r.status, (await r.text()).slice(0, 200)); } catch (e) { log("relay NGA from runner failed:", e.message); }
  } catch (e) { log("ocean check could not run:", e.message); }
  log("errors", JSON.stringify([...new Set(errs)].slice(0, 10)));
  // the same profile again: must open
  await p.close().catch(() => {}); p = await ctx.newPage(); watchPage(p);
  await p.goto(URL0, { waitUntil: "commit", timeout: 60000 }).catch((e) => fail("reopen: " + e.message));
  const up2 = await p.waitForFunction(() => !document.getElementById("boot") && document.querySelector(".cesium-widget canvas"), null, { timeout: 120000 }).then(() => true).catch(() => false);
  if (!up2) fail("reopened in the same profile: globe not up"); else log("reopened in the same profile: up");
  await shot("out/reopen.png");
  await ctx.close().catch(() => {});
  log(fails.length ? `SOAK FAILED (${fails.length})` : "SOAK PASSED"); process.exit(fails.length ? 1 : 0);
})().catch((e) => { log("FAIL crashed:", e.message); process.exit(1); });
