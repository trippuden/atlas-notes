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
  // Start-up check. app.js says when it has run (__appRan), when it is waiting on the network (__bootWait, around every
  // wait before the first screen) and when the first screen is drawn (__started). Run, not waiting and not drawn means
  // its code stopped on an error, most often over something saved on this device: a setting it can no longer read, or a
  // saved copy of the app that no longer matches. Leaving such a page is not a failed visit to the guard above (a quick
  // exit is normal), so it would stop the same way on every visit. It is healed here, once per tab: every t.* setting is
  // put aside (t.safe.*, "Restore my layers" brings them back), the saved brief is dropped (it loads again), the saved
  // copy of the app is thrown away, and the page reloads into the plain view with a note. If it stops again after that,
  // a message with the error and a reset button is shown instead, so it never reloads in a loop.
  var err = "";
  var note = function (e) { if (window.__started || err) return; try { var x = e.reason !== undefined ? e.reason : e.error || e.message; err = String((x && x.message) || x || "").slice(0, 200); } catch (z) {} };
  addEventListener("error", note); addEventListener("unhandledrejection", note);
  function heal() {
    window.__healing = true; // app.js then leaves the state below as it is when the page goes
    try {
      var ks = []; for (var i = 0; i < localStorage.length; i++) ks.push(localStorage.key(i));
      ks.forEach(function (k) {
        if (!k || k.indexOf("t.") !== 0 || k.indexOf("t.safe.") === 0 || k === "t.boot" || k === "t.healed") return;
        try { var v = localStorage.getItem(k); localStorage.removeItem(k); if (v != null && k !== "t.brief" && k !== "t.brief.sig") localStorage.setItem("t.safe." + k.slice(2), v); } catch (e) {}
      });
      localStorage.setItem("t.boot", JSON.stringify({ state: "starting", at: Date.now(), fails: 0, where: "start-up" }));
    } catch (e) {}
    resetApp(function () { location.reload(); });
  }
  function stuck() {
    if (document.querySelector(".boot-fail")) return;
    var n = document.createElement("div"); n.className = "safe-note boot-fail"; n.setAttribute("role", "alert"); n.style.zIndex = "9999"; // above the loading screen
    n.appendChild(document.createTextNode("The terminal couldn't finish starting on this device, even with your settings put aside. Resetting clears the saved copy of the app and loads it again. Your saved maps and data are kept. "));
    var rb2 = document.createElement("button"); rb2.type = "button"; rb2.textContent = "Reset the app on this device";
    rb2.onclick = function () { rb2.disabled = true; resetApp(function () { location.reload(); }); };
    n.appendChild(rb2);
    var hl = document.createElement("a"); hl.href = "help.html"; hl.textContent = "Help"; hl.style.marginLeft = "12px"; n.appendChild(hl);
    if (err) { var d = document.createElement("div"); d.className = "dim"; d.textContent = "What stopped it: " + err; n.appendChild(d); }
    document.body.appendChild(n);
  }
  var dead = 0, poll = setInterval(function () {
    if (window.__started) { clearInterval(poll); return; }
    if (!window.__appRan || window.__bootWait) { dead = 0; return; }
    if (++dead < 2) return; // seen twice, 1.5 s apart
    clearInterval(poll);
    var once = false; try { once = sessionStorage.getItem("t.startHeal") === "1"; } catch (e) {}
    if (!once) { try { sessionStorage.setItem("t.startHeal", "1"); once = sessionStorage.getItem("t.startHeal") !== "1"; } catch (e) { once = true; } } // no tab memory: never reload
    if (once) stuck(); else heal();
  }, 1500);
  var b = document.getElementById("boot"), t = document.getElementById("bootTxt");
  if (!b) return;
  setTimeout(function () { if (!b.isConnected) return; b.className = "slow"; t.textContent = "Still loading. The connection or this device is slow right now."; }, 15000);
  setTimeout(function () { if (!b.isConnected) return; var r = document.getElementById("bootReset"); if (r) r.hidden = false; }, 30000);
  var plain = function () { try { localStorage.setItem("t.boot", JSON.stringify({ state: "starting", at: Date.now(), fails: 1 })); } catch (e) {} };
  document.getElementById("bootSafe").onclick = function () { plain(); location.reload(); };
  var rb = document.getElementById("bootReset");
  if (rb) rb.onclick = function () { plain(); try { sessionStorage.setItem("t.reset", "1"); } catch (e) {} resetApp(function () { location.reload(); }); };
})();
