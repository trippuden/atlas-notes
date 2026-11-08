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
// only=poles,block=<pattern>: the poles check aborts every request whose address matches, to find which layer breaks a page
const BLOCK = ((process.env.ONLY || "").split(",").map((x) => x.trim()).find((x) => x.startsWith("block=")) || "").slice(6);
const rss = () => { try { const pat = ENGINE === "webkit" ? /webkit|wpe|minibrowser|pw_run/i : /chrom/i; return execSync("ps -eo rss=,args=", { encoding: "utf8" }).split("\n").filter((l) => pat.test(l) && !/soak\.cjs|tap-check|xvfb-run/.test(l)).reduce((s, l) => s + (parseInt(l, 10) || 0), 0) / 1024; } catch { return -1; } };
const procs = () => { try { return execSync("ps -eo rss=,comm=", { encoding: "utf8" }).split("\n").filter((l) => /webkit|wpe|minibrowser|chrom/i.test(l)).map((l) => l.trim()).sort((a, b) => parseInt(b, 10) - parseInt(a, 10)).slice(0, 4).join(" | "); } catch { return ""; } };
const finish = () => { log(fails.length ? `SOAK FAILED (${fails.length})` : "SOAK PASSED"); process.exit(fails.length ? 1 : 0); };
setTimeout(() => { fail("soak ran out of time"); finish(); }, (MIN + 36) * 60e3);
// The live files through a local address: the app hands its globe to test scripts only on localhost. Every byte of the
// site still comes from the live address; the browser fetches every other host (maps, feeds) itself.
async function passThrough() {
  const http = require("http"), https = require("https"), base = new URL(URL0);
  const srv = http.createServer((q, r) => {
    const get = (u, n) => (u.protocol === "https:" ? https : http).get(u, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && n < 3) { res.resume(); return get(new URL(res.headers.location, u), n + 1); }
      r.writeHead(res.statusCode, { "content-type": res.headers["content-type"] || "application/octet-stream" }); res.pipe(r);
    }).on("error", () => { r.writeHead(502); r.end(); });
    get(new URL("." + q.url, base), 0);
  });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  return { url: `http://localhost:${srv.address().port}/`, close: () => srv.close() };
}

// The tap check (tap-check.cjs: map taps and the Sea key, desktop and phone) on the live files.
async function liveTapCheck() {
  const { execFile } = require("child_process"), pt = await passThrough();
  const out = await new Promise((ok) => execFile("node", ["tap-check.cjs"], { env: { ...process.env, URL: pt.url, CHROME: pw.chromium.executablePath() }, timeout: 360000, maxBuffer: 1 << 20 },
    (e, so, se) => ok({ code: e ? e.code ?? 1 : 0, text: `${so || ""}${se || ""}` })));
  pt.close();
  for (const l of out.text.split("\n").filter((l) => /^(ok|FAIL)|TAP CHECK/.test(l))) log("tap:", l);
  if (out.code !== 0) fail(`tap check on the live files failed (exit ${out.code})`);
}

// The poles on the live files: the caps past 80 degrees, the sea ice and the Antarctic stations come from NASA GIBS and the
// COMNAP ArcGIS service, which only a runner on the open internet reaches. Ocean tab on, each pole from 3,000 and 600 km:
// GIBS tiles per layer (answers, highest level, size), the COMNAP answer (status, CORS header, stations), stations drawn,
// page errors, memory (north, south, north again) and on desktop a small picture of each pole ("PIC <name> <base64 jpeg>").
// Then the Argo floats from Ifremer's ERDDAP: the list query (status, CORS header, rows, time) and one float's card with its
// dive profile (a measurement: it fails nothing).
async function polesCheck() {
  let b = null, step = "start", peak = 0, peakAt = "", upMb = 0, oceanMb = 0, crashed = ""; const pt = await passThrough(), phone = !DESK;
  // the browser's memory now, and the highest seen with the step it was seen at (for the one-line summary at the end)
  const mb = () => { const m = Math.round(rss()); if (m > peak) { peak = m; peakAt = step; } return m; };
  try {
    b = await pw[ENGINE].launch(ENGINE === "chromium" ? { args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] } : {});
    const c = await b.newContext({ ...(phone ? pw.devices["iPhone 14 Pro"] : { viewport: { width: 1466, height: 800 } }), serviceWorkers: "block" });
    await c.addInitScript(() => { try { localStorage.setItem("t.seenIntro", "1"); localStorage.removeItem("t.ocean.comnap"); } catch { /* private mode */ } });
    const w = await c.newPage(), errs = [], tiles = [], comnap = [], argo = [], sentAt = new Map();
    if (BLOCK) { await w.route(new RegExp(BLOCK, "i"), (r) => r.abort()); log(`poles: every request matching ${BLOCK} is refused`); }
    const wev = (fn, arg) => Promise.race([w.evaluate(fn, arg), new Promise((_, j) => setTimeout(() => j(new Error("page did not answer in 45 s")), 45000))]);
    w.on("pageerror", (e) => errs.push("page: " + e.message.slice(0, 160)));
    w.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text().slice(0, 160)); });
    const argoKind = (u) => (/\?pres,temp,psal/.test(u) ? "profile" : "list");
    w.on("request", (q) => { if (/erddap\.ifremer\.fr/.test(q.url())) sentAt.set(q, Date.now()); });
    w.on("requestfinished", async (q) => { if (!sentAt.has(q)) return; const r = await q.response().catch(() => null); let rows = -1, n = -1; try { const buf = await r.body(); n = buf.length; rows = JSON.parse(buf.toString()).table?.rows?.length ?? -1; } catch { /* not json */ }
      argo.push(`${argoKind(q.url())}: status ${r ? r.status() : "?"}, cors ${r?.headers()["access-control-allow-origin"] || "none"}, ${rows} rows, ${Math.round(n / 1024)} KB in ${Date.now() - sentAt.get(q)} ms`); });
    w.on("requestfailed", (q) => { if (sentAt.has(q)) argo.push(`${argoKind(q.url())}: failed (${q.failure()?.errorText}) after ${Date.now() - sentAt.get(q)} ms`);
      const u = q.url(); if (/gibs\.earthdata\.nasa\.gov/.test(u)) tiles.push({ layer: (u.match(/best\/([^/]+)\//) || [])[1] || "?", z: -1, st: q.failure()?.errorText || "failed", n: 0 }); else if (/COMNAP/i.test(u)) comnap.push({ st: q.failure()?.errorText || "failed", acao: "-", n: -1 }); });
    w.on("response", async (r) => { const u = r.url();
      if (/gibs\.earthdata\.nasa\.gov/.test(u)) { const m = u.match(/best\/([^/]+)\/default\/[^/]+\/[^/]+\/(\d+)\/\d+\/\d+\./); let n = 0; try { n = (await r.body()).length; } catch { /* gone */ } tiles.push({ layer: m?.[1] || "?", z: m ? +m[2] : -1, st: r.status(), n }); }
      else if (/COMNAP/i.test(u)) { let n = -1; try { n = (JSON.parse((await r.body()).toString()).features || []).length; } catch { /* not json */ } comnap.push({ st: r.status(), acao: r.headers()["access-control-allow-origin"] || "none", n }); } });
    step = "opening the site"; await w.goto(pt.url, { timeout: 90000 });
    await w.waitForFunction(() => !document.getElementById("boot") && window.viewer && document.querySelector(".cesium-widget canvas"), null, { timeout: 180000 });
    await w.waitForTimeout(6000);
    // EARTH > Ocean, shown (on desktop the lists live in the Data drawer)
    if (phone) { upMb = mb(); log(`poles: memory once up (EARTH, nothing opened): ${upMb} MB browser | ${procs()}`); }
    // what the page took this browser for: the phone settings (coarse pointer, small screen) or the computer ones
    log("poles: page settings", JSON.stringify(await wev(() => ({ coarse: matchMedia("(pointer: coarse)").matches, screen: [screen.width, screen.height], dpr: devicePixelRatio,
      scale: window.viewer.resolutionScale, cache: window.viewer.scene.globe.tileCacheSize, sse: window.viewer.scene.globe.maximumScreenSpaceError,
      canvas: [window.viewer.canvas.width, window.viewer.canvas.height], layers: window.viewer.imageryLayers.length })).catch((e) => ({ err: e.message }))));
    step = "opening EARTH > Ocean";
    await wev(() => { document.querySelector('.hud-ops [data-act="data"]')?.click(); document.querySelector('[data-group="earth"]')?.click(); });
    await w.waitForTimeout(600); await wev(() => document.querySelector('[data-sub="ocean"]')?.click()); await w.waitForTimeout(6000);
    if (phone) { oceanMb = mb(); log(`poles: memory with EARTH > Ocean open: ${oceanMb} MB browser | ${procs()}`); }
    const mem = async () => phone ? `${mb()} MB browser` : `${Math.round((await wev(() => performance.memory?.usedJSHeapSize || 0)) / 1048576)} MB heap`;
    const look = (lat, h) => wev(([lat, h]) => { const C = window.Cesium, cam = window.viewer.camera; cam.cancelFlight?.(); cam.setView({ destination: C.Cartesian3.fromDegrees(0, lat, h), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } }); }, [lat, h]);
    // on a phone the browser's memory and the tiles asked for are logged every 5 s, and a crash says where it happened
    const settle = async () => { let k = 0; for (; k < 30; k++) { await w.waitForTimeout(1000); if (phone && k % 5 === 4) log(`poles: watch ${step} ${k + 1} s: ${mb()} MB browser, ${tiles.length} GIBS tiles so far | ${procs()}`);
      if (await wev(() => window.viewer.scene.globe.tilesLoaded).catch(() => false)) break; } await w.waitForTimeout(1500); return k; };
    w.on("crash", () => { crashed = step; log(`poles: PAGE CRASHED at ${step}: ${mb()} MB browser, ${tiles.length} GIBS tiles, last ${JSON.stringify(tiles.slice(-3))} | ${procs()}`); });
    const sum = (from) => { const by = {}; for (const t of tiles.slice(from)) { const L = (by[t.layer] ||= { n: 0, ok: 0, z: -1, kb: 0, other: {} }); L.n++; if (t.st === 200) { L.ok++; L.z = Math.max(L.z, t.z); L.kb += t.n / 1024; } else L.other[t.st] = (L.other[t.st] || 0) + 1; }
      return Object.entries(by).map(([k, L]) => `${k.replace(/_/g, " ").slice(0, 34)}: ${L.ok}/${L.n} ok, level ${L.z}, ${Math.round(L.kb)} KB${Object.keys(L.other).length ? " " + JSON.stringify(L.other) : ""}`).join("; ") || "no GIBS tiles"; };
    // a browser screenshot at half size (made by the browser itself, no wait for fonts), then measured and shrunk in a blank
    // page; a picture that can't be made is logged and the check goes on
    const pic = async (name) => {
      try {
        const cdp = await c.newCDPSession(w), vp = w.viewportSize();
        const shot = await Promise.race([cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 70, clip: { x: 0, y: 0, width: vp.width, height: vp.height, scale: 0.5 } }), new Promise((_, j) => setTimeout(() => j(new Error("no picture in 40 s")), 40000))]);
        await cdp.detach().catch(() => {}); fs.writeFileSync(`out/pole-${name}.jpg`, Buffer.from(shot.data, "base64"));
        const q = await c.newPage();
        const o = await q.evaluate(async (b64) => { const img = new Image(); img.src = "data:image/jpeg;base64," + b64; await img.decode(); const W = img.width, H = img.height;
          const cw = Math.min(200, W), ch = Math.min(200, H), c2 = document.createElement("canvas"); c2.width = cw; c2.height = ch;
          const g = c2.getContext("2d", { willReadFrequently: true }); g.drawImage(img, (W - cw) >> 1, (H - ch) >> 1, cw, ch, 0, 0, cw, ch); const d = g.getImageData(0, 0, cw, ch).data;
          const L = (i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; let s = 0, m = 0, n = 0;
          for (let y = 1; y < ch - 1; y++) for (let x = 1; x < cw - 1; x++) { const i = (y * cw + x) * 4; s += Math.abs(4 * L(i) - L(i - 4) - L(i + 4) - L(i - cw * 4) - L(i + cw * 4)); m += L(i); n++; }
          const c3 = document.createElement("canvas"); c3.width = 360; c3.height = Math.round((360 * H) / W); c3.getContext("2d").drawImage(img, 0, 0, c3.width, c3.height);
          return { sharp: +(s / n).toFixed(2), bright: Math.round(m / n), small: c3.toDataURL("image/jpeg", 0.5).split(",")[1] }; }, shot.data);
        await q.close();
        log(`poles: ${name} picture: detail ${o.sharp} (mean edge strength in the middle of a half-size shot), brightness ${o.bright}`); log(`PIC ${name} ${o.small}`);
      } catch (e) { log(`poles: no ${name} picture: ${e.message.slice(0, 120)}`); }
    };
    const heap = {};
    for (const [name, lat, h] of [["north 3000 km", 89.5, 3e6], ["north 600 km", 89.5, 6e5], ["south 3000 km", -89.5, 3e6], ["south 600 km", -89.5, 6e5], ["north 600 km again", 89.5, 6e5]]) {
      step = name; const from = tiles.length; await look(lat, h); const secs = await settle(); heap[name] = await mem();
      log(`poles: ${name} (${secs < 30 ? `tiles in after ${secs} s` : "tiles still loading after 30 s"}): ${sum(from)}; ${heap[name]}`);
      if (!phone && (name === "north 600 km" || name === "south 600 km")) await pic(name.split(" ")[0]);
    }
    // one Argo float's card: over the first float drawn, tapped where it shows
    step = "opening an Argo float";
    const fl = await wev(() => { const C = window.Cesium, v = window.viewer; let pos = null, n = 0; const walk = (col) => { for (let i = 0; i < col.length; i++) { const x = col.get(i);
      if (x instanceof C.PrimitiveCollection) walk(x); else if (typeof x.get === "function" && typeof x.length === "number") for (let j = 0; j < x.length; j++) { const q = x.get(j); if (String(q?.id?.ocean || "").startsWith("argo:")) { n++; if (!pos && q.position) pos = q.position; } } } };
      walk(v.scene.primitives); if (!pos) return { n }; const g = C.Cartographic.fromCartesian(pos); v.camera.setView({ destination: C.Cartesian3.fromRadians(g.longitude, g.latitude, 1.5e6) }); return { n, lon: C.Math.toDegrees(g.longitude), lat: C.Math.toDegrees(g.latitude) }; });
    if (fl.lat == null) log(`argo: ${fl.n} floats drawn, none to open; requests: ${argo.join(" | ") || "no Argo request (this build has no Argo layer)"}`);
    else {
      await w.waitForTimeout(3000);
      const xy = await wev(([lon, lat]) => { const C = window.Cesium, v = window.viewer, q = C.SceneTransforms.worldToWindowCoordinates(v.scene, C.Cartesian3.fromDegrees(lon, lat, 30)); return q ? [q.x, q.y] : null; }, [fl.lon, fl.lat]);
      if (xy) { await w.mouse.click(xy[0], xy[1]); await w.waitForTimeout(12000); }
      const card = await wev(() => { const d = document.getElementById("detail"), body = document.getElementById("detailBody"); return d && !d.classList.contains("hidden") ? { text: (body?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 140), chart: !!body?.querySelector("svg.oc-prof") } : null; });
      log(`argo: ${fl.n} floats drawn; tapped one at ${fl.lat.toFixed(2)}, ${fl.lon.toFixed(2)}: ${card ? `card "${card.text}"${card.chart ? ", dive chart drawn" : ", no dive chart"}` : "no card opened"}; requests: ${argo.join(" | ") || "none"}`);
      await wev(() => document.getElementById("detailClose")?.click()).catch(() => {});
    }
    step = "counting stations"; const st = await wev(() => { const C = window.Cesium, v = window.viewer; let drawn = 0; const walk = (col) => { for (let i = 0; i < col.length; i++) { const x = col.get(i);
      if (x instanceof C.PrimitiveCollection) walk(x); else if (typeof x.get === "function" && typeof x.length === "number") for (let j = 0; j < x.length; j++) { const q = x.get(j); if (String(q?.id?.ocean || "").startsWith("stn:") && q.show !== false) drawn++; } } };
      walk(v.scene.primitives); let saved = 0; try { saved = JSON.parse(localStorage.getItem("t.ocean.comnap") || "null")?.v?.length || 0; } catch { /* none */ } return { drawn, saved }; });
    log(`poles: COMNAP answers ${JSON.stringify(comnap)}; ${st.saved} stations kept, ${st.drawn} drawn`);
    log(`poles: ${errs.length} page or console errors${errs.length ? ": " + [...new Set(errs)].slice(0, 6).join(" | ") : ""}`);
    const capOk = tiles.some((t) => t.layer === "BlueMarble_NextGeneration" && t.st === 200);
    if (!capOk) fail("poles: no Blue Marble cap tile came back from NASA GIBS");
    if (!comnap.some((x) => x.st === 200 && x.n > 0) || !st.drawn) fail(`poles: Antarctic stations did not load or draw (${JSON.stringify(comnap)}, ${st.drawn} drawn)`);
    if (errs.some((e) => e.startsWith("page:"))) fail("poles: the page threw errors");
  } catch (e) { fail(`poles check could not run (at ${step}): ${e.message.slice(0, 160)}`); }
  finally {
    if (phone) log(`poles summary (${ENGINE}): up ${upMb} MB, EARTH > Ocean open ${oceanMb} MB, peak ${peak} MB at ${peakAt || "none"}, ${crashed ? `page crashed at ${crashed}` : "no crash"}`);
    await b?.close().catch(() => {}); pt.close();
  }
}

// Live ships on the real site address (desktop), where the browser's own CORS rules apply: the Sea key, 70 s, then the
// Ships list's first lines and every meri.digitraffic.fi request (status, CORS header, size, time or error), then one
// fetch of the positions and one of the vessel list from the page itself with timings; then one fetch of OpenSky's whole-world aircraft list from the
// page (does it answer a browser, and how fast). A measurement: it fails nothing.
async function shipsCheck() {
  let b = null;
  try {
    b = await pw.chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
    const c = await b.newContext({ viewport: { width: 1466, height: 800 }, serviceWorkers: "block" });
    await c.addInitScript(() => { try { localStorage.setItem("t.seenIntro", "1"); } catch { /* private mode */ } });
    const w = await c.newPage(), net = [], msgs = [], sent = new Map();
    const wev = (fn, arg) => Promise.race([w.evaluate(fn, arg), new Promise((_, j) => setTimeout(() => j(new Error("page did not answer")), 60000))]);
    w.on("request", (q) => { if (/digitraffic\.fi/.test(q.url())) sent.set(q, Date.now()); });
    w.on("requestfinished", async (q) => { if (!sent.has(q)) return; const r = await q.response().catch(() => null); let n = -1; try { n = (await r.body()).length; } catch { /* gone */ }
      net.push(`${r ? r.status() : "?"} cors=${r?.headers()["access-control-allow-origin"] || "none"} ${n} bytes in ${Date.now() - sent.get(q)} ms ${new URL(q.url()).pathname}`); });
    w.on("requestfailed", (q) => { if (sent.has(q)) net.push(`failed: ${q.failure()?.errorText} after ${Date.now() - sent.get(q)} ms ${new URL(q.url()).pathname}`); });
    w.on("console", (m) => { if (/digitraffic|opensky|CORS|ships?\b/i.test(m.text())) msgs.push(`${m.type()}: ${m.text().slice(0, 200)}`); });
    await w.goto(URL0, { timeout: 90000 });
    await w.waitForFunction(() => !document.getElementById("boot") && document.querySelector(".cesium-widget canvas"), null, { timeout: 180000 }); await w.waitForTimeout(5000);
    const how = await wev(() => { const k = document.querySelector('[data-act="group"][data-v="sea"]'); if (k) { k.click(); return "Sea key"; }
      document.querySelector('.hud-ops [data-act="data"]')?.click(); document.querySelector('[data-group="intel"]')?.click(); setTimeout(() => document.querySelector('[data-sub="ships"]')?.click(), 500); return "INTEL > Ships (no Sea key on this build)"; });
    await w.waitForTimeout(70000);
    let lines = await wev(() => [...document.querySelectorAll("#ships > li")].slice(0, 3).map((li) => li.textContent.replace(/\s+/g, " ").trim().slice(0, 170)));
    if (!lines.length) { await wev(() => document.querySelector('.hud-ops [data-act="data"]')?.click()); await w.waitForTimeout(2500); lines = await wev(() => [...document.querySelectorAll("#ships > li")].slice(0, 3).map((li) => li.textContent.replace(/\s+/g, " ").trim().slice(0, 170))); }
    const direct = await wev(async () => { const t = performance.now(); try { const r = await fetch("https://meri.digitraffic.fi/api/ais/v1/locations", { cache: "no-store" }); const head = Math.round(performance.now() - t);
      const n = (await r.arrayBuffer()).byteLength; return `status ${r.status}, content-length ${r.headers.get("content-length")}, cors ${r.headers.get("access-control-allow-origin")}, headers in ${head} ms, ${n} bytes in ${Math.round(performance.now() - t)} ms`; }
      catch (e) { return `error after ${Math.round(performance.now() - t)} ms: ${e.message || e}`; } });
    log(`ships: opened by ${how}; after 70 s the Ships list reads: ${lines.length ? lines.join(" | ") : "(empty)"}`);
    log(`ships: ${net.length} digitraffic requests: ${net.slice(0, 8).join(" | ") || "none"}`);
    if (msgs.length) log(`ships: console: ${[...new Set(msgs)].slice(0, 5).join(" | ")}`);
    log(`ships: fetch from the page: ${direct}`);
    const ves = await wev(async () => { const t = performance.now(); try { const r = await fetch("https://meri.digitraffic.fi/api/ais/v1/vessels", { cache: "no-store" }); const head = Math.round(performance.now() - t);
      const n = (await r.arrayBuffer()).byteLength; return `status ${r.status}, cors ${r.headers.get("access-control-allow-origin")}, headers in ${head} ms, ${n} bytes in ${Math.round(performance.now() - t)} ms`; }
      catch (e) { return `error after ${Math.round(performance.now() - t)} ms: ${e.message || e}`; } });
    log(`ships: vessels list fetched from the page: ${ves}`);
    const sky = await wev(async () => { const t = performance.now(); try { const r = await fetch("https://opensky-network.org/api/states/all", { cache: "no-store" }); const head = Math.round(performance.now() - t); const j = await r.json();
      return `status ${r.status}, cors ${r.headers.get("access-control-allow-origin")}, ${j.states?.length ?? "no"} aircraft, feed time ${j.time ? new Date(j.time * 1000).toISOString().slice(11, 19) + "Z" : "none"}, headers in ${head} ms, all in ${Math.round(performance.now() - t)} ms`; }
      catch (e) { return `error after ${Math.round(performance.now() - t)} ms: ${e.message || e}`; } });
    log(`opensky: fetch from the page: ${sky}`);
    const late = [...new Set(msgs)].filter((m) => /opensky/i.test(m)); if (late.length) log(`opensky: console: ${late.slice(0, 3).join(" | ")}`);
  } catch (e) { log("ships check could not run: " + e.message.slice(0, 160)); }
  finally { await b?.close().catch(() => {}); }
}

// News and radio on the live files through the localhost pass-through (the page's test hooks answer only there), with
// the real outlets and radio feed: All news must be under 30 minutes old from the page's own outlet reads, and radio must
// draw no signal line by default and show the "Shortwave radio right now" table.
async function newsCheck() {
  let b = null; const pt = await passThrough();
  try {
    b = await pw.chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
    const c = await b.newContext({ viewport: { width: 1466, height: 800 }, serviceWorkers: "block" });
    await c.addInitScript(() => { try { localStorage.setItem("t.seenIntro", "1"); localStorage.removeItem("t.livefeeds"); localStorage.removeItem("t.radio.arcs"); } catch { /* private mode */ } });
    const w = await c.newPage();
    const wev = (fn, arg) => Promise.race([w.evaluate(fn, arg), new Promise((_, j) => setTimeout(() => j(new Error("page did not answer")), 60000))]);
    await w.goto(pt.url, { timeout: 90000 });
    await w.waitForFunction(() => !document.getElementById("boot") && window.__news && document.querySelector(".cesium-widget canvas"), null, { timeout: 180000 });
    await wev(() => { document.querySelector('.hud-ops [data-act="data"]')?.click(); document.querySelector('[data-group="live"]')?.click(); }); await w.waitForTimeout(1500);
    await wev(() => document.querySelector('[data-sub="radio"]')?.click());
    await w.waitForFunction(() => window.__radio?.hf, null, { timeout: 30000 }).catch(() => {});
    let h = null;
    for (let k = 0; k < 12; k++) { await w.waitForTimeout(5000); h = await wev(() => window.__radio?.hf?.() || null).catch((e) => ({ err: e.message })); if (h && !h.err && h.total > 0) break; }
    const tbl = await wev(() => { const d = document.querySelector('[data-sec="radio-hf"]'); if (!d) return null; let n = 0;
      for (let e = d.nextElementSibling; e && !e.classList.contains("day"); e = e.nextElementSibling) n++;
      return { rows: n, text: d.parentElement.innerText.replace(/\s+/g, " ").slice(0, 300) }; }).catch((e) => ({ err: e.message }));
    log("news radio:", (JSON.stringify(h) || "null").slice(0, 500), "| table", (JSON.stringify(tbl) || "null").slice(0, 400));
    if (!h || h.err) fail(`news radio: could not read the layer (${JSON.stringify(h)})`);
    else if (h.arcs && !h.expert) fail(`news radio: ${h.arcs} signal lines drawn by default`);
    if (!tbl || tbl.err || !tbl.rows) fail(`news radio: no "Shortwave radio right now" table (${JSON.stringify(tbl)})`);
    await wev(() => document.querySelector('[data-group="now"]')?.click()); await w.waitForTimeout(800);
    await wev(() => document.querySelector('[data-sub="news"]')?.click());
    await w.waitForFunction(() => performance.now() > 27000 && window.__news.state.at, null, { timeout: 90000 }).catch(() => {});
    await w.waitForTimeout(6000); // live updates are gathered for up to 5 s before the list redraws
    const n = await wev(() => { const all = window.__news.news(), newest = all.reduce((m, x) => Math.max(m, Date.parse(x.time) || 0), 0), s = window.__news.state;
      return { ageMin: newest ? Math.round((Date.now() - newest) / 6e4) : null, stories: all.length, ok: s.ok, failed: s.failed, readAt: s.at,
        head: (document.querySelector("#news .news-head")?.textContent || "").replace(/\s+/g, " ").slice(0, 300) }; }).catch((e) => ({ err: e.message }));
    log("news list:", JSON.stringify(n));
    if (!n || n.err) fail(`news list: could not read it (${JSON.stringify(n)})`);
    else if (!(n.ageMin <= 30)) fail(`news list: newest story ${n.ageMin} min old (${n.ok?.length} outlets read, not answering: ${(n.failed || []).join(", ")})`);
  } catch (e) { fail(`news check: ${e.message.split("\n")[0]}`); }
  finally { await b?.close().catch(() => {}); pt.close(); }
}

// Weather warnings on the live site (desktop), the way a person turns them on: Filters, then Hurricanes & typhoons and NWS
// warnings, and the weather clock on Next 6 hours. The weather panel's Storms and NWS warnings rows must say how many are
// active, never "Not answering" (until t-v156 the NWS loader threw on every load, and GDACS answers browsers with a bot check).
async function weatherCheck() {
  let b = null;
  try {
    b = await pw.chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
    const c = await b.newContext({ viewport: { width: 1466, height: 800 }, serviceWorkers: "block" });
    const w = await c.newPage(), errs = [];
    w.on("pageerror", (e) => errs.push(e.message.slice(0, 160)));
    const wev = (fn, arg) => Promise.race([w.evaluate(fn, arg), new Promise((_, j) => setTimeout(() => j(new Error("page did not answer")), 60000))]);
    await w.goto(URL0, { timeout: 90000 });
    await w.waitForFunction(() => !document.getElementById("boot") && document.querySelector(".cesium-widget canvas"), null, { timeout: 180000 });
    await wev(() => document.getElementById("filterBtn")?.click()); await w.waitForTimeout(1500);
    await wev(() => { const g = document.querySelector('[data-sect="earth"]'); if (g?.getAttribute("aria-expanded") === "false") g.click(); }); await w.waitForTimeout(1000);
    const sw = [];
    for (const k of ["storms", "warnings"]) { // the panel redraws after each switch, so each is looked up again
      sw.push(await wev((k) => { const t = document.querySelector(`[data-row="${k}"] [data-tg]`); if (!t) return `${k} switch missing`;
        if (t.getAttribute("aria-pressed") !== "true") t.click(); return `${k} switched on`; }, k)); await w.waitForTimeout(800); }
    await wev(() => document.querySelector('[data-wxmode="fc6"]')?.click());
    let rows = [];
    for (let k = 0; k < 18; k++) { await w.waitForTimeout(5000);
      rows = await wev(() => { const f = document.querySelector('#wxRows [data-wxrows][aria-expanded="false"]'); if (f) f.click(); // chips unfold into rows
        return [...document.querySelectorAll("#wxRows .wx-row")].map((r) => ({ label: r.querySelector("b")?.textContent || "", state: r.className.replace("wx-row", "").trim(),
          text: (r.querySelector(".ln")?.textContent || "").replace(/\s+/g, " ").slice(0, 120) })); }).catch((e) => [{ label: "", state: "", text: e.message }]);
      const want = rows.filter((r) => r.label === "Storms" || r.label === "NWS warnings");
      if (want.length === 2 && want.every((r) => r.state !== "loading")) break; }
    log("weather rows:", sw.join(", "), "|", JSON.stringify(rows).slice(0, 700), errs.length ? `| page errors: ${errs.slice(0, 3).join(" / ")}` : "");
    for (const name of ["Storms", "NWS warnings"]) { const r = rows.find((x) => x.label === name);
      if (!r) fail(`weather ${name}: no row in the weather panel`);
      else if (r.state !== "ok" || /Not answering|Not reachable/.test(r.text)) fail(`weather ${name}: ${r.state}, "${r.text}"`); }
  } catch (e) { fail(`weather check: ${e.message.split("\n")[0]}`); }
  finally { await b?.close().catch(() => {}); }
}

// Watch mode on the live site (desktop): an aircraft alert only for the emergency squawks, and once a tap on the alert's
// tag brings the camera close, the tag keeps with the dragged globe (it used to slide away about twice as fast). Two
// aircraft come from a stand-in feed: one squawking 7700, one squawking 1000 (Europe's normal code) with an "unlawful" status.
async function watchCheck() {
  let b = null;
  try {
    b = await pw.chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
    const c = await b.newContext({ viewport: { width: 1466, height: 800 }, serviceWorkers: "block" }), host = new URL(URL0).host;
    await c.addInitScript(() => { try { localStorage.setItem("t.seenIntro", "1"); } catch { /* private mode */ } });
    const ac = (hex, flight, squawk, emergency, lat, lon) => ({ hex, flight, lat, lon, alt_baro: 36000, gs: 450, track: 80, squawk, emergency, t: "A320", seen_pos: 0.5 });
    await c.route((u) => u.host !== host && /\/v2\//.test(u.pathname), (r) => r.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ now: Date.now() / 1000, ac: [ac("4d22a1", "EJU58FD ", "1000", "unlawful", 50.2, 9.6), ac("4d22a2", "TST7700 ", "7700", "general", 47.5, 2.5)] }) }));
    const w = await c.newPage(), wev = (fn, arg) => Promise.race([w.evaluate(fn, arg), new Promise((_, j) => setTimeout(() => j(new Error("page did not answer")), 15000))]);
    await w.goto(URL0 + "?watch", { timeout: 90000 });
    await w.waitForFunction(() => !document.getElementById("boot") && document.querySelector(".cesium-widget canvas") && document.querySelector(".wt-tags"), null, { timeout: 180000 });
    const tagAt = () => wev(() => { const t = [...document.querySelectorAll(".wt-tag")].find((e) => /TST7700/.test(e.textContent) && getComputedStyle(e).opacity !== "0"); if (!t) return null; const r = t.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
    let at = null; for (let k = 0; k < 60 && !at; k++) { await w.waitForTimeout(2000); at = await tagAt().catch(() => null); }
    const f1000 = await wev(() => [...document.querySelectorAll("[data-k], .wt-tag")].filter((e) => /4d22a1/.test(e.dataset.k || "") || /EJU58FD/.test(e.textContent)).map((e) => e.textContent.replace(/\s+/g, " ").slice(0, 80)));
    if (!at) { fail("watch: no alert tag for the 7700 aircraft after 120 s"); return; }
    f1000.length ? fail(`watch: squawk 1000 with an "unlawful" status raised an alert: ${f1000.join(" | ")}`) : log("watch: squawk 1000 with an \"unlawful\" status raised no alert; squawk 7700 did");
    // the alert's row in the watch panel opens the plane's card and brings the camera down to 1,200 km over it, where a stick
    // that leans toward the lens shows most (a tap on the tag itself stops near 5,700 km, where the lean is too small to see)
    await w.click('[data-k*="4d22a2"]', { force: true, timeout: 8000 }); await w.waitForTimeout(8000);
    const a0 = await tagAt(); if (!a0) { fail("watch: the 7700 alert's tag is gone after the tap"); return; }
    const x0 = Math.max(120, a0[0] - 320), y0 = Math.min(760, a0[1] + 160), dx = 140;
    await w.mouse.move(x0, y0); await w.mouse.down(); for (let k = 1; k <= 14; k++) { await w.mouse.move(x0 + (dx * k) / 14, y0); await w.waitForTimeout(60); }
    await w.waitForTimeout(1500); const a1 = await tagAt(); await w.mouse.up(); // measured while the button is still down: no coasting
    const ratio = a1 ? +(Math.hypot(a1[0] - a0[0], a1[1] - a0[1]) / dx).toFixed(2) : null;
    log("watch: tag at", JSON.stringify(a0), "then", JSON.stringify(a1), "after a", dx, "px drag:", ratio, "times the pointer's move");
    ratio != null && ratio <= 1.4 ? log("watch: the alert's tag keeps with the dragged globe") : fail(`watch: the alert's tag ${ratio == null ? "left the screen" : `moved ${ratio} times as far as the pointer`} during a ${dx} px drag (at most 1.4)`);
  } catch (e) { fail("watch check could not run: " + e.message.slice(0, 160)); }
  finally { await b?.close().catch(() => {}); }
}

(async () => {
  // the extra checks first, each in its own browser, so a stuck soak can never skip them
  const ONLY = (process.env.ONLY || "").split(",").map((x) => x.trim()).filter((x) => x && !x.startsWith("block="));
  const HZ = ONLY.includes("hazards"); // only=hazards: the boot and the EARTH > Hazards hold, then stop
  if (ONLY.length && !HZ) { const C = { watch: watchCheck, tap: liveTapCheck, poles: polesCheck, ships: shipsCheck, news: newsCheck, weather: weatherCheck };
    if (DESK) for (const k of ONLY) C[k] ? await C[k]() : fail(`no check named ${k}`);
    else if (ONLY.includes("poles")) await polesCheck(); // a phone engine (the iPhone engine, or chromium as an iPhone) with the polar layers
    finish(); return; }
  if (HZ) log("only the boot and the EARTH > Hazards hold, with graphics call timings for slow frames");
  else if (DESK) { await watchCheck(); await liveTapCheck(); await polesCheck(); await shipsCheck(); await newsCheck(); await weatherCheck(); }
  else if (ENGINE === "webkit") await polesCheck(); // the phone's memory with the polar layers drawing
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
    if (!cdp || stacks >= 6) return; stacks++;
    try { const got = new Promise((r) => cdp.once("Debugger.paused", r)); cdp.send("Debugger.pause").catch(() => {}); const ev2 = await Promise.race([got, new Promise((r) => setTimeout(() => r(null), 10000))]);
      if (!ev2) { log("STACK (" + label + "): could not pause"); return; }
      log("STACK (" + label + "):"); for (const f of ev2.callFrames.slice(0, 25)) log("    at", f.functionName || "(anon)", `${(f.url || "").split("/").pop()}:${f.location.lineNumber + 1}:${f.location.columnNumber + 1}`);
      cdp.send("Debugger.resume").catch(() => {}); } catch (e) { log("stack failed", e.message); }
  };
  let hung = 0;
  const answers = async (label, ms = 5000) => { const s = Date.now(); try { await Promise.race([p.evaluate(() => 1), new Promise((_, j) => setTimeout(() => j(new Error("x")), ms))]); hung = 0; return Date.now() - s; } catch { hung++; fail(`page did not answer for ${ms / 1000} s (${label})`); if (hung > 3) { log("stuck for good (4 no-answers in a row): stopping"); finish(); } await stuckStack(label); await new Promise((r) => setTimeout(r, 2000)); await stuckStack(label + " +2 s"); return -1; } };
  const instrument = () => ev(() => { if (window.__m) return; const m = (window.__m = { frames: [], timers: [], worstFrame: 0, worstTimer: 0 });
    let l = performance.now(); const f = (t) => { const g = t - l; l = t; if (g > m.worstFrame) m.worstFrame = g; if (g > 250) m.frames.push([Math.round(t / 1000), Math.round(g)]); requestAnimationFrame(f); }; requestAnimationFrame(f);
    try { m.long = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.duration > 200) m.long.push([Math.round(e.startTime / 1000), Math.round(e.duration)]); }).observe({ type: "longtask", buffered: true }); } catch {}
    m.loaf = []; try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.duration > 700) m.loaf.push({ at: Math.round(e.startTime / 1000), ms: Math.round(e.duration), block: Math.round(e.blockingDuration || 0),
      styleLayout: Math.round(e.styleAndLayoutStart ? e.startTime + e.duration - e.styleAndLayoutStart : 0), render: Math.round(e.renderStart ? e.startTime + e.duration - e.renderStart : 0),
      scripts: (e.scripts || []).filter((x) => x.duration > 30).sort((a, b) => b.duration - a.duration).slice(0, 6).map((x) => ({ ms: Math.round(x.duration), forcedLayout: Math.round(x.forcedStyleAndLayoutDuration || 0), fn: x.sourceFunctionName || "", src: `${(x.sourceURL || "").split("/").pop()}:${x.sourceCharPosition ?? ""}`, by: (x.invoker || "").slice(0, 60), type: x.invokerType })) }); }).observe({ type: "long-animation-frame", buffered: true }); } catch {}
    // graphics calls counted and timed (shader builds, texture uploads, draws), so a slow frame says where its time went
    m.gl = {}; m.glSeen = {}; for (const G of [window.WebGL2RenderingContext, window.WebGLRenderingContext]) { if (!G) continue; const P = G.prototype;
      for (const k of ["linkProgram", "getProgramParameter", "compileShader", "getShaderParameter", "texImage2D", "texSubImage2D", "generateMipmap", "bufferData", "readPixels", "getError", "drawElements", "drawArrays"]) {
        const o = P[k]; if (typeof o !== "function" || o.__soak) continue;
        const w = function () { const t = performance.now(); try { return o.apply(this, arguments); } finally { const c = (m.gl[k] ||= [0, 0]); c[0]++; c[1] += performance.now() - t; } };
        w.__soak = 1; P[k] = w; }
      if (!P.createShader.__soak) { const kindOf = new WeakMap(), tagOf = new WeakMap(), progTag = (m.progTag ||= new WeakMap()); m.prog ||= {};
        const tagFrom = (src) => { const tu = /#define TEXTURE_UNITS (\d+)/.exec(src), d = (src.match(/#define [A-Z][A-Z0-9_]+/g) || []).map((x) => x.slice(8)).filter((x) => !/^(OES_|GL_|EXT_|WEBGL_|TEXTURE_UNITS$|LOG_DEPTH|OUTPUT_DECLARATION|USE_)/.test(x)).slice(0, 5);
          return `${/u_dayTextures/.test(src) ? `globe ${tu ? tu[1] : "?"} layers` : /u_atlas/.test(src) ? "billboards" : /v_sphericalExtents/.test(src) ? "ground" : /u_cubeMap/.test(src) ? "sky" : "other"}${d.length ? " " + d.join(" ") : ""}`; };
        const cs = P.createShader, ss = P.shaderSource, at = P.attachShader, gp = P.getProgramParameter;
        P.createShader = function (type) { const sh = cs.apply(this, arguments); if (sh) kindOf.set(sh, type === this.FRAGMENT_SHADER); return sh; }; P.createShader.__soak = 1;
        P.shaderSource = function (sh, src) { if (kindOf.get(sh)) tagOf.set(sh, tagFrom(String(src))); return ss.apply(this, arguments); };
        P.attachShader = function (pr, sh) { const t = tagOf.get(sh); if (t) progTag.set(pr, t); return at.apply(this, arguments); };
        P.getProgramParameter = function (pr, pn) { const t = performance.now(); try { return gp.apply(this, arguments); } finally { if (pn === this.LINK_STATUS) { const k = progTag.get(pr) || "untagged", c = (m.prog[k] ||= [0, 0]); c[0]++; c[1] += performance.now() - t; } } }; }
    }
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
  // the graphics calls (count and time per call type, 20 ms and over) since the last reading
  const glSince = () => ev(() => { const seen = (__m.glSeen ||= {}), gl = []; for (const [k, c] of Object.entries(__m.gl || {})) { const q = seen[k] || [0, 0]; gl.push([k, c[0] - q[0], c[1] - q[1]]); seen[k] = [c[0], c[1]]; }
    return gl.filter((x) => x[2] >= 20).sort((x, y) => y[2] - x[2]).map(([k, n, ms]) => `${k} ${n} calls ${Math.round(ms)} ms`).join("; ") || "no graphics call type over 20 ms in all"; }).catch((e) => `no reading: ${e.message.slice(0, 80)}`);
  // what a slow frame was doing (Chromium's long-animation-frame entries): scripts with their file:line and forced
  // layout, plus style/layout/paint time, printed for every frame over 700 ms since the last call
  const progSince = () => ev(() => { const seen = (__m.progSeen ||= {}), out = []; let n = 0, ms = 0; for (const [k, c] of Object.entries(__m.prog || {})) { const q = seen[k] || [0, 0], dn = c[0] - q[0], dm = c[1] - q[1]; seen[k] = [c[0], c[1]]; if (dn) { n += dn; ms += dm; out.push([k, dn, dm]); } }
    return { n, ms: Math.round(ms), top: out.sort((a, b) => b[2] - a[2]).slice(0, 6).map(([k, dn, dm]) => `${k}: ${dn} built, ${Math.round(dm)} ms`).join("; ") }; }).catch(() => ({ n: 0, ms: 0, top: "" }));
  const winStart = async () => {};
  const winEnd = async (label) => { const L = await ev(() => { const a = (__m.loaf || []).slice(__m.loafSeen || 0); __m.loafSeen = (__m.loaf || []).length; return a; }).catch(() => []);
    for (const f of L) log("SLOW FRAME", label, JSON.stringify(f));
    const gl = await glSince(), pg = await progSince(); if (L.length) { log("GL during", label + ":", gl); if (pg.n) log("GL programs built during", label + ":", pg.top); }
    const w = L.sort((a, b) => b.ms - a.ms)[0], sc = w?.scripts?.[0];
    return { ms: w ? w.ms : 0, why: w ? ` (slowest frame ${w.ms} ms: ${sc ? `${sc.ms} ms in ${sc.fn || "anonymous"} ${sc.src} from ${sc.type || "?"} ${sc.by || ""}`.trim() : "no script over 30 ms"}, render ${w.render} ms, style and layout ${w.styleLayout} ms; ${pg.n} shader programs built, ${pg.ms} ms waited; graphics calls: ${gl})` : "" }; };
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
    log("spin: drag input delay ms", JSON.stringify(sp)); const spinWhy = (await winEnd("since the globe came up, spin included (long task over 700 ms)")).why;
    if (sp) { if (!(sp.p90 <= 100)) fail(`drag input answered in ${sp.p90} ms (90th percentile), budget 100 ms`);
      const big = sp.long.filter((x) => x[1] > 200); if (big.length) fail(`${big.length} long tasks over 200 ms while spinning: ${JSON.stringify(big.slice(0, 8))}${spinWhy}`); } }
  if (cdp) { await cdp.send("Profiler.enable"); await cdp.send("Profiler.setSamplingInterval", { interval: 1000 }); await cdp.send("Profiler.start"); }
  const shot = async (f) => { try { await p.screenshot({ path: f, timeout: 8000 }); return true; } catch { log("no frame for a screenshot in 8 s:", f); return false; } };
  // the Hazards stall below counts from here: the worst so far (boot and spin) is logged, then cleared
  log("worst stall before EARTH > Hazards (since the globe came up, spin included):", await ev(() => { const w = [Math.round(__m.worstTimer), Math.round(__m.worstFrame)]; __m.worstTimer = 0; __m.worstFrame = 0; return `timer ${w[0]} ms, frame ${w[1]} ms`; }).catch((e) => e.message.slice(0, 80)));
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
  let holdMs = 0, holdWhy = "";
  while (Date.now() < end) {
    await winStart(); await p.waitForTimeout(10000); const hl = `hold window at ${Math.round((Date.now() - t0) / 1000)} s`, hw = await winEnd(`${hl} (long task over 700 ms)`); if (hw.ms > holdMs) { holdMs = hw.ms; holdWhy = hw.why; }
    const a = await answers("holding at the bottom");
    const m = await ev(() => ({ wf: Math.round(__m.worstFrame), wt: Math.round(__m.worstTimer), nf: __m.frames.length, nt: __m.timers.length, heap: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null, live: window.TERMINAL_CONFIG && document.querySelector("#liveStatus, .live-status")?.textContent?.slice(0, 60) })).catch(() => null);
    log(`answer ${a} ms`, "worst frame", m?.wf, "worst timer", m?.wt, "stalls", m?.nf, m?.nt, "heap MB", m?.heap, "rss MB", rss().toFixed(0), "|", procs());
    if (Date.now() > t0 + (minute + 1) * 60e3) { minute++; await shot(`out/${minute}-min.png`); log("scrolled", JSON.stringify(await scrollDown().catch((e) => ({ err: e.message })))); }
  }
  const m = await ev(() => __m).catch(() => null);
  if (m) { fs.writeFileSync("out/stalls.json", JSON.stringify(m)); log("stalls over 250 ms: frames", JSON.stringify(m.frames.slice(-30)), "timers", JSON.stringify(m.timers.slice(-30)), "long tasks over 200 ms", JSON.stringify((m.long || []).slice(-30)));
    if (m.worstTimer > 2000) fail(`a ${Math.round(m.worstTimer)} ms stall on EARTH > Hazards${holdWhy}`); }
  if (HZ) finish();
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
    const waits = [], dl = Date.now() + (cdp && !DESK ? 15000 : 8000); // time-boxed: software graphics on the runners can make each wheel step take seconds
    for (let k = 0; k < 4 && Date.now() < dl; k++) {
      if (cdp && !DESK) { const up = k % 2 === 0; let y = up ? b.y : Math.max(b.top + 60, b.y - 300); const step = up ? -26 : 26;
        const tc = async (type, pts) => { const a = Date.now(); await cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts }); waits.push(Date.now() - a); };
        await tc("touchStart", [{ x: b.x, y }]); for (let i = 0; i < 12 && Date.now() < dl; i++) { y += step; await tc("touchMove", [{ x: b.x, y }]); await p.waitForTimeout(16); } await tc("touchEnd", []); }
      else { await p.mouse.move(b.x, b.y); for (let i = 0; i < 10 && Date.now() < dl; i++) { const a = Date.now(); await p.mouse.wheel(0, k % 2 ? -160 : 240); waits.push(Date.now() - a); await p.waitForTimeout(40); } }
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
      const tw = await winEnd(`tour ${g}/${sub} (long task over 700 ms)`);
      const sc = await scrollCheck().catch(() => null);
      if (sc) { log("SCROLL", `${g}/${sub}`, JSON.stringify(sc));
        if (sc.by === "finger" && sc.held95 > 100) fail(`tour ${g}/${sub}: touches held ${sc.held95} ms by the page while scrolling (95th percentile)`);
        if (sc.rebuilt > 0) fail(`tour ${g}/${sub}: list rebuilt ${sc.rebuilt} time(s) while it was being scrolled`); }
      const row = { tab: `${g}/${sub}`, ms: Date.now() - t, worstAnswer: worstAns, worstTimer: m?.wt, longest: m ? Math.max(0, ...m.long) : null, longCount: m?.long.length, heap: m?.heap, rss: Math.round(rss()), errors: errs.slice(before).map((e) => e.slice(0, 120)), scroll: sc };
      tour.push(row); log("TOUR", JSON.stringify(row));
      if (row.worstAnswer < 0) fail(`tour ${g}/${sub}: page stopped answering${tw.why}`);
      else if (row.worstTimer > 2000) fail(`tour ${g}/${sub}: ${row.worstTimer} ms stall${tw.why}`);
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
