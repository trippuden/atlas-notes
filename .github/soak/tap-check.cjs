// Tap and sea checks (regressions R43 and R47 in scripts/regress.cjs): big area shapes never take a tap from the spot
// under them, and the Sea key always shows ships.
// Its own script so the main regression run stays inside its time limit.
// Usage: node scripts/tap-check.cjs [dir]   (a built site, default dist/; exit code 1 on a failure)
//        URL=https://... node scripts/tap-check.cjs   (the live site)
const http = require("http"), fs = require("fs"), path = require("path");
let pw; try { pw = require("playwright"); } catch { pw = require("playwright-core"); }
const D = path.resolve(process.argv[2] || "dist"), fails = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (id, m) => console.log(`ok   ${id} ${m}`), bad = (id, m) => { fails.push(m); console.log(`FAIL ${id} ${m}`); };
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".woff2": "font/woff2", ".wasm": "application/wasm", ".glb": "model/gltf-binary", ".webmanifest": "application/manifest+json" };
const serve = () => new Promise((resolve) => { const s = http.createServer((q, r) => {
  let p = decodeURIComponent(new URL(q.url, "http://x").pathname); if (p.endsWith("/")) p += "index.html";
  const f = path.join(D, p); if (!f.startsWith(D) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end(); }
  r.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream" }); fs.createReadStream(f).pipe(r);
}).listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${s.address().port}/`, close: () => s.close() })); });

// R43 big area shapes never take a tap from the spot under them: a warship report area 2,000 km across (the Ronald
// Reagan's Eastern Pacific) covers Los Angeles; tapping LA must not open it or fly the camera away, and tapping the
// carrier's own symbol in the middle must still open it.
async function tapCheck(b, url, phone) {
  const tag = phone ? "phone" : "desk";
  const ctx = await b.newContext({ ...(phone ? pw.devices["iPhone 14 Pro"] : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }), serviceWorkers: "block" });
  await ctx.addInitScript(() => { localStorage.setItem("t.seenIntro", "1"); localStorage.setItem("t.group", "air"); localStorage.setItem("t.layers", JSON.stringify({ navy: true, aircraft: true })); });
  const p = await ctx.newPage();
  await p.route("**/data/naval.json*", (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify({ source: "regression fixture", units: [{ name: "USS Ronald Reagan", hull: "CVN-76", kind: "aircraft carrier", capital: true, place: "Eastern Pacific", lat: 20, lon: -125, km: 2000, date: Date.now() - 864e5, said: "fixture", url: "https://example.org/", report: "fixture" }] }) }));
  try {
    await p.goto(url, { timeout: 60000 }); await p.waitForFunction(() => !document.getElementById("boot") && window.viewer, null, { timeout: 90000 }); await sleep(8000);
    const at = (a) => p.evaluate(([lon, lat, h]) => { const C = window.Cesium, v = window.viewer; if (h) v.camera.setView({ destination: C.Cartesian3.fromDegrees(lon, lat, h) }); v.render();
      const T = C.SceneTransforms, w = (T.worldToWindowCoordinates || T.wgs84ToWindowCoordinates)(v.scene, C.Cartesian3.fromDegrees(lon, lat)), r = v.canvas.getBoundingClientRect(); return w && { x: r.left + w.x, y: r.top + w.y }; }, a);
    const card = () => p.evaluate(() => { const d = document.getElementById("detail"); return d && !d.classList.contains("hidden") ? document.getElementById("detailBody").innerText.replace(/\s+/g, " ").slice(0, 90) : ""; });
    const lon = () => p.evaluate(() => window.viewer.camera.positionCartographic.longitude * 180 / Math.PI);
    const tap = async (s) => { await p.mouse.click(s.x, s.y); await sleep(400); if (phone) await p.mouse.click(s.x, s.y); await sleep(3000); };
    await at([-118.25, 34.05, 6e5]); await sleep(2500); let s = await at([-118.25, 34.05]);
    if (!s) bad("R43", `${tag}: Los Angeles not on screen`); else { await tap(s); const c = await card(), x = await lon();
      /Eastern Pacific|Warships/i.test(c) || x < -121 ? bad("R43", `${tag}: a tap on Los Angeles opened "${c}" and moved the camera to ${x.toFixed(1)}°`) : ok("R43", `${tag}: a tap on Los Angeles stayed there (${c ? `opened "${c.slice(0, 50)}"` : "place tag"})`); }
    await p.evaluate(() => { document.getElementById("detail")?.classList.add("hidden"); document.querySelector(".gx-name")?.classList.add("hidden"); });
    await at([-125, 20, 4e6]); await sleep(2500); s = await at([-125, 20]);
    if (s) { await tap(s); const c = await card(); /Eastern Pacific/.test(c) ? ok("R43", `${tag}: the carrier's own symbol still opens its area card`) : bad("R43", `${tag}: the carrier's symbol no longer opens its card (got "${c}")`); }
  } catch (e) { bad("R43", `${tag}: ${String(e.message).slice(0, 160)}`); }
  await ctx.close();
}

// R47 the Sea key always shows ships: it opened INTEL on whatever tab was last open with the ships layer off by default,
// so the ships list counted 808 ships while the sea stayed empty. Checked with a three-ship hourly file and no live feed.
async function seaCheck(b, url, phone) {
  const tag = phone ? "phone" : "desk";
  const ctx = await b.newContext({ ...(phone ? pw.devices["iPhone 14 Pro"] : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }), serviceWorkers: "block" });
  await ctx.addInitScript(() => { localStorage.setItem("t.seenIntro", "1"); localStorage.setItem("t.sub", JSON.stringify({ intel: "detect" })); });
  const p = await ctx.newPage();
  const rows = [[230000001, "FIXTURE ONE", 60.1, 24.9, 10, 90, 90, 70, 180, 30, 9, "HELSINKI", 0, 600, "dt", "", 0, ""], [230000002, "FIXTURE TWO", 59.4, 24.7, 0, 0, 511, 60, 90, 15, 5, "", 5, 900, "dt", "", 0, ""], [265000003, "FIXTURE THREE", 57.7, 11.9, 12, 200, 200, 80, 220, 32, 11, "", 0, 300, "dt", "", 0, ""]];
  await p.route("**/data/ships.json*", (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify({ generated_at: new Date(Date.now() - 3600e3).toISOString(), sources: {}, counts: { ships: rows.length }, cols: [], srcs: [], rows }) }));
  await p.route("**/meri.digitraffic.fi/**", (r) => r.abort());
  try {
    await p.goto(url, { timeout: 60000 }); await p.waitForFunction(() => !document.getElementById("boot") && window.viewer, null, { timeout: 90000 }); await sleep(5000);
    const k = await p.evaluate(() => { const b = document.querySelector('[data-act="group"][data-v="sea"]'); if (b) { b.click(); return true; } return false; });
    if (!k) { const d = await p.evaluate(() => { const g = [...document.querySelectorAll("[data-group]")].find((e) => /intel|sea/i.test(e.dataset.group)); g?.click(); return !!g; }); if (!d) bad("R47", `${tag}: no Sea key or INTEL tab to press`); }
    await sleep(10000);
    const r = await p.evaluate(() => { const C = window.Cesium, v = window.viewer; let shown = 0; const walk = (c) => { for (let i = 0; i < c.length; i++) { const x = c.get(i); if (x instanceof C.BillboardCollection) { for (let j = 0; j < x.length; j++) { const q = x.get(j); if (String(q.id?.live || "").startsWith("s:") && q.show) shown++; } } else if (x instanceof C.PrimitiveCollection) walk(x); } };
      walk(v.scene.primitives); const rc = v.camera.computeViewRectangle(), inView = rc ? [[60.1, 24.9], [59.4, 24.7], [57.7, 11.9]].filter(([la, lo]) => C.Rectangle.contains(rc, C.Cartographic.fromDegrees(lo, la))).length : 0; return { shown, inView }; });
    r.shown >= 3 && r.inView >= 1 ? ok("R47", `${tag}: Sea shows ${r.shown} ships, ${r.inView} of them in view`) : bad("R47", `${tag}: Sea shows ${r.shown} ships, ${r.inView} in view (expected 3 drawn and the camera on them)`);
  } catch (e) { bad("R47", `${tag}: ${String(e.message).slice(0, 160)}`); }
  await ctx.close();
}

(async () => {
  const killer = setTimeout(() => { console.log("FAIL tap-check: over the 5 minute limit"); process.exit(1); }, 5 * 60e3); killer.unref?.();
  const srv = process.env.URL ? { url: process.env.URL, close: () => {} } : await serve();
  const exe = process.env.CHROME || (fs.existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : undefined);
  const b = await pw.chromium.launch({ executablePath: exe, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  try { await tapCheck(b, srv.url, false); await tapCheck(b, srv.url, true); await seaCheck(b, srv.url, false); await seaCheck(b, srv.url, true); } catch (e) { bad("R43", `run stopped: ${String(e.message).slice(0, 200)}`); }
  await b.close(); srv.close();
  console.log(fails.length ? `\nTAP CHECK FAILED: ${fails.length}` : "\nTAP CHECK PASSED"); process.exit(fails.length ? 1 : 0);
})();
