// Runs first, before any of the app's code, so it works even when the app itself is what gets stuck.
//  - Boot guard: every visit marks itself "starting", then "running" with a heartbeat (app.js), and "ok" when the page is
//    left normally. If the last visit never left normally (it froze, or the phone killed it), this visit starts in the
//    plain view (app.js reads window.__bootBad), however long ago that was: reopening never lands on the screen that froze.
//  - Two failed visits in a row: the saved copy of the app on this phone (service worker and its files) is thrown away
//    and the page reloads once from the network. Saved maps, offline data and settings are kept.
//  - The loading screen offers the plain view after 15 s, and a full reset of the saved app after 30 s.
(function () {
  var now = Date.now(), last = null, fails = 0;
  try { last = JSON.parse(localStorage.getItem("t.boot") || "null"); } catch (e) {}
  var bad = !!last && (last.state === "starting" || last.state === "running") && now - (last.at || 0) < 7 * 864e5;
  fails = bad ? (last.fails || 0) + 1 : 0;
  window.__bootBad = bad ? { fails: fails, where: last.where || "", at: last.at || 0 } : null;
  try { localStorage.setItem("t.boot", JSON.stringify({ state: "starting", at: now, fails: fails })); } catch (e) {}
  function resetApp(then) {
    var jobs = [];
    try { if (navigator.serviceWorker) jobs.push(navigator.serviceWorker.getRegistrations().then(function (rs) { return Promise.all(rs.map(function (r) { return r.unregister(); })); })); } catch (e) {}
    try { if (window.caches) jobs.push(caches.keys().then(function (ks) { return Promise.all(ks.filter(function (k) { return /^t-v\d+|^dt-fixed/.test(k); }).map(function (k) { return caches.delete(k); })); })); } catch (e) {}
    var done = false, go = function () { if (!done) { done = true; then(); } };
    Promise.all(jobs).then(go, go); setTimeout(go, 4000); // never wait on a stuck storage call
  }
  var reset = false; try { reset = sessionStorage.getItem("t.reset") === "1"; } catch (e) {}
  if (fails >= 2 && !reset) {
    try { sessionStorage.setItem("t.reset", "1"); } catch (e) {}
    resetApp(function () { location.reload(); });
  }
  var b = document.getElementById("boot"), t = document.getElementById("bootTxt");
  if (!b) return;
  setTimeout(function () { if (!b.isConnected) return; b.className = "slow"; t.textContent = "Still loading. The connection or this device is slow right now."; }, 15000);
  setTimeout(function () { if (!b.isConnected) return; var r = document.getElementById("bootReset"); if (r) r.hidden = false; }, 30000);
  var plain = function () { try { localStorage.setItem("t.boot", JSON.stringify({ state: "starting", at: Date.now(), fails: 1 })); } catch (e) {} };
  document.getElementById("bootSafe").onclick = function () { plain(); location.reload(); };
  var rb = document.getElementById("bootReset");
  if (rb) rb.onclick = function () { plain(); try { sessionStorage.setItem("t.reset", "1"); } catch (e) {} resetApp(function () { location.reload(); }); };
})();
