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

  /** The greeting line, with the greeting word after it, before it, or left out. */
  function greetingText(style) {
    var g = greetingWord();
    var word = (H.pick(hub.settings.teamWord) || "").trim();
    if (!word || style === "noword") return g + ".";
    if (style === "before") return word.charAt(0).toUpperCase() + word.slice(1) + ", " + g.charAt(0).toLowerCase() + g.slice(1) + ".";
    return g + ", " + word + ".";
  }

  var lastClock = "";
  function renderTopClock() {
    var a = hub.appearance, box = $("top-clock");
    if (a.clock === "off") { box.hidden = true; return; }
    var parts = H.clockParts(new Date(), a.clock, a.clockAmPm);
    var key = parts.hm + parts.ampm;
    box.hidden = false;
    if (key === lastClock) return;
    lastClock = key;
    box.textContent = parts.hm;
    if (parts.ampm) box.appendChild(H.el("small", { text: parts.ampm }));
    box.setAttribute("aria-label", parts.hm + (parts.ampm ? " " + parts.ampm : ""));
  }

  function renderClock() {
    var now = new Date(), a = hub.appearance;
    $("date").hidden = a.showDate === false;
    $("date").textContent = now.toLocaleDateString(H.locale(), { weekday: "long", month: "long", day: "numeric" });
    var h1 = $("greeting");
    h1.hidden = a.greetingStyle === "hidden";
    h1.textContent = greetingText(a.greetingStyle);
    renderTopClock();
    // The screensaver follows the top bar's 12/24-hour choice and always shows AM/PM in 12-hour mode.
    var sp = H.clockParts(now, a.clock === "24h" ? "24h" : "12h", true);
    $("saver-clock").textContent = sp.hm.replace(/^0(?=\d:)/, "") + (sp.ampm ? " " + sp.ampm : "");
    $("saver-date").textContent = now.toLocaleDateString(H.locale(), { weekday: "long", month: "long", day: "numeric" });
  }

  /** Put the hub name, greeting and intro line where the admin chose. */
  function renderLayout() {
    var a = hub.appearance, name = H.pick(hub.settings.hubName) || "Employee Hub";
    // Hub name: in the top bar, as a heading above the greeting (big when there's no greeting), or hidden.
    var brandName = $("brand").querySelector(".brand-name");
    if (brandName) brandName.hidden = a.hubNamePosition !== "topbar";
    var heroName = $("hero-name"), date = $("date");
    var nameIsHeading = a.hubNamePosition === "headline" && a.greetingStyle === "hidden";
    heroName.hidden = a.hubNamePosition !== "headline";
    heroName.textContent = name;
    heroName.className = "hero-name" + (nameIsHeading ? " hero-name--big" : "");
    // The date sits above the main heading: above the hub name when that is the heading, else under it.
    if (nameIsHeading) $("greeting-block").insertBefore(date, heroName);
    else $("greeting-block").insertBefore(date, $("greeting").previousElementSibling === $("intro") ? $("intro") : $("greeting"));
    // Intro line: below or above the greeting, under the tiles, or hidden.
    var intro = $("intro"), block = $("greeting-block"), bottom = $("intro-bottom-slot");
    intro.textContent = H.pick(hub.settings.intro);
    intro.hidden = a.introPosition === "hidden" || !intro.textContent;
    intro.className = "intro" + (a.introPosition === "above" ? " intro--above" : "");
    if (a.introPosition === "bottom") bottom.appendChild(intro);
    else if (a.introPosition === "above") block.insertBefore(intro, $("greeting"));
    else block.appendChild(intro);
    // Alignment of the whole header block.
    var center = a.headerAlign === "center";
    $("hero").classList.toggle("hero--center", center);
    bottom.classList.toggle("center", center);
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
    if (t.open === "tab" || t.fullPage) return t.url; // fullPage: the form can't be shown inside the hub
    return "/open/t/" + encodeURIComponent(t.id);
  }

  function tileEl(t, number) {
    var href = tileHref(t);
    // Inside a monday.com frame, a form that can't be framed must open in a new tab: replacing our frame wouldn't help.
    var newTab = href && !t.locked && (t.open === "tab" || (t.fullPage && H.framed));
    var a = H.el(href ? "a" : "div", { class: "tile frost" + (href ? "" : " tile--off") + (t.locked ? " tile--locked" : ""), href: href || null,
      target: newTab ? "_blank" : null, rel: newTab ? "noopener" : null, "aria-disabled": href ? null : "true" });
    var corner = !href ? H.el("span", { class: "badge", text: H.t("comingSoon") })
      : t.locked ? H.el("span", { class: "badge", text: "🔒 " + H.t("leadsOnly") })
        : hub.appearance.showCodes !== false ? H.el("span", { class: "tile-code", text: t.code || "" }) : null;
    a.appendChild(H.el("div", { class: "tile-top" }, [H.iconEl(t.icon, "tile-icon"), corner]));
    // Number shown in the list / scanner layouts; pressing that number key opens the tile.
    if (number && href) { a.appendChild(H.el("span", { class: "tile-key", "aria-hidden": "true", text: String(number) })); a.setAttribute("data-key", String(number)); }
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
    var visible = hub.tiles.filter(H.tileAvailable);
    if (!visible.length) {
      box.appendChild(H.el("div", { class: "empty frost" }, [H.el("strong", { text: H.t("noTools") }), H.t("noToolsAdmin")]));
      return;
    }
    var groups = [{ id: "", title: null }].concat(hub.groups || []);
    var n = 0;
    groups.forEach(function (g) {
      var tiles = visible.filter(function (t) { return (t.groupId || "") === g.id; });
      if (!tiles.length) return;
      if (g.title) box.appendChild(H.el("h2", { class: "group-title", text: H.pick(g.title) }));
      var grid = H.el("section", { class: "tiles" });
      tiles.forEach(function (t) {
        var num = tileHref(t) ? ++n : 0; // only tiles that open get a number
        grid.appendChild(tileEl(t, num && num <= 9 ? num : 0));
      });
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
    // No screensaver on handheld scanners: they're carried around, not left on a wall.
    if (saverDeadline && Date.now() > saverDeadline && pinDialog.open === false && layout !== "scanner") $("saver").hidden = false;
  }, 1000);

  // List and scanner layouts: number keys 1–9 open the matching tool (handy on scanners with a keypad).
  document.addEventListener("keydown", function (ev) {
    if (layout === "tiles" || pinDialog.open || ev.ctrlKey || ev.metaKey || ev.altKey || !/^[1-9]$/.test(ev.key)) return;
    var a = document.querySelector('#tiles [data-key="' + ev.key + '"]');
    if (a) { ev.preventDefault(); a.click(); }
  });

  var layout = "tiles";
  function render() {
    H.resolveLang(hub.settings);
    H.applyAppearance(hub.appearance);
    H.applyKioskMode(hub.settings, hub.device);
    layout = H.applyLayout(H.resolveLayout(hub));
    renderHeader();
    renderLayout();
    renderClock();
    renderNotes();
    renderTiles();
    renderSaver();
    armSaver();
  }

  var firstBuild = null;
  function loadHub() {
    return H.fetchJson("/api/hub?device=" + encodeURIComponent(H.deviceId())).then(function (data) {
      // A new version was deployed: reload to pick up the new kiosk code (not while someone is typing a PIN).
      if (firstBuild && data.build && data.build !== firstBuild && !pinDialog.open) { location.reload(); return; }
      firstBuild = firstBuild || data.build;
      var json = JSON.stringify(data);
      if (json === hubJson) return;
      hubJson = json;
      hub = data;
      render();
    });
  }

  loadHub().catch(function () { $("greeting").textContent = H.t("couldNotLoad"); });
  H.detectScanner(function () { if (hub) render(); });
  H.startHeartbeat();
  setInterval(function () { if (hub) { renderClock(); renderNotes(); renderTiles(); } }, 60000); // schedules and note dates tick over
  setInterval(function () { if (hub) renderClock(); }, 10000);
  setInterval(function () { if (hub) renderTopClock(); }, 1000); // the top bar clock turns over on the minute
  setInterval(function () { loadHub().catch(function () {}); }, 60000); // picks up admin changes without a reload
})();
