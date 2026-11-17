/* Kiosk home: greeting, note, and tiles that open monday.com forms. */
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
    var showDate = hub.appearance.showDate !== false;
    $("date").hidden = !showDate;
    $("date").textContent = new Date().toLocaleDateString(H.locale(), { weekday: "long", month: "long", day: "numeric" });
    $("greeting").textContent = greetingWord() + ", " + (H.pick(hub.settings.teamWord) || "team") + ".";
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

  function renderNote() {
    var n = hub.note || {};
    var box = $("note");
    var title = H.pick(n.title), body = H.pick(n.body);
    var expired = n.until && n.until < H.today();
    if (!n.active || expired || (!title && !body)) { box.hidden = true; return; }
    box.hidden = false;
    box.className = "note frost note--" + (n.style || "info");
    $("note-icon").textContent = H.noteIcon(n.style);
    $("note-title").textContent = title;
    $("note-title").hidden = !title;
    $("note-body").textContent = body;
    $("note-body").hidden = !body;
  }

  function tileHref(t) {
    if (!t.url) return null;
    return t.open === "tab" ? t.url : "/open/t/" + encodeURIComponent(t.id);
  }

  function renderTiles() {
    var box = $("tiles");
    box.innerHTML = "";
    var intro = $("intro");
    intro.textContent = H.pick(hub.settings.intro);
    intro.hidden = hub.appearance.showIntro === false || !intro.textContent;
    if (!hub.tiles.length) {
      box.appendChild(H.el("div", { class: "empty frost" }, [H.el("strong", { text: H.t("noTools") }), H.t("noToolsAdmin")]));
      return;
    }
    hub.tiles.forEach(function (t) {
      var href = tileHref(t);
      var a = H.el(href ? "a" : "div", { class: "tile frost" + (href ? "" : " tile--off"), href: href || null,
        target: href && t.open === "tab" ? "_blank" : null, rel: href && t.open === "tab" ? "noopener" : null, "aria-disabled": href ? null : "true" });
      a.appendChild(H.el("div", { class: "tile-top" }, [
        H.el("span", { class: "tile-icon", "aria-hidden": "true", text: H.icon(t.icon) }),
        href ? (hub.appearance.showCodes !== false ? H.el("span", { class: "tile-code", text: t.code || "" }) : null) : H.el("span", { class: "badge", text: H.t("comingSoon") }),
      ]));
      a.appendChild(H.el("div", null, [
        H.el("h2", null, [H.pick(t.title), H.el("span", { class: "arrow", "aria-hidden": "true", text: "↗" })]),
        H.pick(t.description) ? H.el("p", { text: H.pick(t.description) }) : null,
      ]));
      box.appendChild(a);
    });
  }

  function render() {
    H.resolveLang(hub.settings);
    H.applyAppearance(hub.appearance);
    renderHeader();
    renderClock();
    renderNote();
    renderTiles();
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
  setInterval(function () { if (hub) { renderClock(); renderNote(); } }, 30000);
  setInterval(function () { loadHub().catch(function () {}); }, 60000); // picks up admin changes without a reload
})();
