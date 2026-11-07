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
setTimeout(() => { fail("soak ran out of time"); finish(); }, (MIN + 24) * 60e3);
(async () => {
  const dev = DESK ? { viewport: { width: 1466, height: 800 } } : pw.devices["iPhone 14 Pro"];
  const ctx = await pw[ENGINE].launchPersistentContext("prof", { ...dev, ...(ENGINE === "chromium" ? { args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] } : {}) });
  let p = ctx.pages()[0] || (await ctx.newPage());
  const errs = []; const watchPage = (pg) => { pg.on("pageerror", (e) => errs.push(e.message)); pg.on("crash", () => fail("page crashed")); pg.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|net::/.test(m.text())) errs.push(m.text().slice(0, 200)); }); };
  const T0 = Date.now(), arcAll = [], tq = new Map(), PW = /arcgis\.com|amazonaws\.com|blob\.core\.windows/;
  const netLog = (pg) => { pg.on("request", (q) => { if (PW.test(q.url()) || (q.redirectedFrom() && tq.has(q.redirectedFrom()))) tq.set(q, Date.now()); });
    pg.on("requestfailed", (q) => { if (tq.has(q)) arcAll.push(`+${((tq.get(q) - T0) / 1000).toFixed(0)}s ${q.method()} ${new URL(q.url()).host}${new URL(q.url()).pathname.slice(0, 100)} FAILED ${q.failure()?.errorText} after ${Date.now() - tq.get(q)} ms`); });
    pg.on("response", async (r) => { const q = r.request(); if (!tq.has(q)) return; let n = "?", b = ""; try { const buf = await r.body(); n = buf.length; b = buf.slice(0, 160).toString(); } catch (e) { b = "(body: " + e.message.slice(0, 50) + ")"; }
      const u = new URL(q.url()); arcAll.push(`+${((tq.get(q) - T0) / 1000).toFixed(0)}s ${q.method()} ${u.host}${u.pathname.slice(0, 110)}${u.search.slice(0, 100)} ${r.status()} ${n} bytes ${Date.now() - tq.get(q)} ms acao=${r.headers()["access-control-allow-origin"] || "none"} ${b.replace(/\s+/g, " ")}`); }); };
  netLog(p);
  watchPage(p);
  let cdp = null;
  if (ENGINE === "chromium") { cdp = await ctx.newCDPSession(p); await cdp.send("Debugger.enable"); await cdp.send("Network.enable").catch(() => {}); let nulls = 0;
    cdp.on("Network.requestWillBeSent", (e) => { if (!/\/null(\?|$)/.test(e.request.url) || nulls++ > 3) return; const i = e.initiator || {}; const fr = (i.stack?.callFrames || []).slice(0, 6).map((f) => `${f.functionName || "(anon)"} ${(f.url || "").split("/").pop()}:${f.lineNumber + 1}:${f.columnNumber + 1}`);
      log("NULL URL request:", e.type, i.type, i.url ? i.url.split("/").pop() + ":" + (i.lineNumber + 1) : "", fr.join(" < ")); }); if (!DESK) { await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 }); log("chromium: CPU slowed 4x"); } else log("desktop chromium, full speed"); }
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
    m.loaf = []; try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.duration > 700) m.loaf.push({ at: Math.round(e.startTime / 1000), ms: Math.round(e.duration), block: Math.round(e.blockingDuration || 0),
      styleLayout: Math.round(e.styleAndLayoutStart ? e.startTime + e.duration - e.styleAndLayoutStart : 0), render: Math.round(e.renderStart ? e.startTime + e.duration - e.renderStart : 0),
      scripts: (e.scripts || []).filter((x) => x.duration > 30).sort((a, b) => b.duration - a.duration).slice(0, 6).map((x) => ({ ms: Math.round(x.duration), forcedLayout: Math.round(x.forcedStyleAndLayoutDuration || 0), fn: x.sourceFunctionName || "", src: `${(x.sourceURL || "").split("/").pop()}:${x.sourceCharPosition ?? ""}`, by: (x.invoker || "").slice(0, 60), type: x.invokerType })) }); }).observe({ type: "long-animation-frame", buffered: true }); } catch {}
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
  // each 10 s window is profiled; the profile is printed only when that window had a long task over 700 ms
  let seenBig = 0; const bigCount = () => ev(() => (__m.long || []).filter((x) => x[1] > 700).length).catch(() => 0);
  // what a slow frame was doing (Chromium's long-animation-frame entries): scripts with their file:line and forced
  // layout, plus style/layout/paint time, printed for every frame over 700 ms since the last call
  const winStart = async () => {};
  const winEnd = async (label) => { const L = await ev(() => { const a = (__m.loaf || []).slice(__m.loafSeen || 0); __m.loafSeen = (__m.loaf || []).length; return a; }).catch(() => []);
    for (const f of L) log("SLOW FRAME", label, JSON.stringify(f)); };
  while (Date.now() < end) {
    await winStart(); await p.waitForTimeout(10000); await winEnd(`hold window at ${Math.round((Date.now() - t0) / 1000)} s (long task over 700 ms)`);
    const a = await answers("holding at the bottom");
    const m = await ev(() => ({ wf: Math.round(__m.worstFrame), wt: Math.round(__m.worstTimer), nf: __m.frames.length, nt: __m.timers.length, heap: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null, live: window.TERMINAL_CONFIG && document.querySelector("#liveStatus, .live-status")?.textContent?.slice(0, 60) })).catch(() => null);
    log(`answer ${a} ms`, "worst frame", m?.wf, "worst timer", m?.wt, "stalls", m?.nf, m?.nt, "heap MB", m?.heap, "rss MB", rss().toFixed(0), "|", procs());
    if (Date.now() > t0 + (minute + 1) * 60e3) { minute++; await shot(`out/${minute}-min.png`); log("scrolled", JSON.stringify(await scrollDown().catch((e) => ({ err: e.message })))); }
  }
  const m = await ev(() => __m).catch(() => null);
  if (m) { fs.writeFileSync("out/stalls.json", JSON.stringify(m)); log("stalls over 250 ms: frames", JSON.stringify(m.frames.slice(-30)), "timers", JSON.stringify(m.timers.slice(-30)), "long tasks over 200 ms", JSON.stringify((m.long || []).slice(-30)));
    if (m.worstTimer > 2000) fail(`a ${Math.round(m.worstTimer)} ms stall on EARTH > Hazards`); }
  // Scroll check, every tour tab: the tab's biggest list (sheet at FULL on a phone) is swiped like a finger (chromium
  // phone: real touch events) or turned with the mouse wheel resting on it (desktop, webkit). Each touch's wait is how
  // long the page held it before the browser could move the list (a touch listener that may cancel makes every swipe
  // wait for the page's script); a list torn down and rebuilt while it moves is a hitch and a jump. Fails on touches
  // held over 100 ms (95th percentile) or any rebuild during the scroll.
  const scrollCheck = async () => {
    await ev(() => { if (document.body.classList.contains("m") && !document.body.classList.contains("sheet-full")) document.querySelector(".sheet-grab")?.click(); return 1; }).catch(() => null);
    await p.waitForTimeout(900);
    const b = await ev(() => { const c = [...document.querySelectorAll("*")].filter((e) => e.scrollHeight > e.clientHeight + 40 && /auto|scroll/.test(getComputedStyle(e).overflowY) && e.getClientRects().length && e.clientHeight > 120);
      c.sort((x, y) => y.clientHeight * y.clientWidth - x.clientHeight * x.clientWidth); const e = c[0]; if (!e) return null; window.__sw?.mo.disconnect();
      const sw = window.__sw = { rb: 0, mo: new MutationObserver((ms) => { let rm = 0; for (const m of ms) rm += m.removedNodes.length; if (rm >= Math.max(3, e.children.length * 0.5)) sw.rb++; }) }; sw.mo.observe(e, { childList: true });
      const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(Math.min(r.bottom - 40, r.top + r.height * 0.75)), top: Math.round(r.top), list: e.id || String(e.className).slice(0, 24) }; }).catch(() => null);
    if (!b) return null;
    const waits = [];
    for (let k = 0; k < 4; k++) {
      if (cdp && !DESK) { const up = k % 2 === 0; let y = up ? b.y : Math.max(b.top + 60, b.y - 300); const step = up ? -26 : 26;
        const tc = async (type, pts) => { const a = Date.now(); await cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts }); waits.push(Date.now() - a); };
        await tc("touchStart", [{ x: b.x, y }]); for (let i = 0; i < 12; i++) { y += step; await tc("touchMove", [{ x: b.x, y }]); await p.waitForTimeout(16); } await tc("touchEnd", []); }
      else { await p.mouse.move(b.x, b.y); for (let i = 0; i < 10; i++) { const a = Date.now(); await p.mouse.wheel(0, k % 2 ? -160 : 240); waits.push(Date.now() - a); await p.waitForTimeout(40); } }
      await p.waitForTimeout(400);
    }
    const rebuilt = await ev(() => window.__sw?.rb ?? 0).catch(() => -1);
    waits.sort((x, y) => y - x);
    return { list: b.list, by: cdp && !DESK ? "finger" : "wheel", held95: waits[Math.floor(waits.length * 0.05)], heldMax: waits[0], rebuilt };
  };
  // full tour: every tab and sub-tab, ~15 s each; per tab: page answer, worst stall, long tasks, heap, errors, scroll
  // check, screenshot
  if (process.env.TOUR !== "0") {
    const TABS = { now: ["feed", "news", "mind"], next: ["upcoming", "forecasts", "elections"], earth: ["hazards", "power", "ocean"], air: ["air"], space: ["space"],
      intel: ["detect", "unrest", "crime", "banks", "cyber", "ships", "ocean", "aicheck", "intel"], live: ["live", "radio"], people: ["community", "advisories"] };
    const tour = [];
    for (const [g, subs] of Object.entries(TABS)) for (const sub of subs) {
      const before = errs.length; await ev(() => { __m.worstFrame = 0; __m.worstTimer = 0; __m.tlong = (__m.long || []).length; }).catch(() => {});
      const t = Date.now(); seenBig = await bigCount(); await winStart();
      await ev(([g, sub]) => { document.querySelector(`[data-group="${g}"]`)?.click(); setTimeout(() => document.querySelector(`[data-sub="${sub}"]`)?.click(), 400); }, [g, sub]).catch(() => {});
      let worstAns = 0; for (let k = 0; k < 5; k++) { await p.waitForTimeout(3000); const a = await answers(`tour ${g}/${sub}`, 8000); if (a < 0) { worstAns = -1; break; } worstAns = Math.max(worstAns, a); }
      const m = await ev(() => ({ wf: Math.round(__m.worstFrame), wt: Math.round(__m.worstTimer), long: (__m.long || []).slice(__m.tlong).map((x) => x[1]), heap: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
        shown: (document.querySelector(".sheet .tab.on, #subtabs .on, [data-sub].on")?.textContent || "").trim().slice(0, 30), empty: !document.querySelector(".sheet-body li, .sheet li, .panel li") })).catch(() => null);
      await winEnd(`tour ${g}/${sub} (long task over 700 ms)`);
      const sc = await scrollCheck().catch(() => null);
      if (sc) { log("SCROLL", `${g}/${sub}`, JSON.stringify(sc));
        if (sc.held95 > 100) fail(`tour ${g}/${sub}: touches held ${sc.held95} ms by the page while scrolling (95th percentile)`);
        if (sc.rebuilt > 0) fail(`tour ${g}/${sub}: list rebuilt ${sc.rebuilt} time(s) while it was being scrolled`); }
      const row = { tab: `${g}/${sub}`, ms: Date.now() - t, worstAnswer: worstAns, worstTimer: m?.wt, longest: m ? Math.max(0, ...m.long) : null, longCount: m?.long.length, heap: m?.heap, rss: Math.round(rss()), errors: errs.slice(before).map((e) => e.slice(0, 120)), scroll: sc };
      tour.push(row); log("TOUR", JSON.stringify(row));
      if (row.worstAnswer < 0) fail(`tour ${g}/${sub}: page stopped answering`);
      else if (row.worstTimer > 2000) fail(`tour ${g}/${sub}: ${row.worstTimer} ms stall`);
      await shot(`out/tour-${g}-${sub}.png`);
    }
    log("TOUR SUMMARY worst stall per tab:", tour.map((r) => `${r.tab}=${r.worstTimer}`).join(" "));
    log("SCROLL SUMMARY held (95th pct ms) / rebuilt per tab:", tour.map((r) => `${r.tab}=${r.scroll ? `${r.scroll.held95}/${r.scroll.rebuilt}` : "-"}`).join(" "));
  }
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
    const heap = () => ev(() => performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null).catch(() => null);
    log("ocean heap before MB:", await heap());
    await ev(() => { document.querySelector('[data-sub="ocean"]')?.click(); });
    { let last = null; for (let k = 0; k < 36; k++) { await p.waitForTimeout(5000); const t = await ev(() => document.querySelector('#ocean [data-oc-jump="choke"]')?.innerText.replace(/\s+/g, " ") ?? null).catch(() => null); if (t !== last) { log(`ocean choke tile at ${(k + 1) * 5} s: ${t} · heap MB ${await heap()}`); last = t; } } }
    log("ocean heap after 180 s MB:", await heap());
    log("ocean msgs:", JSON.stringify(await ev(() => [...document.querySelectorAll("#ocean li.oc-msg")].map((e) => e.innerText.replace(/\s+/g, " "))).catch((e) => e.message)));
    log("ocean t.ocean.choke:", await ev(() => { const v = localStorage.getItem("t.ocean.choke"); return v == null ? "missing" : "length " + v.length; }).catch((e) => e.message));
    { let v = null; for (let k = 0; k < 60; k++) { const n = await ev(() => document.documentElement.dataset.ocChoke ?? null).catch(() => null); if (n !== v) { log(`ocChoke at ${Math.round((Date.now() - T0) / 1000)} s: ${n}`); v = n; } if (/^(ok|error)/.test(v || "")) break; await p.waitForTimeout(5000); } log("ocChoke final:", v); }
    log("PortWatch requests from page start:", arcAll.length); arcAll.forEach((l) => log("   ", l));
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
