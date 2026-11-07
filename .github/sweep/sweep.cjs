// Full sweep of the site as a person uses it: home, every layer switch (on, look, tap one thing, off), every data tab,
// the place file, search, live TV, survival, watch mode, the menu. Records every network request by host (what loaded,
// what failed and why), every page error, what each layer drew and the text of every card it opened, with a picture
// of each step. Usage: node sweep.cjs <chromium|webkit> <url|dir> <outdir> <desk|phone>
const fs = require("fs"), path = require("path"), http = require("http"), pw = require("playwright");
const [, , ENGINE = "chromium", TARGET, OUT = "out", MODE = "desk"] = process.argv;
fs.mkdirSync(OUT, { recursive: true });
const PHONE = MODE === "phone", T0 = Date.now(), Q = process.env.QUICK ? 2 : 999;
const R = { engine: ENGINE, mode: MODE, target: TARGET, started: new Date().toISOString(), scenes: [], net: {}, errors: [], layers: [], cards: [], data: [], dossier: [], search: [], misc: {} };
const say = (...a) => { const l = `${((Date.now() - T0) / 1000).toFixed(0).padStart(5)}s ${a.join(" ")}`; console.log(l); fs.appendFileSync(path.join(OUT, "log.txt"), l + "\n"); };
const save = () => fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(R, null, 1));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".woff2": "font/woff2", ".wasm": "application/wasm", ".glb": "model/gltf-binary", ".webmanifest": "application/manifest+json" };
const serve = (dir) => new Promise((ok) => { const s = http.createServer((q, r) => { let p = decodeURIComponent(new URL(q.url, "http://x").pathname); if (p.endsWith("/")) p += "index.html";
  fs.readFile(path.join(dir, path.normalize(p).replace(/^(\.\.[/\\])+/, "")), (e, d) => { if (e) { r.writeHead(404); r.end(); return; } r.writeHead(200, { "content-type": MIME[path.extname(p)] || "application/octet-stream" }); r.end(d); }); });
  s.listen(0, "127.0.0.1", () => ok(`http://127.0.0.1:${s.address().port}/`)); });
let scene = "load", sceneNet = [], sceneErr = [];
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "x";
setTimeout(() => { say("SWEEP OUT OF TIME"); save(); process.exit(0); }, 75 * 60e3);

(async () => {
  const url = /^https?:/.test(TARGET) ? TARGET : await serve(path.resolve(TARGET));
  const dev = PHONE ? { ...pw.devices["iPhone 14 Pro"], deviceScaleFactor: 1 } : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 };
  if (ENGINE === "webkit" && PHONE) delete dev.defaultBrowserType;
  const sysChrome = !process.env.CI && fs.existsSync("/usr/bin/google-chrome") ? { executablePath: "/usr/bin/google-chrome" } : {};
  const b = await pw[ENGINE].launch(ENGINE === "chromium" ? { ...sysChrome, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] } : {});
  const ctx = await b.newContext({ ...dev, serviceWorkers: "block", geolocation: { latitude: 41.4993, longitude: -81.6944 }, permissions: ["geolocation"], timezoneId: "America/New_York", locale: "en-US" });
  await ctx.addInitScript(() => { try { localStorage.setItem("t.seenIntro", "1"); } catch {} });
  // the page's own debug handle (viewer, showDetail) is only switched on for localhost; open it here so the sweep can count what is drawn
  await ctx.route(/\/app\.js(\?|$)/, async (rt) => { try { const r = await rt.fetch(); let t = await r.text();
    t = t.replace(/\(location\.hostname==="localhost"\|\|location\.hostname==="127\.0\.0\.1"\)&&\(window\.viewer=/, "(true)&&(window.viewer=").replace(/if \(location\.hostname === "localhost" \|\| location\.hostname === "127\.0\.0\.1"\) \{ window\.viewer = /, "if (true) { window.viewer = ");
    await rt.fulfill({ response: r, body: t, headers: { ...r.headers(), "content-type": "text/javascript" } }); } catch (e) { say("route app.js failed", e.message); await rt.continue(); } });
  const p = await ctx.newPage();
  const net = (u, st, why, type, ms) => { let h; try { h = new URL(u).host; } catch { return; } if (!h || /^127\.|^localhost/.test(h) && !/data\//.test(u)) h = h || "?";
    const n = (R.net[h] ||= { n: 0, ok: 0, bad: 0, fail: 0, samples: [] }); n.n++;
    if (why) { n.fail++; if (n.samples.length < 6) n.samples.push(`${scene} | ${u.slice(0, 160)} | FAILED ${why}`); sceneNet.push(`${h} FAILED ${why}`); }
    else if (st >= 400) { n.bad++; if (n.samples.length < 6) n.samples.push(`${scene} | ${u.slice(0, 160)} | HTTP ${st}`); sceneNet.push(`${h} HTTP ${st}`); }
    else n.ok++; };
  const t0q = new Map();
  p.on("request", (q) => t0q.set(q, Date.now()));
  p.on("requestfinished", async (q) => { let st = 0; try { st = (await q.response())?.status() || 0; } catch {} net(q.url(), st, null, q.resourceType(), Date.now() - (t0q.get(q) || Date.now())); });
  p.on("requestfailed", (q) => { const why = q.failure()?.errorText || "failed"; if (/ERR_ABORTED|cancelled|Load request cancelled/i.test(why)) return; net(q.url(), 0, why, q.resourceType(), 0); });
  p.on("pageerror", (e) => { const m = `PAGEERROR @${scene}: ${e.message} ${(e.stack || "").split("\n").slice(1, 3).join(" ").slice(0, 200)}`; R.errors.push(m); sceneErr.push(m); });
  p.on("console", (m) => { if (!["error", "warning"].includes(m.type())) return; const t = m.text(); if (/Failed to load resource|net::|CORS|Access-Control/i.test(t)) return; const s = `${m.type().toUpperCase()} @${scene}: ${t.slice(0, 260)}`; if (R.errors.length < 400) R.errors.push(s); sceneErr.push(s); });
  p.on("crash", () => { R.errors.push(`CRASH @${scene}`); say("PAGE CRASHED at", scene); });
  const ev = (fn, arg, ms = 10000) => Promise.race([p.evaluate(fn, arg), sleep(ms).then(() => { throw new Error("page did not answer in " + ms + " ms"); })]);
  const shot = async (name) => { try { await p.screenshot({ path: path.join(OUT, slug(name) + ".jpg"), type: "jpeg", quality: 50, timeout: 20000 }); } catch (e) { say("shot failed", name, e.message.slice(0, 80)); } return slug(name) + ".jpg"; };
  const begin = (s) => { scene = s; sceneNet = []; sceneErr = []; };
  const end = (extra = {}) => { const o = { scene, at: Math.round((Date.now() - T0) / 1000), netFail: [...new Set(sceneNet)].slice(0, 12), errors: sceneErr.slice(0, 8), ...extra }; R.scenes.push(o); save(); return o; };
  // what is drawn: shown billboards, points, labels, polylines and entities (counted through the page's own viewer)
  const counts = () => ev(() => { const v = window.viewer; if (!v) return { noViewer: true };
    const c = { bb: 0, pt: 0, lb: 0, pl: 0, ent: 0, prim: 0, ds: 0 }; const seen = new Set();
    const walk = (o, d) => { if (!o || d > 6 || seen.has(o)) return; seen.add(o); if (o.show === false) return; c.prim++;
      const C = Cesium, len = o.length ?? 0, each = (k) => { for (let i = 0; i < len; i++) if (o.get(i).show) c[k]++; };
      if (o instanceof C.BillboardCollection) each("bb"); else if (o instanceof C.PointPrimitiveCollection) each("pt"); else if (o instanceof C.LabelCollection) each("lb");
      else if (o instanceof C.PolylineCollection) each("pl"); else if (o._primitives) for (const q of o._primitives) walk(q, d + 1); };
    walk(v.scene.primitives, 0);
    c.ent = v.entities.values.filter((e) => e.isShowing !== false && e.show !== false).length;
    for (let i = 0; i < v.dataSources.length; i++) { const d = v.dataSources.get(i); if (d.show) c.ds += d.entities.values.filter((e) => e.show !== false).length; }
    return c; });
  // things a person could tap: shown billboards and points with a pick id, on the side of the Earth facing the camera, on screen and clear of panels
  const pickables = (n = 3) => ev((n) => { const v = window.viewer; if (!v) return []; const out = [], C = Cesium, cam = v.camera.positionWC, seen = new Set();
    const occ = new C.EllipsoidalOccluder(C.Ellipsoid.WGS84, cam); const W = v.canvas.clientWidth, H = v.canvas.clientHeight;
    const blocked = (x, y) => { const e = document.elementFromPoint(x, y); return !e || !(e.tagName === "CANVAS" || e.closest?.(".cesium-widget")); };
    const consider = (o) => { if (!o.show || o.id == null) return; const pos = o.position; if (!pos) return; if (C.Cartesian3.magnitude(pos) < 6.4e6 && !occ.isPointVisible(pos)) return;
      const s = C.SceneTransforms.worldToWindowCoordinates ? C.SceneTransforms.worldToWindowCoordinates(v.scene, pos) : C.SceneTransforms.wgs84ToWindowCoordinates(v.scene, pos); if (!s) return;
      const x = Math.round(s.x), y = Math.round(s.y); if (x < 30 || y < 30 || x > W - 30 || y > H - 30 || blocked(x, y)) return;
      const k = `${Math.round(x / 40)}:${Math.round(y / 40)}`; if (seen.has(k)) return; seen.add(k); out.push({ x, y, id: String(typeof o.id === "object" ? (o.id.id || o.id.name || o.id.kind || JSON.stringify(Object.keys(o.id)).slice(0, 40)) : o.id).slice(0, 60) }); };
    const walk = (o, d) => { if (!o || d > 6 || o.show === false || out.length > 400) return; const len = o.length ?? 0;
      if (o instanceof C.BillboardCollection || o instanceof C.PointPrimitiveCollection) { const step = Math.max(1, Math.floor(len / 300)); for (let i = 0; i < len && out.length < 400; i += step) consider(o.get(i)); }
      else if (o._primitives) for (const q of o._primitives) walk(q, d + 1); };
    walk(v.scene.primitives, 0);
    const now = v.clock.currentTime; const ents = [...v.entities.values]; for (let i = 0; i < v.dataSources.length; i++) { const ds = v.dataSources.get(i); if (ds.show) ents.push(...ds.entities.values); }
    for (const e of ents) { if (out.length > 400) break; if (e.show === false || !(e.billboard || e.point)) continue; const pos = e.position?.getValue?.(now); if (pos) consider({ show: true, id: e.id, position: pos }); }
    // spread the picks: one near the middle of the screen, the rest far apart
    out.sort((a, b) => Math.hypot(a.x - W / 2, a.y - H / 2) - Math.hypot(b.x - W / 2, b.y - H / 2));
    const pick = []; for (const o of out) { if (pick.every((q) => Math.hypot(q.x - o.x, q.y - o.y) > 120)) pick.push(o); if (pick.length >= n) break; } return pick; }, n);
  // panels on screen: any fixed or absolute box bigger than a thumb, with its text
  const panels = () => ev(() => [...document.querySelectorAll("body *")].filter((e) => { const cs = getComputedStyle(e); if (!/fixed|absolute/.test(cs.position) || cs.visibility === "hidden" || cs.display === "none" || +cs.opacity < 0.05) return false;
    const r = e.getBoundingClientRect(); if (r.width * r.height > innerWidth * innerHeight * 0.7) return false; return r.width * r.height > 26000 && r.width > 120 && r.height > 90 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth && (e.innerText || "").trim().length > 20; })
    .filter((e) => !e.matches(".hud-ops .st, .hud-ops .st *, .hud-ops .board, .hud-ops .board *, #ticker, #ticker *, .hud-ops .keys, .hud-ops .keys *, .lk-strip, .lk-strip *"))
    .map((e) => ({ id: e.id || "", cls: String(e.className || "").slice(0, 60), area: Math.round(e.getBoundingClientRect().width * e.getBoundingClientRect().height), text: (e.innerText || "").trim().replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").slice(0, 3500) })));
  const newPanelText = (before, after) => { const bt = new Map(before.map((x) => [x.id + "|" + x.cls, x.text]));
    const born = after.filter((x) => !bt.has(x.id + "|" + x.cls)); const changed = after.filter((x) => bt.has(x.id + "|" + x.cls) && bt.get(x.id + "|" + x.cls) !== x.text);
    const pool = born.length ? born : changed; pool.sort((a, b) => b.area - a.area); return pool.length ? pool[0] : null; };
  const tap = async (x, y) => { if (PHONE) await p.touchscreen.tap(x, y); else await p.mouse.click(x, y); };
  const click = async (sel, i = 0) => { const els = await p.$$(sel); const e = els[i]; if (!e) return false; try { await e.scrollIntoViewIfNeeded({ timeout: 3000 }); await e.click({ timeout: 5000 }); return true; } catch { try { await e.evaluate((x) => x.click()); return true; } catch { return false; } } };
  const closeAll = async () => { for (let i = 0; i < 3; i++) { await p.keyboard.press("Escape").catch(() => {}); await sleep(250); }
    await ev(() => { for (const s of ["#detailClose", ".hud-ops .dos [data-act=close]", ".hud-ops .sheet [data-act=close]", "#fpanel .fp-x", "#hudDataClose"]) { const e = document.querySelector(s); if (e && e.offsetParent) e.click(); } }).catch(() => {}); await sleep(400); };

  // ---------- 1. open the site ----------
  begin("open"); say("open", url, ENGINE, MODE);
  try { await p.goto(url, { waitUntil: "commit", timeout: 90000 }); } catch (e) { say("goto failed", e.message); }
  const up = await p.waitForFunction(() => !document.getElementById("boot") && document.querySelector(".cesium-widget canvas") && window.viewer, null, { timeout: 150000 }).then(() => true).catch(() => false);
  R.misc.bootSeconds = Math.round((Date.now() - T0) / 1000); say("app up:", up, "after", R.misc.bootSeconds, "s");
  await sleep(15000);
  await shot("01-home");
  R.misc.home = await ev(() => ({ title: document.title, status: (document.querySelector(".hud-ops .st") || document.querySelector("#updated"))?.innerText?.replace(/\s+/g, " ").slice(0, 400),
    tiles: [...document.querySelectorAll(".hud-ops .tile")].slice(0, 14).map((t) => t.innerText.replace(/\s+/g, " ").slice(0, 120)), so: document.querySelector(".hud-ops .bl")?.innerText?.replace(/\s+/g, " ").slice(0, 400),
    ticker: document.querySelector("#ticker")?.innerText?.replace(/\s+/g, " ").slice(0, 900), flash: document.querySelector(".hud-ops .flash")?.innerText?.replace(/\s+/g, " ").slice(0, 300),
    tags: [...document.querySelectorAll(".gx-tag")].map((t) => t.innerText.replace(/\s+/g, " ")).slice(0, 20), memory: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null })).catch((e) => ({ err: e.message }));
  R.misc.homeCounts = await counts().catch((e) => ({ err: e.message }));
  R.misc.homePanels = (await panels().catch(() => [])).map((x) => `${x.id || x.cls}: ${x.text.slice(0, 300)}`);
  end({ counts: R.misc.homeCounts }); say("home", JSON.stringify(R.misc.homeCounts));

  // ---------- 2. layer groups (desk keys) ----------
  const groups = await ev(() => [...document.querySelectorAll('.hud-ops [data-act="group"]')].map((e, i) => ({ i, v: e.dataset.v, t: e.innerText.trim(), on: e.classList.contains("on") }))).catch(() => []);
  R.misc.groups = groups;
  for (const g of groups.slice(0, Q)) {
    begin(`group ${g.t}`); await closeAll(); await click('.hud-ops [data-act="group"]', g.i); await sleep(9000);
    const c = await counts().catch((e) => ({ err: e.message })); const f = await shot(`02-group-${g.t}`);
    const picks = await pickables(4).catch(() => []); const cards = [];
    for (const k of picks) { const b0 = await panels().catch(() => []); await tap(k.x, k.y); await sleep(2600); const np = newPanelText(b0, await panels().catch(() => []));
      const cf = await shot(`02-group-${g.t}-card-${cards.length}`); cards.push({ id: k.id, panel: np ? (np.id || np.cls) : null, text: np ? np.text : "(nothing opened)", shot: cf }); await closeAll(); }
    R.cards.push(...cards.map((x) => ({ from: `group ${g.t}`, ...x })));
    end({ counts: c, shot: f, cards: cards.length }); say("group", g.t, JSON.stringify(c), "cards", cards.map((x) => x.panel || "-").join(","));
    // put the group back as it was
    await click('.hud-ops [data-act="group"]', g.i); await sleep(1200);
  }

  // ---------- 3. every switch in Filters: on, look, tap one thing, off ----------
  const openFilters = async () => { const vis = await ev(() => { const f = document.getElementById("fpanel"); return !!f && !f.classList.contains("hidden") && f.offsetParent !== null; }).catch(() => false);
    if (!vis) { (await click('.hud-ops [data-act="filters"]')) || (await click("#filterBtn")); await sleep(1500); } };
  await closeAll(); await openFilters(); await shot("03-filters");
  const sects = await ev(() => [...document.querySelectorAll("#fpanel .fp-gh[data-sect]")].map((h) => ({ s: h.dataset.sect, t: h.innerText.replace(/\s+/g, " ").trim().slice(0, 60) }))).catch(() => []);
  const rows = [], seenRow = new Set();
  for (const sc of sects) {
    await ev((s) => { const h = document.querySelector(`#fpanel .fp-gh[data-sect="${s}"]`); if (h && h.getAttribute("aria-expanded") !== "true") h.click(); }, sc.s).catch(() => {}); await sleep(600);
    const rs = await ev(() => [...document.querySelectorAll("#fpanel [data-row]")].map((r) => ({ k: r.dataset.row, label: (r.querySelector(".fp-name, .fp-t, b, strong")?.innerText || r.innerText).replace(/\s+/g, " ").trim().slice(0, 80), meta: r.querySelector(".fp-meta")?.innerText?.replace(/\s+/g, " ").trim().slice(0, 160) || "", tg: !!r.querySelector("[data-tg]"), on: r.querySelector("[data-tg]")?.getAttribute("aria-pressed") }))).catch(() => []);
    for (const r of rs) if (!seenRow.has(r.k)) { seenRow.add(r.k); rows.push({ ...r, sect: sc.s, sectName: sc.t }); }
  }
  R.misc.filterRows = rows.map((r) => `${r.sectName} | ${r.k} | ${r.label} | ${r.meta} | ${r.tg ? (r.on === "true" ? "ON" : "off") : "no switch"}`);
  say("filters:", sects.length, "sections,", rows.length, "rows");
  for (const r of rows.filter((x) => x.tg).slice(0, Q)) {
    begin(`layer ${r.k}`);
    try {
      await openFilters();
      await ev((s) => { const h = document.querySelector(`#fpanel .fp-gh[data-sect="${s}"]`); if (h && h.getAttribute("aria-expanded") !== "true") h.click(); }, r.sect).catch(() => {}); await sleep(350);
      const before = await counts().catch(() => ({}));
      const flipped = await ev((k) => { const e = document.querySelector(`#fpanel [data-row="${CSS.escape(k)}"] [data-tg]`); if (!e) return null; e.click(); return e.getAttribute("aria-pressed"); }, r.k).catch(() => null);
      await sleep(900);
      const meta = await ev((k) => document.querySelector(`#fpanel [data-row="${CSS.escape(k)}"] .fp-meta`)?.innerText?.replace(/\s+/g, " ").trim().slice(0, 200) || "", r.k).catch(() => "");
      await closeAll(); await sleep(4200);
      const after = await counts().catch(() => ({}));
      const f = await shot(`03-layer-${r.k}`);
      const diff = {}; for (const k of ["bb", "pt", "lb", "pl", "ent", "ds", "prim"]) diff[k] = (after[k] || 0) - (before[k] || 0);
      let card = null;
      if (r.on !== "true") { const picks = await pickables(6).catch(() => []);
        for (const k of picks.slice(0, 2)) { const b0 = await panels().catch(() => []); await tap(k.x, k.y); await sleep(2600); const np = newPanelText(b0, await panels().catch(() => []));
          if (np) { const cf = await shot(`03-layer-${r.k}-card`); card = { id: k.id, panel: np.id || np.cls, text: np.text, shot: cf }; await closeAll(); break; } await closeAll(); } }
      if (card) R.cards.push({ from: `layer ${r.k}`, ...card });
      R.layers.push({ k: r.k, label: r.label, sect: r.sectName, wasOn: r.on === "true", nowOn: flipped, meta, drawn: diff, card: card ? card.text.slice(0, 1500) : null, shot: f, netFail: [...new Set(sceneNet)].slice(0, 10), errors: sceneErr.slice(0, 5) });
      say("layer", r.k, r.on === "true" ? "(was on, now off)" : "", "drew", JSON.stringify(diff), card ? "card: " + card.text.slice(0, 60).replace(/\n/g, " / ") : "no card", sceneNet.length ? "netfail " + [...new Set(sceneNet)].slice(0, 3).join("; ") : "");
      // back as it was
      await openFilters(); await ev((s) => { const h = document.querySelector(`#fpanel .fp-gh[data-sect="${s}"]`); if (h && h.getAttribute("aria-expanded") !== "true") h.click(); }, r.sect).catch(() => {}); await sleep(300);
      await ev((k) => document.querySelector(`#fpanel [data-row="${CSS.escape(k)}"] [data-tg]`)?.click(), r.k).catch(() => {}); await sleep(600);
    } catch (e) { say("layer", r.k, "sweep error", e.message.slice(0, 100)); }
    end();
  }
  await closeAll();

  // ---------- 4. Data panel: every group and every sub-tab ----------
  begin("data"); (await click('.hud-ops [data-act="data"]')) || (await click("#refreshBtn")); await sleep(2500); await shot("04-data");
  const dgroups = await ev(() => [...document.querySelectorAll("#rightPanel nav.groups [data-group]")].map((e) => ({ g: e.dataset.group, t: e.innerText.replace(/[^A-Za-z ]/g, "").trim() }))).catch(() => []);
  say("data groups:", dgroups.map((g) => g.t).join(", ")); end({ groups: dgroups.length });
  for (const g of dgroups.slice(0, Q < 9 ? 1 : 99)) {
    await ev((g) => document.querySelector(`#rightPanel nav.groups [data-group="${g}"]`)?.click(), g.g).catch(() => {}); await sleep(1500);
    const subs = await ev(() => [...document.querySelectorAll("#subtabs button")].map((e, i) => ({ i, t: e.innerText.replace(/\s+/g, " ").trim().slice(0, 40), tab: e.dataset.tab || "" }))).catch(() => []);
    for (const t of (subs.length ? subs : [{ i: -1, t: "(no sub-tabs)" }]).slice(0, Q < 9 ? 2 : 99)) { begin(`data ${g.t} > ${t.t}`);
      try { if (t.i >= 0) await ev((i) => document.querySelectorAll("#subtabs button")[i]?.click(), t.i); await sleep(2200);
        const got = await ev(() => { const on = [...document.querySelectorAll("#rightPanel .tab.on")].filter((e) => e.offsetParent); const e = on.sort((a, b) => b.innerText.length - a.innerText.length)[0];
          return { items: e ? e.querySelectorAll("li").length : 0, text: (e?.innerText || "(empty)").replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").slice(0, 2500) }; }).catch((e) => ({ items: 0, text: "ERR " + e.message }));
        const f = await shot(`04-data-${g.t}-${t.t}`); R.data.push({ group: g.t, tab: t.t, items: got.items, text: got.text, shot: f, netFail: [...new Set(sceneNet)].slice(0, 8), errors: sceneErr.slice(0, 4) });
        say("data", g.t, ">", t.t, got.items, "items:", got.text.slice(0, 90).replace(/\n/g, " / ")); } catch (e) { say("data", g.t, t.t, "error", e.message.slice(0, 80)); }
      end(); }
  }
  await closeAll();

  // ---------- 5. Place file: the first country tile, every tab ----------
  begin("dossier"); await closeAll();
  await click(".hud-ops .tile[data-act=sel]"); await sleep(1500);
  if (PHONE) { await click(".hud-ops .tile.sel[data-act=sel]"); await sleep(1500); }
  await p.waitForFunction(() => { const d = document.querySelector(".hud-ops .dos"); return d && d.offsetParent && d.getBoundingClientRect().height > 100; }, null, { timeout: 6000 }).catch(() => say("dossier did not open"));
  await sleep(800);
  const dtabs = await ev(() => [...document.querySelectorAll('.hud-ops [data-act="tab"]')].filter((e) => e.offsetParent).map((e) => e.dataset.v)).catch(() => []);
  say("dossier tabs:", dtabs.join(","));
  for (const t of dtabs.length ? dtabs : ["(none)"]) {
    if (t !== "(none)") await ev((t) => document.querySelector(`.hud-ops [data-act="tab"][data-v="${t}"]`)?.click(), t).catch(() => {}); await sleep(1600);
    const ps = await panels().catch(() => []); ps.sort((a, b) => b.area - a.area);
    const dos = ps.find((x) => /dos|dossier|sheet/.test(x.cls)) || ps[0];
    const f = await shot(`05-dossier-${t}`); R.dossier.push({ tab: t, text: dos ? dos.text : "(no panel)", shot: f });
  }
  end(); await closeAll();
  // global (US readiness) tile and the first watch tile
  for (const [nm, sel] of [["readiness", '.hud-ops [data-act="global"]'], ["watch", '.hud-ops .tile.w[data-act="sel"]']]) {
    begin(`tile ${nm}`); const b0 = await panels().catch(() => []); await click(sel); await sleep(2200); if (PHONE && nm === "watch") { await click(".hud-ops .tile.sel[data-act=sel]"); await sleep(1500); }
    const np = newPanelText(b0, await panels().catch(() => [])); const f = await shot(`05-tile-${nm}`); R.cards.push({ from: `tile ${nm}`, panel: np ? (np.id || np.cls) : null, text: np ? np.text : "(nothing opened)", shot: f }); end(); await closeAll(); }

  // ---------- 6. Search ----------
  for (const q of ["Kyiv", "ISS", "Starlink", "Tokyo", "earthquake", "Flock", "Gaza", "weather", "radio", "Cleveland"].slice(0, Q)) {
    begin(`search ${q}`);
    try { await closeAll(); (await click('.hud-ops [data-act="search"]')) || (await click("#searchBtn")); await sleep(900);
      const inp = await p.$("input[type=search]:visible, #search input:visible, input[placeholder]:visible"); if (!inp) { say("search: no box"); end(); continue; }
      await inp.fill(""); await inp.type(q, { delay: 40 }); await sleep(1800);
      const res = await ev(() => [...document.querySelectorAll(".sx-list li")].map((li) => li.innerText.replace(/\s+/g, " ").trim()).join("\n").slice(0, 1500)).catch(() => "");
      const f = await shot(`06-search-${q}`); const b0 = await panels().catch(() => []);
      const hit = await ev(() => { const it = document.querySelector('.sx-list li[data-i="0"]'); if (it) { it.click(); return it.innerText.slice(0, 60); } return null; }).catch(() => null);
      if (!hit) await p.keyboard.press("Enter").catch(() => {}); await sleep(3500);
      const np = newPanelText(b0, await panels().catch(() => [])); const f2 = await shot(`06-search-${q}-open`);
      R.search.push({ q, results: res, opened: np ? np.text.slice(0, 1500) : "(nothing opened)", shot: f, shot2: f2 }); say("search", q, "->", res.slice(0, 100).replace(/\n/g, " / "), "| opened:", np ? np.text.slice(0, 60).replace(/\n/g, " / ") : "nothing");
    } catch (e) { say("search", q, "error", e.message.slice(0, 80)); }
    end(); }
  await closeAll();

  // ---------- 7. Live TV, survival, watch mode, menu ----------
  begin("tv"); await closeAll(); (await click('.hud-ops [data-act="tv"]')) || (await click("#stationsBtn")); await sleep(4000);
  R.misc.tv = (await panels().catch(() => [])).sort((a, b) => b.area - a.area)[0]?.text?.slice(0, 2500) || "(nothing)"; await shot("07-tv");
  const playBtn = await p.$("#stations button:visible, #stations [data-play]:visible, #stations li:visible"); if (playBtn) { await playBtn.click().catch(() => {}); await sleep(12000); await shot("07-tv-playing");
    R.misc.tvMedia = await ev(() => ({ video: [...document.querySelectorAll("video")].map((v) => ({ rs: v.readyState, t: v.currentTime, err: v.error?.code || null, src: (v.currentSrc || "").slice(0, 80) })), iframes: [...document.querySelectorAll("iframe")].map((f) => f.src.slice(0, 80)) })).catch(() => null); }
  end(); await closeAll();
  begin("survival"); (await click('.hud-ops [data-act="survival"]')); await sleep(3500); R.misc.survival = (await panels().catch(() => [])).sort((a, b) => b.area - a.area)[0]?.text?.slice(0, 1500) || "(nothing)"; await shot("07-survival"); end(); await closeAll();
  if (PHONE) { begin("menu"); await click('.hud-ops [data-act="sheet"]'); await sleep(1800); await shot("07-menu");
    const items = await ev(() => [...document.querySelectorAll(".hud-ops .sheet button, .hud-ops .sheet a")].filter((e) => e.offsetParent).map((e) => e.innerText.replace(/\s+/g, " ").trim()).filter(Boolean)).catch(() => []);
    R.misc.menu = items; end(); say("menu items:", items.join(" | "));
    for (const it of items.slice(0, 14)) { if (/watch mode|reset|reload|open a saved/i.test(it)) continue; begin(`menu ${it}`); await closeAll(); await click('.hud-ops [data-act="sheet"]'); await sleep(1200);
      await ev((t) => [...document.querySelectorAll(".hud-ops .sheet button, .hud-ops .sheet a")].find((e) => e.offsetParent && e.innerText.replace(/\s+/g, " ").trim() === t)?.click(), it).catch(() => {}); await sleep(3500);
      const top = (await panels().catch(() => [])).sort((a, b) => b.area - a.area)[0]; R.cards.push({ from: `menu ${it}`, panel: top ? (top.id || top.cls) : null, text: top ? top.text : "(nothing)", shot: await shot(`07-menu-${it}`) }); end(); }
    await closeAll(); }
  begin("watch mode"); await closeAll(); (await click("[data-watchmode]")) || (await ev(() => [...document.querySelectorAll("button")].find((b) => /watch mode/i.test(b.innerText))?.click()).catch(() => {})); await sleep(Q < 9 ? 5000 : 25000); await shot("07-watch"); R.misc.watch = (await panels().catch(() => [])).map((x) => x.text.slice(0, 300)).slice(0, 4); end(); await closeAll();

  // ---------- 8. close-up: zoom to a city and look at the ground ----------
  begin("closeup"); await closeAll();
  await ev(() => { const C = Cesium; window.viewer.camera.flyTo({ destination: C.Cartesian3.fromDegrees(-73.9857, 40.7484, 1800), orientation: { heading: 0, pitch: C.Math.toRadians(-35), roll: 0 }, duration: 0 }); }).catch(() => {});
  await sleep(14000); await shot("08-closeup-nyc"); R.misc.closeupCounts = await counts().catch(() => null);
  await ev(() => { const C = Cesium; window.viewer.camera.flyTo({ destination: C.Cartesian3.fromDegrees(30.5234, 50.4501, 250000), duration: 0 }); }).catch(() => {}); await sleep(10000); await shot("08-kyiv-250km");
  end();

  R.misc.endMemory = await ev(() => performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null).catch(() => null);
  R.finished = new Date().toISOString(); save();
  const hosts = Object.entries(R.net).sort((a, b) => (b[1].fail + b[1].bad) - (a[1].fail + a[1].bad));
  say("NETWORK by host (requests ok/bad/failed):"); for (const [h, n] of hosts) say(`  ${h} ${n.n} ok ${n.ok} bad ${n.bad} failed ${n.fail}${n.samples.length ? "  e.g. " + n.samples[0] : ""}`);
  say("ERRORS:", R.errors.length); for (const e of R.errors.slice(0, 40)) say("  " + e);
  say("SWEEP DONE"); await b.close(); process.exit(0);
})().catch((e) => { say("SWEEP CRASHED", e.stack); save(); process.exit(0); });
