/* Kiosk home: greeting, notes, grouped tiles that open monday.com forms, PIN-protected tiles, screensaver. */
(function () {
  "use strict";
  var H = window.Hub;
  var hub = null;
  var hubJson = "";
  var $ = function (id) { return document.getElementById(id); };

  function greetingWord() {
    var h = new Date().getHours();
    return h < 12 ? H.t("morning") : h < 18 ? H.t("afternoon") : H.t("evening");
  }

  function renderClock() {
    var now = new Date();
    $("date").hidden = hub.appearance.showDate === false;
    $("date").textContent = now.toLocaleDateString(H.locale(), { weekday: "long", month: "long", day: "numeric" });
    $("greeting").textContent = greetingWord() + ", " + (H.pick(hub.settings.teamWord) || "team") + ".";
    $("saver-clock").textContent = now.toLocaleTimeString(H.locale(), { hour: "numeric", minute: "2-digit" });
    $("saver-date").textContent = now.toLocaleDateString(H.locale(), { weekday: "long", month: "long", day: "numeric" });
  }

  function renderHeader() {
    var name = H.pick(hub.settings.hubName) || "Employee Hub";
    document.title = name;
    H.renderBrand($("brand"), hub);
    H.renderLangToggle($("lang-toggle"), hub.settings, render);
    var qr = $("mini-qr");
    qr.hidden = !hub.settings.showQr;
    $("mini-qr-label").textContent = H.t("openOnPhone");
    qr.setAttribute("aria-label", H.t("openOnPhone"));
  }

  function noteCard(n) {
    var title = H.pick(n.title), body = H.pick(n.body);
    return H.el("aside", { class: "note frost note--" + (n.style || "info") }, [
      H.el("span", { class: "note-icon", "aria-hidden": "true", text: H.noteIcon(n.style) }),
      H.el("div", null, [title ? H.el("strong", { text: title }) : null, body ? H.el("p", { text: body }) : null]),
    ]);
  }

  function renderNotes() {
    var current = H.currentNotes(hub.notes);
    var box = $("notes"), saver = $("saver-notes");
    box.innerHTML = ""; saver.innerHTML = "";
    box.hidden = !current.length;
    current.forEach(function (n) { box.appendChild(noteCard(n)); saver.appendChild(noteCard(n)); });
  }

  function tileHref(t) {
    if (!t.hasLink) return null;
    if (t.locked) return "#";
    return t.open === "tab" ? t.url : "/open/t/" + encodeURIComponent(t.id);
  }

  function tileEl(t) {
    var href = tileHref(t);
    var a = H.el(href ? "a" : "div", { class: "tile frost" + (href ? "" : " tile--off") + (t.locked ? " tile--locked" : ""), href: href || null,
      target: href && !t.locked && t.open === "tab" ? "_blank" : null, rel: href && t.open === "tab" ? "noopener" : null, "aria-disabled": href ? null : "true" });
    var corner = !href ? H.el("span", { class: "badge", text: H.t("comingSoon") })
      : t.locked ? H.el("span", { class: "badge", text: "🔒 " + H.t("leadsOnly") })
        : hub.appearance.showCodes !== false ? H.el("span", { class: "tile-code", text: t.code || "" }) : null;
    a.appendChild(H.el("div", { class: "tile-top" }, [H.el("span", { class: "tile-icon", "aria-hidden": "true", text: H.icon(t.icon) }), corner]));
    a.appendChild(H.el("div", null, [
      H.el("h2", null, [H.pick(t.title), H.el("span", { class: "arrow", "aria-hidden": "true", text: "↗" })]),
      H.pick(t.description) ? H.el("p", { text: H.pick(t.description) }) : null,
    ]));
    if (href) a.addEventListener("click", function (ev) {
      H.countTap(t.id);
      if (t.locked) { ev.preventDefault(); askPin(t); }
    });
    return a;
  }

  function renderTiles() {
    var box = $("tiles");
    box.innerHTML = "";
    var intro = $("intro");
    intro.textContent = H.pick(hub.settings.intro);
    intro.hidden = hub.appearance.showIntro === false || !intro.textContent;
    var visible = hub.tiles.filter(H.tileAvailable);
    if (!visible.length) {
      box.appendChild(H.el("div", { class: "empty frost" }, [H.el("strong", { text: H.t("noTools") }), H.t("noToolsAdmin")]));
      return;
    }
    var groups = [{ id: "", title: null }].concat(hub.groups || []);
    groups.forEach(function (g) {
      var tiles = visible.filter(function (t) { return (t.groupId || "") === g.id; });
      if (!tiles.length) return;
      if (g.title) box.appendChild(H.el("h2", { class: "group-title", text: H.pick(g.title) }));
      var grid = H.el("section", { class: "tiles" });
      tiles.forEach(function (t) { grid.appendChild(tileEl(t)); });
      box.appendChild(grid);
    });
  }

  // --- PIN keypad for lead-only tiles ---------------------------------------------
  var pinDialog = $("pin-dialog");
  var pinTile = null, pinValue = "";
  function askPin(t) {
    pinTile = t; pinValue = "";
    $("pin-title").textContent = H.t("leadsOnly");
    $("pin-sub").textContent = H.t("pinFor", H.pick(t.title));
    $("pin-error").hidden = true;
    $("pin-cancel").textContent = H.t("cancel");
    drawDots();
    pinDialog.showModal();
  }
  function drawDots() {
    var d = $("pin-dots");
    d.innerHTML = "";
    for (var i = 0; i < Math.max(4, pinValue.length); i++) d.appendChild(H.el("span", { class: i < pinValue.length ? "on" : "" }));
  }
  function submitPin() {
    if (pinValue.length < 4) return;
    var t = pinTile;
    fetch("/api/tiles/" + encodeURIComponent(t.id) + "/unlock", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin: pinValue }) })
      .then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j }; }); })
      .then(function (res) {
        if (res.status === 200 && res.body.token) {
          pinDialog.close();
          try { sessionStorage.setItem("hub-unlock-" + t.id, res.body.token); } catch (e) { /* ignore */ }
          location.href = "/open/t/" + encodeURIComponent(t.id) + "?k=" + encodeURIComponent(res.body.token);
          return;
        }
        pinValue = ""; drawDots();
        var err = $("pin-error");
        err.textContent = res.body.code === "locked" ? H.t("pinLocked") : H.t("pinWrong");
        err.hidden = false;
      }).catch(function () { $("pin-error").textContent = H.t("couldNotLoad"); $("pin-error").hidden = false; });
  }
  (function buildKeypad() {
    var pad = $("keypad");
    ["1", "2", "3", "4", "5", "6", "7", "8", "9", "⌫", "0", "OK"].forEach(function (k) {
      var b = H.el("button", { type: "button", class: k === "OK" ? "ok" : "", text: k, "aria-label": k === "⌫" ? "Delete" : k });
      b.addEventListener("click", function () {
        if (k === "⌫") pinValue = pinValue.slice(0, -1);
        else if (k === "OK") return submitPin();
        else if (pinValue.length < 8) pinValue += k;
        $("pin-error").hidden = true;
        drawDots();
      });
      pad.appendChild(b);
    });
    $("pin-cancel").addEventListener("click", function () { pinDialog.close(); });
    pinDialog.addEventListener("keydown", function (ev) {
      if (/^\d$/.test(ev.key) && pinValue.length < 8) { pinValue += ev.key; drawDots(); ev.preventDefault(); }
      else if (ev.key === "Backspace") { pinValue = pinValue.slice(0, -1); drawDots(); ev.preventDefault(); }
      else if (ev.key === "Enter") { ev.preventDefault(); submitPin(); }
    });
  })();

  // --- screensaver -----------------------------------------------------------------
  var saverDeadline = 0;
  function armSaver() {
    var secs = Number(hub && hub.settings.screensaverSeconds) || 0;
    saverDeadline = secs > 0 ? Date.now() + secs * 1000 : 0;
  }
  // Activity pushes the screensaver back. While it is showing, only a tap on the screensaver itself
  // closes it, and that tap is swallowed so it can't open the tile underneath.
  function resetSaver() { if ($("saver").hidden) armSaver(); }
  $("saver").addEventListener("click", function (ev) {
    ev.preventDefault(); ev.stopPropagation();
    $("saver").hidden = true;
    armSaver();
  });
  function renderSaver() {
    var brand = $("saver-brand");
    brand.innerHTML = "";
    if (hub.logo) brand.appendChild(H.el("img", { src: "/logo?v=" + encodeURIComponent(hub.logo), alt: "" }));
    else brand.appendChild(H.el("span", { class: "pill spectrum", "aria-hidden": "true" }));
    brand.appendChild(H.el("span", { text: H.pick(hub.settings.hubName) || "Employee Hub" }));
    $("saver-qr").hidden = !hub.settings.showQr;
    $("saver-qr-label").textContent = H.t("openOnPhone");
    $("saver-hint").textContent = H.t("tapToStart");
  }
  ["pointerdown", "touchstart", "keydown", "mousemove", "scroll"].forEach(function (ev) { window.addEventListener(ev, resetSaver, { passive: true }); });
  setInterval(function () {
    if (saverDeadline && Date.now() > saverDeadline && pinDialog.open === false) $("saver").hidden = false;
  }, 1000);

  function render() {
    H.resolveLang(hub.settings);
    H.applyAppearance(hub.appearance);
    renderHeader();
    renderClock();
    renderNotes();
    renderTiles();
    renderSaver();
    armSaver();
  }

  function loadHub() {
    return H.fetchJson("/api/hub").then(function (data) {
      var json = JSON.stringify(data);
      if (json === hubJson) return;
      hubJson = json;
      hub = data;
      render();
    });
  }

  loadHub().catch(function () { $("greeting").textContent = H.t("couldNotLoad"); });
  H.startHeartbeat();
  setInterval(function () { if (hub) { renderClock(); renderNotes(); renderTiles(); } }, 60000); // schedules and note dates tick over
  setInterval(function () { if (hub) renderClock(); }, 10000);
  setInterval(function () { loadHub().catch(function () {}); }, 60000); // picks up admin changes without a reload
})();
