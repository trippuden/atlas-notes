// Phone soak: an emulated iPhone opens the live site, goes to EARTH > Hazards & Weather with the list full screen,
// scrolls to the bottom and stays there for 5 minutes while live updates arrive. Records every stall of the page
// (frames and timers that came back late, checks the page didn't answer), memory of the browser processes, errors,
// and a screenshot each minute. Then reopens the site in the same profile. Fails on a stall over 2 s or a page that
// stops answering. Usage: node soak.cjs <webkit|chromium> <url> [minutes]
const { execSync } = require("child_process"), fs = require("fs");
const pw = require("playwright");
const ENGINE = process.argv[2] || "webkit", URL0 = process.argv[3], MIN = Number(process.argv[4] || 5);
fs.mkdirSync("out", { recursive: true });
const t0 = Date.now(), log = (...a) => { const l = `${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s ${a.join(" ")}`; console.log(l); fs.appendFileSync("out/log.txt", l + "\n"); };
const fails = []; const fail = (m) => { fails.push(m); log("FAIL", m); };
const rss = () => { try { const pat = ENGINE === "webkit" ? /WebKit|MiniBrowser|pw_run/ : /chrom/i; return execSync("ps -eo rss=,args=", { encoding: "utf8" }).split("\n").filter((l) => pat.test(l)).reduce((s, l) => s + (parseInt(l, 10) || 0), 0) / 1024; } catch { return -1; } };
const procs = () => { try { return execSync("ps -eo rss=,comm=", { encoding: "utf8" }).split("\n").filter((l) => /WebKit|chrom/i.test(l)).map((l) => l.trim()).sort((a, b) => parseInt(b, 10) - parseInt(a, 10)).slice(0, 4).join(" | "); } catch { return ""; } };
(async () => {
  const dev = pw.devices["iPhone 14 Pro"];
  const ctx = await pw[ENGINE].launchPersistentContext("prof", { ...dev, ...(ENGINE === "chromium" ? { args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] } : {}) });
  let p = ctx.pages()[0] || (await ctx.newPage());
  const errs = []; const watchPage = (pg) => { pg.on("pageerror", (e) => errs.push(e.message)); pg.on("crash", () => fail("page crashed")); pg.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|net::/.test(m.text())) errs.push(m.text().slice(0, 200)); }); };
  watchPage(p);
  if (ENGINE === "chromium") { const cdp = await ctx.newCDPSession(p); await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 }); log("chromium: CPU slowed 4x"); }
  else log("webkit: real Safari engine, CPU not slowed (WebKit has no throttle)");
  const answers = async (label, ms = 5000) => { const s = Date.now(); try { await Promise.race([p.evaluate(() => 1), new Promise((_, j) => setTimeout(() => j(new Error("x")), ms))]); return Date.now() - s; } catch { fail(`page did not answer for ${ms / 1000} s (${label})`); return -1; } };
  const instrument = () => p.evaluate(() => { if (window.__m) return; const m = (window.__m = { frames: [], timers: [], worstFrame: 0, worstTimer: 0 });
    let l = performance.now(); const f = (t) => { const g = t - l; l = t; if (g > m.worstFrame) m.worstFrame = g; if (g > 250) m.frames.push([Math.round(t / 1000), Math.round(g)]); requestAnimationFrame(f); }; requestAnimationFrame(f);
    let e = performance.now() + 100; setInterval(() => { const n = performance.now(), late = n - e; e = n + 100; if (late > m.worstTimer) m.worstTimer = late; if (late > 250) m.timers.push([Math.round(n / 1000), Math.round(late)]); }, 100); });
  log("open", URL0);
  await p.goto(URL0, { waitUntil: "commit", timeout: 60000 });
  const up = await p.waitForFunction(() => !document.getElementById("boot") && document.querySelector(".cesium-widget canvas"), null, { timeout: 120000 }).then(() => true).catch(() => false);
  log(up ? "globe up" : "FAIL globe not up in 120 s"); if (!up) fail("globe not up");
  log("build", await p.evaluate(() => window.TERMINAL_CONFIG?.build).catch(() => "?"), "rss MB", rss().toFixed(0));
  await instrument(); await p.waitForTimeout(20000);
  await p.evaluate(() => { document.querySelector('.hud-ops [data-act="data"]')?.click(); }); await p.waitForTimeout(1500);
  await p.evaluate(() => { document.querySelector('[data-group="earth"]')?.click(); }); await p.waitForTimeout(2500);
  await p.evaluate(() => { document.querySelector('[data-sub="hazards"]')?.click(); }); await p.waitForTimeout(2500);
  await p.evaluate(() => { if (!document.body.classList.contains("sheet-full")) document.querySelector(".sheet-grab")?.click(); }); await p.waitForTimeout(2000);
  log("on EARTH > hazards, sheet full:", await p.evaluate(() => document.body.classList.contains("sheet-full")), "items:", await p.evaluate(() => document.querySelectorAll("#hazards li, #hazards .item, #hazards > *").length));
  await p.screenshot({ path: "out/0-hazards.png" });
  // scroll to the bottom like a thumb: steps of a screen, then hold there
  const scrollDown = () => p.evaluate(async () => { const h = document.getElementById("hazards"); let s = h; while (s && s !== document.body && !(s.scrollHeight > s.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(s).overflowY))) s = s.parentElement;
    if (!s || s === document.body) return { err: "no scroller" }; for (let i = 0; i < 60 && s.scrollTop + s.clientHeight < s.scrollHeight - 2; i++) { s.scrollBy(0, s.clientHeight * 0.8); await new Promise((r) => setTimeout(r, 250)); }
    return { top: Math.round(s.scrollTop), height: s.scrollHeight, items: h.querySelectorAll("*").length }; });
  log("scrolled", JSON.stringify(await scrollDown())); await answers("after scroll");
  const end = Date.now() + MIN * 60e3; let minute = 0;
  while (Date.now() < end) {
    await p.waitForTimeout(10000);
    const a = await answers("holding at the bottom");
    const m = await p.evaluate(() => ({ wf: Math.round(__m.worstFrame), wt: Math.round(__m.worstTimer), nf: __m.frames.length, nt: __m.timers.length, heap: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null, live: window.TERMINAL_CONFIG && document.querySelector("#liveStatus, .live-status")?.textContent?.slice(0, 60) })).catch(() => null);
    log(`answer ${a} ms`, "worst frame", m?.wf, "worst timer", m?.wt, "stalls", m?.nf, m?.nt, "heap MB", m?.heap, "rss MB", rss().toFixed(0), "|", procs());
    if (Date.now() > t0 + (minute + 1) * 60e3) { minute++; await p.screenshot({ path: `out/${minute}-min.png` }).catch(() => {}); log("scrolled", JSON.stringify(await scrollDown().catch((e) => ({ err: e.message })))); }
  }
  const m = await p.evaluate(() => __m).catch(() => null);
  if (m) { fs.writeFileSync("out/stalls.json", JSON.stringify(m)); log("stalls over 250 ms: frames", JSON.stringify(m.frames.slice(-30)), "timers", JSON.stringify(m.timers.slice(-30)));
    if (m.worstTimer > 2000) fail(`a ${Math.round(m.worstTimer)} ms stall on EARTH > Hazards`); }
  log("errors", JSON.stringify([...new Set(errs)].slice(0, 10)));
  // the same profile again: must open
  await p.close().catch(() => {}); p = await ctx.newPage(); watchPage(p);
  await p.goto(URL0, { waitUntil: "commit", timeout: 60000 }).catch((e) => fail("reopen: " + e.message));
  const up2 = await p.waitForFunction(() => !document.getElementById("boot") && document.querySelector(".cesium-widget canvas"), null, { timeout: 120000 }).then(() => true).catch(() => false);
  if (!up2) fail("reopened in the same profile: globe not up"); else log("reopened in the same profile: up");
  await p.screenshot({ path: "out/reopen.png" }).catch(() => {});
  await ctx.close().catch(() => {});
  log(fails.length ? `SOAK FAILED (${fails.length})` : "SOAK PASSED"); process.exit(fails.length ? 1 : 0);
})().catch((e) => { log("FAIL crashed:", e.message); process.exit(1); });
