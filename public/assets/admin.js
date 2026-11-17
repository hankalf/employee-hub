/* Admin area: tiles and settings (note, logo, appearance, hub). Talks to /api/admin/*. */
(function () {
  "use strict";
  var H = window.Hub;
  var el = H.el;
  var $ = function (id) { return document.getElementById(id); };
  var content = null;
  var editingId = null;

  var EMOJI = ["📋", "🔧", "🏖️", "🦺", "🔗", "📄", "🎥", "🛡️", "📅", "💵", "🎓", "📞", "🚛", "🚜", "📦", "⚠️", "✅", "⭐", "ℹ️", "💬", "🗺️", "👤", "🚩", "🔔", "🏠", "🔑", "✉️", "🧰", "📊", "🧊", "🍽️", "🩺", "🕒", "📣"];

  // --- API ---------------------------------------------------------------------
  function api(method, url, body) {
    var opts = { method: method, headers: { "X-Requested-With": "hub" }, cache: "no-store" };
    if (body instanceof FormData) opts.body = body;
    else if (body !== undefined) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
    return fetch(url, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.status === 401) { location.href = "/admin/login"; throw new Error("Please sign in again."); }
        if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
        return j;
      });
    });
  }
  var toastTimer;
  function toast(msg, isError) {
    var old = document.querySelector(".toast");
    if (old) old.remove();
    var t = el("div", { class: "toast" + (isError ? " err" : ""), role: "status", text: msg });
    document.body.appendChild(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.remove(); }, isError ? 6000 : 2500);
  }
  function refreshPreview() {
    var f = $("preview");
    try { f.contentWindow.location.reload(); } catch (e) { f.src = "/kiosk?" + Date.now(); }
  }

  // --- tabs --------------------------------------------------------------------
  function showTab(name) {
    document.querySelectorAll(".tabs [role=tab]").forEach(function (b) { b.setAttribute("aria-selected", String(b.dataset.tab === name)); });
    document.querySelectorAll(".tab").forEach(function (s) { s.hidden = s.id !== "tab-" + name; });
    history.replaceState(null, "", "#" + name);
  }
  document.querySelectorAll(".tabs [role=tab]").forEach(function (b) { b.addEventListener("click", function () { showTab(b.dataset.tab); }); });

  // --- small helpers -----------------------------------------------------------
  function setBi(prefix, obj) { $(prefix + "_en").value = (obj && obj.en) || ""; $(prefix + "_es").value = (obj && obj.es) || ""; }
  function getBi(prefix) { return { en: $(prefix + "_en").value.trim(), es: $(prefix + "_es").value.trim() }; }
  function emojiRow(container, input) {
    container.innerHTML = "";
    EMOJI.forEach(function (e) {
      var b = el("button", { type: "button", text: e, "aria-pressed": String(input.value.trim() === e), "aria-label": "Use " + e });
      b.addEventListener("click", function () { input.value = e; emojiRow(container, input); });
      container.appendChild(b);
    });
  }
  function linkKind(url) {
    if (!url) return { text: "No link yet — shows as \"Coming soon\"", cls: "warn" };
    try {
      var h = new URL(url).hostname;
      if (h === "forms.monday.com") return { text: "monday.com form", cls: "ok" };
      if (h === "view.monday.com") return { text: "monday.com public board view", cls: "ok" };
      if (h === "monday.com" || /\.monday\.com$/.test(h)) return { text: "monday.com (needs a monday login — best opened in a new tab)", cls: "" };
      return { text: h, cls: "" };
    } catch (e) { return { text: url, cls: "" }; }
  }
  var hintTimer;
  var DEFAULT_LINK_HINT = "Paste the form's share link (monday.com → form → Share → copy link), or any web address. Leave blank for \"Coming soon\".";
  function liveLinkHint(input, hint, openRadios) {
    clearTimeout(hintTimer);
    var v = input.value.trim();
    if (!v) { hint.textContent = DEFAULT_LINK_HINT; hint.className = "hint"; return; }
    hintTimer = setTimeout(function () {
      api("GET", "/api/admin/link-info?url=" + encodeURIComponent(v)).then(function (info) {
        if (!info.ok) { hint.textContent = info.error; hint.className = "hint hint--warn"; return; }
        var texts = {
          form: "monday.com form — opens inside the hub; the kiosk returns home automatically afterwards.",
          "public-board": "monday.com public board view — can open inside the hub.",
          monday: "A monday.com board, dashboard or doc. These need a monday login, so open them in a new tab.",
          web: "Web link (" + info.host + "). If the site refuses to be embedded, choose \"In a new tab\".",
        };
        hint.textContent = texts[info.kind] || info.url;
        hint.className = "hint " + (info.kind === "form" ? "hint--ok" : "");
        if (openRadios && info.kind === "monday") openRadios.tab.checked = true;
        if (openRadios && info.kind === "form") openRadios.embed.checked = true;
      }).catch(function () {});
    }, 350);
  }

  // --- tiles list --------------------------------------------------------------
  function switchBtn(on, onToggle) {
    var b = el("button", { type: "button", class: "switch", role: "switch", "aria-checked": String(on), "aria-label": on ? "Shown on the kiosk" : "Hidden" });
    b.addEventListener("click", onToggle);
    return b;
  }
  function move(i, dir) {
    var ids = content.tiles.map(function (x) { return x.id; });
    var j = i + dir;
    if (j < 0 || j >= ids.length) return;
    var tmp = ids[i]; ids[i] = ids[j]; ids[j] = tmp;
    api("PUT", "/api/admin/tiles/order", { ids: ids }).then(reload).catch(function (e) { toast(e.message, true); });
  }
  function renderTiles() {
    var ul = $("tiles-list");
    ul.innerHTML = "";
    if (!content.tiles.length) ul.appendChild(el("li", { class: "empty-note", text: "No tiles yet. Add one for each monday.com form." }));
    content.tiles.forEach(function (t, i) {
      var k = linkKind(t.url);
      var actions = el("div", { class: "actions" });
      actions.appendChild(switchBtn(t.active, function () {
        api("PUT", "/api/admin/tiles/" + t.id, { active: !t.active }).then(reload).catch(function (e) { toast(e.message, true); });
      }));
      var up = el("button", { type: "button", text: "↑", "aria-label": "Move up" }); up.disabled = i === 0; up.addEventListener("click", function () { move(i, -1); });
      var down = el("button", { type: "button", text: "↓", "aria-label": "Move down" }); down.disabled = i === content.tiles.length - 1; down.addEventListener("click", function () { move(i, 1); });
      var edit = el("button", { type: "button", text: "Edit" }); edit.addEventListener("click", function () { openTileEditor(t); });
      var del = el("button", { type: "button", class: "del", text: "Delete" });
      del.addEventListener("click", function () {
        if (!confirm("Delete \"" + t.title.en + "\"? This can't be undone.")) return;
        api("DELETE", "/api/admin/tiles/" + t.id).then(function () { toast("Deleted"); return reload(); }).catch(function (e) { toast(e.message, true); });
      });
      [up, down, edit, del].forEach(function (b) { actions.appendChild(b); });
      ul.appendChild(el("li", { class: t.active ? "" : "inactive" }, [
        el("span", { class: "ico", "aria-hidden": "true", text: H.icon(t.icon) }),
        el("div", { class: "main" }, [
          el("strong", { text: t.title.en || "(untitled)" }),
          el("span", { class: k.cls, text: k.text + (t.url ? " · " + (t.open === "embed" ? "opens inside the hub" : "opens in a new tab") : "") }),
        ]),
        actions,
      ]));
    });
  }

  // --- tile editor -------------------------------------------------------------
  var dlgItem = $("dlg-item");
  function openTileEditor(item) {
    editingId = item ? item.id : null;
    $("item-title").textContent = item ? "Edit tile" : "Add tile";
    setBi("i-title", item && item.title); setBi("i-description", item && item.description);
    $("i-url").value = item ? item.url : "";
    $("i-icon").value = item ? item.icon : "📋";
    $("i-code").value = item && item.code ? item.code : String(content.tiles.length + 1).padStart(2, "0");
    $("i-active").checked = item ? item.active : true;
    var open = item ? item.open : "embed";
    document.querySelectorAll("input[name=i-open]").forEach(function (r) { r.checked = r.value === open; });
    emojiRow($("i-emoji"), $("i-icon"));
    $("item-error").hidden = true;
    $("item-delete").hidden = !item;
    liveLinkHint($("i-url"), $("i-url-hint"), null);
    dlgItem.showModal();
  }
  $("i-url").addEventListener("input", function () {
    var radios = { embed: document.querySelector("input[name=i-open][value=embed]"), tab: document.querySelector("input[name=i-open][value=tab]") };
    liveLinkHint($("i-url"), $("i-url-hint"), radios);
  });
  $("i-icon").addEventListener("input", function () { emojiRow($("i-emoji"), $("i-icon")); });
  $("item-form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var body = {
      title: getBi("i-title"), description: getBi("i-description"), url: $("i-url").value.trim(), icon: $("i-icon").value.trim(),
      open: (document.querySelector("input[name=i-open]:checked") || {}).value || "embed", active: $("i-active").checked, code: $("i-code").value.trim(),
    };
    $("item-save").disabled = true;
    api(editingId ? "PUT" : "POST", "/api/admin/tiles" + (editingId ? "/" + editingId : ""), body).then(function () {
      dlgItem.close(); toast("Saved"); return reload();
    }).catch(function (e) { $("item-error").textContent = e.message; $("item-error").hidden = false; })
      .finally(function () { $("item-save").disabled = false; });
  });
  $("item-delete").addEventListener("click", function () {
    if (!confirm("Delete this tile? This can't be undone.")) return;
    api("DELETE", "/api/admin/tiles/" + editingId).then(function () { dlgItem.close(); toast("Deleted"); return reload(); }).catch(function (e) { toast(e.message, true); });
  });
  $("add-tile").addEventListener("click", function () { openTileEditor(null); });
  document.querySelectorAll("dialog [data-close]").forEach(function (b) { b.addEventListener("click", function () { b.closest("dialog").close(); }); });

  // --- note --------------------------------------------------------------------
  function renderNote() {
    var n = content.note;
    $("n-active").checked = Boolean(n.active);
    $("n-style").value = n.style || "info";
    setBi("n-title", n.title); setBi("n-body", n.body);
    $("n-until").value = n.until || "";
  }
  $("note-form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var body = { active: $("n-active").checked, style: $("n-style").value, title: getBi("n-title"), body: getBi("n-body"), until: $("n-until").value };
    api("PUT", "/api/admin/note", body).then(function () { toast("Note saved"); return reload(); }).catch(function (e) { toast(e.message, true); });
  });

  // --- logo --------------------------------------------------------------------
  function renderLogo() {
    var box = $("logo-preview");
    box.innerHTML = "";
    if (content.logo) box.appendChild(el("img", { src: "/logo?v=" + encodeURIComponent(content.logo), alt: "Current logo" }));
    else box.appendChild(el("span", { class: "hint", text: "No logo yet" }));
    $("logo-remove").hidden = !content.logo;
    H.renderBrand($("brand"), { settings: { hubName: { en: (content.settings.hubName.en || "Employee Hub") + " · Admin" } }, logo: content.logo });
  }
  $("logo-form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var file = $("logo-file").files[0];
    if (!file) return toast("Choose an image first.", true);
    var fd = new FormData();
    fd.append("logo", file);
    $("logo-upload").disabled = true;
    api("POST", "/api/admin/logo", fd).then(function () { $("logo-file").value = ""; toast("Logo uploaded"); return reload(); })
      .catch(function (e) { toast(e.message, true); }).finally(function () { $("logo-upload").disabled = false; });
  });
  $("logo-remove").addEventListener("click", function () {
    if (!confirm("Remove the logo?")) return;
    api("DELETE", "/api/admin/logo").then(function () { toast("Logo removed"); return reload(); }).catch(function (e) { toast(e.message, true); });
  });

  // --- appearance --------------------------------------------------------------
  function syncColour(textId, pickerId) {
    var text = $(textId), picker = $(pickerId);
    picker.addEventListener("input", function () { text.value = picker.value; });
    text.addEventListener("input", function () { if (/^#[0-9a-f]{6}$/i.test(text.value.trim())) picker.value = text.value.trim(); });
  }
  syncColour("a-accent", "a-accent-picker");
  syncColour("a-background", "a-background-picker");
  $("a-background-clear").addEventListener("click", function () { $("a-background").value = ""; });
  function renderAppearance() {
    var a = content.appearance;
    ["theme", "accentStyle", "cardStyle", "radius", "font", "tileSize", "tileColumns"].forEach(function (k) { $("a-" + k).value = a[k]; });
    $("a-accent").value = a.accent; $("a-accent-picker").value = a.accent;
    $("a-background").value = a.background || ""; $("a-background-picker").value = a.background || "#f8f8f8";
    $("a-showCodes").checked = a.showCodes !== false; $("a-showDate").checked = a.showDate !== false; $("a-showIntro").checked = a.showIntro !== false;
  }
  $("appearance-form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var body = {};
    ["theme", "accentStyle", "cardStyle", "radius", "font", "tileSize", "tileColumns"].forEach(function (k) { body[k] = $("a-" + k).value; });
    body.accent = $("a-accent").value.trim(); body.background = $("a-background").value.trim();
    body.showCodes = $("a-showCodes").checked; body.showDate = $("a-showDate").checked; body.showIntro = $("a-showIntro").checked;
    api("PUT", "/api/admin/appearance", body).then(function () { toast("Appearance saved"); return reload(); }).catch(function (e) { toast(e.message, true); });
  });

  // --- hub settings ------------------------------------------------------------
  function renderSettings() {
    var s = content.settings;
    setBi("s-hubName", s.hubName); setBi("s-intro", s.intro); setBi("s-teamWord", s.teamWord);
    $("s-lang-es").checked = s.languages.indexOf("es") >= 0;
    $("s-defaultLang").value = s.defaultLang;
    $("s-showQr").checked = s.showQr !== false;
    $("s-idleReturnSeconds").value = s.idleReturnSeconds;
    $("s-publicUrl").value = s.publicUrl || "";
    $("s-publicUrl-hint").textContent = "Currently the QR code points to " + content.publicUrl + (s.publicUrl ? "" : " (taken from the address this page was opened on). Set it here if the hub has a custom domain.");
  }
  $("settings-form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var body = {
      hubName: getBi("s-hubName"), intro: getBi("s-intro"), teamWord: getBi("s-teamWord"),
      languages: $("s-lang-es").checked ? ["en", "es"] : ["en"], defaultLang: $("s-defaultLang").value, showQr: $("s-showQr").checked,
      idleReturnSeconds: Number($("s-idleReturnSeconds").value), publicUrl: $("s-publicUrl").value.trim(),
    };
    api("PUT", "/api/admin/settings", body).then(function () { toast("Settings saved"); return reload(); }).catch(function (e) { toast(e.message, true); });
  });

  // --- load --------------------------------------------------------------------
  var firstLoad = true;
  function reload() {
    return api("GET", "/api/admin/content").then(function (c) {
      content = c;
      renderTiles(); renderNote(); renderLogo(); renderAppearance(); renderSettings();
      if (!firstLoad) refreshPreview();
      firstLoad = false;
    });
  }
  reload().catch(function (e) { toast(e.message, true); });
  showTab((location.hash || "#tiles").slice(1).replace(/[^a-z]/g, "") === "settings" ? "settings" : "tiles");
})();
