/* Admin area: tiles and groups, notes, activity, settings (kiosks, alerts, admins, logo, appearance, hub, backups). Talks to /api/admin/*. */
(function () {
  "use strict";
  var H = window.Hub;
  var el = H.el;
  var $ = function (id) { return document.getElementById(id); };
  var content = null;
  var me = null;
  var stats = { usage: {}, devices: [] };
  var editing = { tile: null, group: null, note: null, kiosk: null };

  var EMOJI = ["📋", "🔧", "🏖️", "🦺", "🔗", "📄", "🎥", "🛡️", "📅", "💵", "🎓", "📞", "🚛", "🚜", "📦", "⚠️", "✅", "⭐", "ℹ️", "💬", "🗺️", "👤", "🚩", "🔔", "🏠", "🔑", "✉️", "🧰", "📊", "🧊", "🍽️", "🩺", "🕒", "📣"];
  var DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var ONLINE_MS = 3 * 60 * 1000;
  var BAD = ["blocked", "login", "notfound"];

  // --- API ---------------------------------------------------------------------
  function api(method, url, body) {
    var opts = { method: method, headers: { "X-Requested-With": "hub" }, cache: "no-store" };
    if (body instanceof FormData) opts.body = body;
    else if (body !== undefined) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
    return fetch(url, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.status === 401) { location.href = "/admin/login"; throw new Error("Please sign in again."); }
        if (j.code === "mustChangePassword") openPasswordDialog(true);
        if (!r.ok) { var e = new Error(j.error || ("HTTP " + r.status)); e.code = j.code; throw e; }
        return j;
      });
    });
  }
  var toastTimer;
  /** A short message at the bottom. With opts.undo, it carries an Undo button for a few seconds. */
  function toast(msg, isError, opts) {
    var old = document.querySelector(".toast");
    if (old) old.remove();
    var t = el("div", { class: "toast" + (isError ? " err" : ""), role: "status" }, [el("span", { text: msg })]);
    if (opts && opts.undo) {
      var b = el("button", { type: "button", class: "toast-undo", text: "Undo" });
      b.addEventListener("click", function () {
        t.remove();
        api("POST", "/api/admin/undo/" + encodeURIComponent(opts.undo), {}).then(function () { toast("Restored"); return reload(); }).catch(fail);
      });
      t.appendChild(b);
    }
    document.body.appendChild(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.remove(); }, opts && opts.undo ? 9000 : isError ? 6000 : 2500);
  }
  var fail = function (e) { if (e.code !== "mustChangePassword") toast(e.message, true); };
  function refreshPreview() {
    var f = $("preview");
    try { f.contentWindow.location.reload(); } catch (e) { f.src = "/kiosk?" + Date.now(); }
  }
  var isOwner = function () { return me && me.role === "owner"; };
  if (/[?&]signedin=1/.test(location.search)) history.replaceState(null, "", "/admin" + location.hash); // tidy the address after signing in

  // --- tabs --------------------------------------------------------------------
  var TABS = ["tiles", "notes", "activity", "settings"];
  function showTab(name) {
    if (TABS.indexOf(name) < 0) name = "tiles";
    document.querySelectorAll(".tabs [role=tab]").forEach(function (b) { b.setAttribute("aria-selected", String(b.dataset.tab === name)); });
    document.querySelectorAll(".tab").forEach(function (s) { s.hidden = s.id !== "tab-" + name; });
    history.replaceState(null, "", "#" + name);
    if (name === "activity") { renderUsage(); loadActivity(); }
    if (name === "settings") loadBackups();
  }
  document.querySelectorAll(".tabs [role=tab]").forEach(function (b) { b.addEventListener("click", function () { showTab(b.dataset.tab); }); });

  // --- drag and drop ordering ----------------------------------------------------
  /**
   * Reorder the direct children of `list` that have data-id, by dragging their ".handle" (mouse or touch),
   * or by focusing the handle and pressing the arrow keys. Calls onDrop(ids) with the new order.
   */
  function makeSortable(list, onDrop) {
    var items = function () { return Array.prototype.filter.call(list.children, function (c) { return c.dataset && c.dataset.id; }); };
    var ids = function () { return items().map(function (c) { return c.dataset.id; }); };
    list.addEventListener("pointerdown", function (ev) {
      var handle = ev.target.closest(".handle");
      if (!handle || ev.button > 0) return;
      var item = handle.closest("[data-id]");
      if (!item || item.parentElement !== list) return;
      ev.preventDefault();
      var start = ids().join(",");
      item.classList.add("dragging");
      // Listen on the window: moving the row in the page releases any pointer capture on its handle.
      function move(e) {
        var others = items().filter(function (c) { return c !== item; });
        var before = others.filter(function (c) { var r = c.getBoundingClientRect(); return e.clientY < r.top + r.height / 2; })[0] || null;
        var target = before || (others.length ? others[others.length - 1].nextSibling : null);
        if (item.nextSibling !== target && item !== target) list.insertBefore(item, target); // only move when the place changes
      }
      function up() {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        item.classList.remove("dragging");
        if (ids().join(",") !== start) onDrop(ids());
      }
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    });
    list.addEventListener("keydown", function (ev) {
      var handle = ev.target.closest && ev.target.closest(".handle");
      if (!handle || (ev.key !== "ArrowUp" && ev.key !== "ArrowDown")) return;
      var item = handle.closest("[data-id]");
      if (!item || item.parentElement !== list) return;
      ev.preventDefault();
      var all = items(), i = all.indexOf(item);
      if (ev.key === "ArrowUp" && i > 0) list.insertBefore(item, all[i - 1]);
      else if (ev.key === "ArrowDown" && i < all.length - 1) list.insertBefore(item, all[i + 1].nextSibling);
      else return;
      handle.focus();
      onDrop(ids());
    });
  }
  function handle(label) {
    return el("button", { type: "button", class: "handle", "aria-label": "Drag to reorder " + label + " (or use the arrow keys)", title: "Drag to reorder", text: "⠿" });
  }

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
  function ago(iso) {
    if (!iso) return "never";
    var s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return Math.round(s / 60) + " min ago";
    if (s < 86400) return Math.round(s / 3600) + " h ago";
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  function fmtDate(ymd) {
    if (!ymd) return "";
    return new Date(ymd + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }
  function scheduleText(s) {
    if (!s) return "";
    var days = s.days.slice().sort();
    var label = days.join(",") === "1,2,3,4,5" ? "Mon–Fri" : days.length === 7 ? "Every day" : days.join(",") === "0,6" ? "Weekends" : days.map(function (d) { return DAYS[d]; }).join(" ");
    return label + " " + s.start + "–" + s.end;
  }
  function linkKind(url) {
    if (!url) return { text: "No link yet — shows as \"Coming soon\"", cls: "tag--warn" };
    try {
      var h = new URL(url).hostname;
      if (h === "forms.monday.com" || h === "wkf.ms") return { text: "monday.com form", cls: "tag--ok" };
      if (h === "view.monday.com") return { text: "monday.com public board", cls: "tag--ok" };
      if (h === "monday.com" || /\.monday\.com$/.test(h)) return { text: "monday.com board", cls: "" };
      return { text: h, cls: "" };
    } catch (e) { return { text: url, cls: "" }; }
  }
  var hintTimer;
  var PASTE_HELP = {
    link: { hint: "In monday.com open the form, click Share form and copy the link (forms.monday.com/… or wkf.ms/…). Any other web address works too. Leave blank for \"Coming soon\".", placeholder: "https://forms.monday.com/forms/…", rows: 1 },
    embed: { hint: "In monday.com open the form, click Share form → Embed and copy the code. Paste the whole <iframe …> code here; the hub takes the form address out of it.", placeholder: "<iframe src=\"https://forms.monday.com/forms/embed/…\" …></iframe>", rows: 4 },
  };
  var pasteMode = "link";
  var DEFAULT_LINK_HINT = PASTE_HELP.link.hint;
  function setPasteMode(mode, keepHint) {
    pasteMode = mode;
    document.querySelectorAll("[data-paste]").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.paste === mode)); });
    var help = PASTE_HELP[mode];
    $("i-url").placeholder = help.placeholder;
    $("i-url").rows = help.rows;
    DEFAULT_LINK_HINT = help.hint;
    if (!keepHint && !$("i-url").value.trim()) { $("i-url-hint").textContent = help.hint; $("i-url-hint").className = "hint"; }
  }
  document.querySelectorAll("[data-paste]").forEach(function (b) {
    b.addEventListener("click", function () { setPasteMode(b.dataset.paste); $("i-url").focus(); });
  });
  function liveLinkHint(input, hint, setOpen) {
    clearTimeout(hintTimer);
    var v = input.value.trim();
    if (!v) { hint.textContent = DEFAULT_LINK_HINT; hint.className = "hint"; return; }
    hintTimer = setTimeout(function () {
      var texts = {
        form: "monday.com form.",
        "form-short": "monday.com form (short link).",
        "public-board": "monday.com public board view.",
        monday: "This is a link inside your monday.com account, which needs a monday sign-in. For a form, open it in monday.com, click Share form and copy that link instead (it starts with forms.monday.com or wkf.ms).",
        web: "Web link (" + v.replace(/^https?:\/\//, "").split("/")[0] + ").",
      };
      hint.textContent = "Checking the link with monday.com…";
      hint.className = "hint";
      api("GET", "/api/admin/link-info?check=1&url=" + encodeURIComponent(v)).then(function (info) {
        if (input.value.trim() !== v) return; // the admin kept typing
        if (!info.ok) { hint.textContent = info.error; hint.className = "hint hint--warn"; return; }
        var parts = [texts[info.kind] || ""];
        // Embed code: show the form address that was found in it, so it's clear what will be saved.
        if (/^\s*</.test(v) || /\bsrc\s*=/i.test(v)) {
          input.value = info.url;
          input.rows = 1;
          parts.unshift("Embed code recognised.");
        }
        if (info.check && info.check.resolvedUrl) parts.push("Short link goes to " + info.check.resolvedUrl.replace(/^https:\/\//, "") + ".");
        if (info.kind !== "monday" && info.check) parts.push(checkText(info.check, "hint"));
        hint.textContent = parts.filter(Boolean).join(" ");
        var st = info.check && info.check.status;
        hint.className = "hint " + (st === "ok" ? "hint--ok" : st === "blocked" || st === "login" || st === "notfound" || info.kind === "monday" ? "hint--warn" : "");
        if (setOpen && info.kind === "monday") setOpen("tab");
        if (setOpen && (info.kind === "form" || info.kind === "form-short")) setOpen("embed");
      }).catch(function () { hint.textContent = texts.web; });
    }, 500);
  }
  /** Plain-language result of the server's check of a link. */
  var CHECK_TEXT = {
    ok: { tag: "✓ shows inside the hub", cls: "tag--ok", hint: "✓ Checked: this form can be shown inside the hub." },
    blocked: { tag: "⚠ opens full screen", cls: "tag--warn", hint: "This page won't let itself be shown inside another site ({x}). The kiosk will open it full screen instead; people use the browser's back button to return." },
    login: { tag: "⚠ needs a monday login", cls: "tag--warn", hint: "This link asks for a monday.com sign-in, so people at the kiosk can't fill it in. In monday.com, open the form's settings and allow anyone with the link to submit it, then copy the link from Share form." },
    notfound: { tag: "⚠ form not found", cls: "tag--warn", hint: "monday.com says this form doesn't exist ({x}). It may have been deleted, or the link was copied incompletely." },
    unknown: { tag: "? not checked", cls: "", hint: "The server couldn't check this link ({x}). It will be tried inside the hub." },
  };
  function checkText(check, field) {
    if (!check) return "";
    var c = CHECK_TEXT[check.status] || CHECK_TEXT.unknown;
    return c[field].replace("{x}", check.detail || "no answer");
  }
  function switchBtn(on, label, onToggle) {
    var b = el("button", { type: "button", class: "switch", role: "switch", "aria-checked": String(on), "aria-label": label });
    b.addEventListener("click", onToggle);
    return b;
  }
  function actionBtn(text, label, onClick, opts) {
    var b = el("button", { type: "button", text: text, "aria-label": label, class: (opts && opts.cls) || "" });
    if (opts && opts.disabled) b.disabled = true;
    b.addEventListener("click", onClick);
    return b;
  }

  // --- tiles and groups --------------------------------------------------------
  function badTiles() {
    return content.tiles.filter(function (t) { return t.url && t.open === "embed" && t.embedCheck && BAD.indexOf(t.embedCheck.status) >= 0; });
  }
  function tileRow(t) {
    var k = linkKind(t.url);
    var u = stats.usage[t.id] || { last30: 0, total: 0, lastAt: "" };
    var tags = [el("span", { class: "tag " + k.cls, text: k.text })];
    if (t.url && t.open === "tab") tags.push(el("span", { class: "tag", text: "opens in a new tab" }));
    else if (t.url && t.embedCheck) {
      var c = CHECK_TEXT[t.embedCheck.status] || CHECK_TEXT.unknown;
      tags.push(el("span", { class: "tag " + c.cls, text: c.tag, title: checkText(t.embedCheck, "hint") + " Checked " + ago(t.embedCheck.checkedAt) + "." }));
    } else if (t.url) tags.push(el("span", { class: "tag", text: "opens inside the hub" }));
    if (t.schedule) tags.push(el("span", { class: "tag tag--accent", text: "🕒 " + scheduleText(t.schedule) }));
    if (t.hasPin) tags.push(el("span", { class: "tag tag--accent", text: "🔒 PIN" }));
    var actions = el("div", { class: "actions" }, [
      switchBtn(t.active, t.active ? "Shown on the kiosk" : "Hidden", function () { api("PUT", "/api/admin/tiles/" + t.id, { active: !t.active }).then(reload).catch(fail); }),
      actionBtn("Edit", "Edit " + t.title.en, function () { openTileEditor(t); }),
      actionBtn("Delete", "Delete " + t.title.en, function () { deleteTile(t); }, { cls: "del" }),
    ]);
    return el("li", { class: t.active ? "" : "inactive", "data-id": t.id }, [
      handle(t.title.en),
      H.iconEl(t.icon, "ico"),
      el("div", { class: "main" }, [el("strong", { text: t.title.en || "(untitled)" }), el("div", { class: "tags" }, tags)]),
      el("div", { class: "usage", title: u.total + " taps in total" + (u.lastAt ? ", last " + ago(u.lastAt) : "") }, [el("strong", { text: String(u.last30) }), "taps · 30 days"]),
      actions,
    ]);
  }
  function deleteTile(t, after) {
    api("DELETE", "/api/admin/tiles/" + t.id).then(function (r) {
      if (after) after();
      toast("Deleted \"" + t.title.en + "\"", false, { undo: r.undo });
      return reload();
    }).catch(fail);
  }
  /** New order of one group's tiles → new order of all tiles. */
  function saveTileOrder(groupId, groupIds) {
    var all = content.tiles.map(function (t) { return t.id; });
    var slots = content.tiles.map(function (t, i) { return (t.groupId || "") === groupId ? i : -1; }).filter(function (i) { return i >= 0; });
    slots.forEach(function (slot, k) { all[slot] = groupIds[k]; });
    api("PUT", "/api/admin/tiles/order", { ids: all }).then(reload).catch(fail);
  }
  function renderTiles() {
    var box = $("tiles-lists");
    box.innerHTML = "";
    var bad = badTiles();
    var banner = $("tile-problems");
    banner.hidden = !bad.length;
    banner.textContent = bad.length ? (bad.length === 1 ? "1 tile needs attention: " : bad.length + " tiles need attention: ") + bad.map(function (t) { return t.title.en; }).join(", ") + ". Hover the orange label for details." : "";
    var tab = document.querySelector('.tabs [data-tab="tiles"]');
    tab.textContent = bad.length ? "Tiles ⚠ " + bad.length : "Tiles";
    if (!content.tiles.length && !content.groups.length) {
      box.appendChild(el("div", { class: "items frost" }, [el("p", { class: "empty-note", text: "No tiles yet. Add one for each monday.com form." })]));
      return;
    }
    var sections = [{ id: "", title: null }].concat(content.groups);
    sections.forEach(function (g) {
      var list = content.tiles.filter(function (t) { return (t.groupId || "") === g.id; });
      if (!g.id && !list.length && content.groups.length) return;
      var block = el("div", { class: "group-block", "data-id": g.id || null });
      if (g.id) {
        block.appendChild(el("div", { class: "group-head" }, [
          handle("group " + g.title.en),
          el("h3", { text: g.title.en + (g.title.es ? "  ·  " + g.title.es : "") }),
          actionBtn("Edit group", "Edit group " + g.title.en, function () { openGroupEditor(g); }),
        ]));
      } else if (content.groups.length) {
        block.appendChild(el("div", { class: "group-head" }, [el("h3", { text: "No group (shown first)" })]));
      }
      var ul = el("ul", { class: "items frost" });
      if (!list.length) ul.appendChild(el("li", { class: "empty-note", text: "No tiles in this group yet. Edit a tile and choose this group." }));
      list.forEach(function (t) { ul.appendChild(tileRow(t)); });
      makeSortable(ul, function (order) { saveTileOrder(g.id, order); });
      block.appendChild(ul);
      box.appendChild(block);
    });
  }
  // Groups are reordered by their handle; the container stays, so this is set up once.
  makeSortable($("tiles-lists"), function (order) { api("PUT", "/api/admin/groups/order", { ids: order }).then(reload).catch(fail); });

  // Tile editor
  var dlgItem = $("dlg-item");
  function setOpenMode(v) { document.querySelectorAll("input[name=i-open]").forEach(function (r) { r.checked = r.value === v; }); }
  function renderDays(days) {
    var box = $("i-days");
    box.innerHTML = "";
    [1, 2, 3, 4, 5, 6, 0].forEach(function (d) {
      var cb = el("input", { type: "checkbox", value: String(d) });
      cb.checked = days.indexOf(d) >= 0;
      box.appendChild(el("label", null, [cb, DAYS[d]]));
    });
  }
  function renderIconPreview() {
    var p = $("i-icon-preview");
    p.innerHTML = "";
    p.appendChild(H.iconEl($("i-icon").value.trim(), "ico"));
  }
  function openTileEditor(item) {
    editing.tile = item;
    $("item-title").textContent = item ? "Edit tile" : "Add tile";
    setBi("i-title", item && item.title); setBi("i-description", item && item.description);
    $("i-url").value = item ? item.url : "";
    setPasteMode(item && /\/forms\/embed\//.test(item.url) ? "embed" : "link", true);
    $("i-url").rows = 1;
    $("i-icon").value = item ? item.icon : "📋";
    $("i-code").value = item && item.code ? item.code : String(content.tiles.length + 1).padStart(2, "0");
    $("i-active").checked = item ? item.active : true;
    setOpenMode(item ? item.open : "embed");
    var sel = $("i-group");
    sel.innerHTML = "";
    sel.appendChild(el("option", { value: "", text: "No group" }));
    content.groups.forEach(function (g) { sel.appendChild(el("option", { value: g.id, text: g.title.en })); });
    sel.value = item ? item.groupId || "" : "";
    var s = item && item.schedule;
    $("i-sched-on").checked = Boolean(s);
    $("i-sched").hidden = !s;
    renderDays(s ? s.days : [1, 2, 3, 4, 5]);
    $("i-start").value = s ? s.start : "05:00";
    $("i-end").value = s ? s.end : "08:00";
    var hasPin = Boolean(item && item.hasPin);
    $("i-pin-on").checked = hasPin;
    $("i-pin-box").hidden = !hasPin;
    $("i-pin").value = "";
    $("i-pin-label").textContent = hasPin ? "New PIN (leave blank to keep the current one)" : "PIN (4–8 digits)";
    emojiRow($("i-emoji"), $("i-icon"));
    renderIconPreview();
    $("item-error").hidden = true;
    $("item-delete").hidden = !item;
    liveLinkHint($("i-url"), $("i-url-hint"), null);
    dlgItem.showModal();
  }
  $("i-icon").addEventListener("input", renderIconPreview);
  $("i-emoji").addEventListener("click", function () { setTimeout(renderIconPreview, 0); });
  $("i-icon-upload").addEventListener("click", function () { $("i-icon-file").click(); });
  $("i-icon-file").addEventListener("change", function () {
    var file = this.files[0];
    if (!file) return;
    var fd = new FormData();
    fd.append("image", file);
    $("i-icon-upload").disabled = true;
    api("POST", "/api/admin/images", fd).then(function (r) {
      $("i-icon").value = r.icon;
      emojiRow($("i-emoji"), $("i-icon"));
      renderIconPreview();
    }).catch(function (e) { $("item-error").textContent = e.message; $("item-error").hidden = false; })
      .finally(function () { $("i-icon-upload").disabled = false; $("i-icon-file").value = ""; });
  });
  $("i-url").addEventListener("input", function () {
    var v = $("i-url").value;
    if (/^\s*</.test(v) && pasteMode !== "embed") setPasteMode("embed", true); // embed code pasted into "Share link"
    liveLinkHint($("i-url"), $("i-url-hint"), setOpenMode);
  });
  $("i-url").addEventListener("keydown", function (ev) { if (ev.key === "Enter" && pasteMode === "link") ev.preventDefault(); });
  $("i-icon").addEventListener("input", function () { emojiRow($("i-emoji"), $("i-icon")); });
  $("i-sched-on").addEventListener("change", function () { $("i-sched").hidden = !this.checked; });
  $("i-pin-on").addEventListener("change", function () { $("i-pin-box").hidden = !this.checked; if (this.checked) $("i-pin").focus(); });
  $("item-form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var item = editing.tile;
    var err = $("item-error");
    var body = {
      title: getBi("i-title"), description: getBi("i-description"), url: $("i-url").value.trim(), icon: $("i-icon").value.trim(),
      open: (document.querySelector("input[name=i-open]:checked") || {}).value || "embed", active: $("i-active").checked,
      code: $("i-code").value.trim(), groupId: $("i-group").value, schedule: null,
    };
    if ($("i-sched-on").checked) {
      var days = Array.prototype.map.call(document.querySelectorAll("#i-days input:checked"), function (c) { return Number(c.value); });
      body.schedule = { days: days, start: $("i-start").value, end: $("i-end").value };
    }
    var pin = $("i-pin").value.trim();
    if ($("i-pin-on").checked) {
      if (pin) body.pin = pin;
      else if (!(item && item.hasPin)) { err.textContent = "Enter a PIN of 4 to 8 digits, or untick \"Ask for a PIN\"."; err.hidden = false; return; }
    } else if (item && item.hasPin) {
      body.clearPin = true;
    }
    $("item-save").disabled = true;
    api(item ? "PUT" : "POST", "/api/admin/tiles" + (item ? "/" + item.id : ""), body).then(function (saved) {
      dlgItem.close();
      var st = saved && saved.open === "embed" && saved.embedCheck && saved.embedCheck.status;
      if (st === "blocked" || st === "login" || st === "notfound") toast("Saved, but: " + checkText(saved.embedCheck, "hint"), true);
      else toast("Saved");
      return reload();
    }).catch(function (e) { err.textContent = e.message; err.hidden = false; })
      .finally(function () { $("item-save").disabled = false; });
  });
  $("item-delete").addEventListener("click", function () { deleteTile(editing.tile, function () { dlgItem.close(); }); });
  $("add-tile").addEventListener("click", function () { openTileEditor(null); });
  $("check-links").addEventListener("click", function () {
    var b = $("check-links");
    b.disabled = true; b.textContent = "Checking…";
    api("POST", "/api/admin/tiles/check", {}).then(function (tiles) {
      var bad = tiles.filter(function (t) { return t.open === "embed" && t.embedCheck && BAD.indexOf(t.embedCheck.status) >= 0; });
      toast(bad.length ? bad.length + (bad.length === 1 ? " tile needs" : " tiles need") + " attention — see the orange labels." : "All links checked.", bad.length > 0);
      return reload();
    }).catch(fail).finally(function () { b.disabled = false; b.textContent = "↻ Check links"; });
  });

  // Group editor
  var dlgGroup = $("dlg-group");
  function openGroupEditor(g) {
    editing.group = g;
    $("group-title").textContent = g ? "Edit group" : "Add group";
    setBi("g-title", g && g.title);
    $("group-error").hidden = true;
    $("group-delete").hidden = !g;
    dlgGroup.showModal();
  }
  $("group-form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var g = editing.group;
    api(g ? "PUT" : "POST", "/api/admin/groups" + (g ? "/" + g.id : ""), { title: getBi("g-title") }).then(function () {
      dlgGroup.close(); toast("Group saved"); return reload();
    }).catch(function (e) { $("group-error").textContent = e.message; $("group-error").hidden = false; });
  });
  $("group-delete").addEventListener("click", function () {
    var g = editing.group;
    api("DELETE", "/api/admin/groups/" + g.id).then(function (r) {
      dlgGroup.close();
      toast("Deleted group \"" + g.title.en + "\" (its tiles moved to No group)", false, { undo: r.undo });
      return reload();
    }).catch(fail);
  });
  $("add-group").addEventListener("click", function () { openGroupEditor(null); });

  // --- notes -------------------------------------------------------------------
  function noteStatus(n) {
    var t = H.today();
    if (!n.active) return { text: "Off", cls: "" };
    if (n.until && n.until < t) return { text: "Ended " + fmtDate(n.until), cls: "" };
    if (n.from && n.from > t) return { text: "Starts " + fmtDate(n.from), cls: "tag--accent" };
    return { text: "Showing now" + (n.until ? " · until " + fmtDate(n.until) : ""), cls: "tag--ok" };
  }
  function deleteNote(n, after) {
    api("DELETE", "/api/admin/notes/" + n.id).then(function (r) {
      if (after) after();
      toast("Deleted the note", false, { undo: r.undo });
      return reload();
    }).catch(fail);
  }
  function renderNotes() {
    var ul = $("notes-list");
    ul.innerHTML = "";
    if (!content.notes.length) ul.appendChild(el("li", { class: "empty-note", text: "No notes yet. Add one to show an announcement beside the greeting." }));
    content.notes.forEach(function (n) {
      var st = noteStatus(n);
      var styleTag = { info: "Info", important: "Important", success: "Good news" }[n.style] || "Info";
      ul.appendChild(el("li", { class: n.active ? "" : "inactive", "data-id": n.id }, [
        handle("note"),
        el("span", { class: "ico", "aria-hidden": "true", text: H.noteIcon(n.style) }),
        el("div", { class: "main" }, [
          el("strong", { text: n.title.en || n.body.en.slice(0, 60) }),
          el("div", { class: "tags" }, [el("span", { class: "tag " + st.cls, text: st.text }), el("span", { class: "tag", text: styleTag })]),
        ]),
        el("div", { class: "actions" }, [
          switchBtn(n.active, n.active ? "Switched on" : "Switched off", function () { api("PUT", "/api/admin/notes/" + n.id, { active: !n.active }).then(reload).catch(fail); }),
          actionBtn("Edit", "Edit note", function () { openNoteEditor(n); }),
          actionBtn("Delete", "Delete note", function () { deleteNote(n); }, { cls: "del" }),
        ]),
      ]));
    });
  }
  makeSortable($("notes-list"), function (order) { api("PUT", "/api/admin/notes/order", { ids: order }).then(reload).catch(fail); });
  var dlgNote = $("dlg-note");
  function openNoteEditor(n) {
    editing.note = n;
    $("note-title").textContent = n ? "Edit note" : "Add note";
    $("n-active").checked = n ? n.active : true;
    $("n-style").value = n ? n.style : "info";
    setBi("n-title", n && n.title); setBi("n-body", n && n.body);
    $("n-from").value = n ? n.from || "" : "";
    $("n-until").value = n ? n.until || "" : "";
    $("note-error").hidden = true;
    $("note-delete").hidden = !n;
    dlgNote.showModal();
  }
  $("note-form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var n = editing.note;
    var body = { active: $("n-active").checked, style: $("n-style").value, title: getBi("n-title"), body: getBi("n-body"), from: $("n-from").value, until: $("n-until").value };
    api(n ? "PUT" : "POST", "/api/admin/notes" + (n ? "/" + n.id : ""), body).then(function () {
      dlgNote.close(); toast("Note saved"); return reload();
    }).catch(function (e) { $("note-error").textContent = e.message; $("note-error").hidden = false; });
  });
  $("note-delete").addEventListener("click", function () { deleteNote(editing.note, function () { dlgNote.close(); }); });
  $("add-note").addEventListener("click", function () { openNoteEditor(null); });
  document.querySelectorAll("dialog [data-close]").forEach(function (b) { b.addEventListener("click", function () { b.closest("dialog").close(); }); });

  // --- activity: usage by hour, and the admin log --------------------------------
  function renderUsage() {
    if (!content) return;
    var sel = $("usage-tile");
    var current = sel.value;
    sel.innerHTML = "";
    sel.appendChild(el("option", { value: "", text: "All tiles" }));
    content.tiles.forEach(function (t) { sel.appendChild(el("option", { value: t.id, text: t.title.en })); });
    sel.value = current && content.tiles.some(function (t) { return t.id === current; }) ? current : "";
    var hours = new Array(24).fill(0);
    content.tiles.forEach(function (t) {
      if (sel.value && t.id !== sel.value) return;
      var u = stats.usage[t.id];
      if (u && u.hours30) u.hours30.forEach(function (n, i) { hours[i] += n; });
    });
    drawHourChart($("usage-chart"), hours);
    var tbody = $("usage-table").querySelector("tbody");
    tbody.innerHTML = "";
    var rows = content.tiles.map(function (t) { return { t: t, u: stats.usage[t.id] || { last7: 0, last30: 0, total: 0, lastAt: "" } }; })
      .sort(function (a, b) { return b.u.last30 - a.u.last30 || b.u.total - a.u.total; });
    if (!rows.length) tbody.appendChild(el("tr", null, [el("td", { colspan: "5", class: "hint", text: "No tiles yet." })]));
    rows.forEach(function (r) {
      tbody.appendChild(el("tr", null, [
        el("td", null, [H.iconEl(r.t.icon, "ico ico--sm"), " ", r.t.title.en]),
        el("td", { class: "num", text: String(r.u.last7) }),
        el("td", { class: "num", text: String(r.u.last30) }),
        el("td", { class: "num", text: String(r.u.total) }),
        el("td", { text: r.u.lastAt ? ago(r.u.lastAt) : "—" }),
      ]));
    });
  }
  $("usage-tile").addEventListener("change", renderUsage);

  /** 24 columns, one per hour. Single series: one accent colour, no legend; the panel title names it. */
  function drawHourChart(box, hours) {
    box.innerHTML = "";
    var max = Math.max.apply(null, hours);
    var total = hours.reduce(function (a, b) { return a + b; }, 0);
    if (!total) { box.appendChild(el("p", { class: "hint chart-empty", text: "No taps recorded by hour yet. The chart fills in as people use the kiosk." })); return; }
    var nice = max <= 5 ? 5 : max <= 10 ? 10 : Math.ceil(max / 10) * 10;
    var plot = el("div", { class: "hc-plot" });
    plot.appendChild(el("div", { class: "hc-grid", "aria-hidden": "true" }, [el("span", { text: String(nice) }), el("span", { text: String(nice / 2) }), el("span", { text: "0" })]));
    var cols = el("div", { class: "hc-cols" });
    var peak = hours.indexOf(max);
    hours.forEach(function (n, h) {
      var label = String(h).padStart(2, "0") + ":00–" + String((h + 1) % 24).padStart(2, "0") + ":00";
      var col = el("button", { type: "button", class: "hc-col", "aria-label": label + ": " + n + (n === 1 ? " tap" : " taps") });
      var bar = el("span", { class: "hc-bar" + (n ? "" : " hc-bar--zero") });
      bar.style.height = (n ? Math.max(2, (n / nice) * 100) : 0) + "%";
      if (h === peak && n) col.appendChild(el("span", { class: "hc-value", text: String(n) }));
      col.appendChild(bar);
      var show = function () { showTip(col, n + (n === 1 ? " tap" : " taps"), label); };
      col.addEventListener("pointerenter", show);
      col.addEventListener("focus", show);
      col.addEventListener("pointerleave", hideTip);
      col.addEventListener("blur", hideTip);
      cols.appendChild(col);
    });
    plot.appendChild(cols);
    box.appendChild(plot);
    var axis = el("div", { class: "hc-axis", "aria-hidden": "true" });
    for (var h = 0; h < 24; h++) axis.appendChild(el("span", { text: h % 3 === 0 ? String(h).padStart(2, "0") : "" }));
    box.appendChild(axis);
  }
  function showTip(anchor, value, label) {
    var tip = $("chart-tip");
    tip.innerHTML = "";
    tip.appendChild(el("strong", { text: value }));
    tip.appendChild(el("span", { text: label }));
    tip.hidden = false;
    var r = anchor.getBoundingClientRect(), tr = tip.getBoundingClientRect();
    var left = Math.min(Math.max(8, r.left + r.width / 2 - tr.width / 2), window.innerWidth - tr.width - 8);
    tip.style.left = left + "px";
    tip.style.top = (r.top + window.scrollY - tr.height - 8) + "px";
  }
  function hideTip() { $("chart-tip").hidden = true; }

  var activity = [];
  function loadActivity() {
    return api("GET", "/api/admin/activity?limit=500").then(function (rows) { activity = rows; renderActivity(); }).catch(fail);
  }
  function renderActivity() {
    var q = $("activity-filter").value.trim().toLowerCase();
    var tbody = $("activity-table").querySelector("tbody");
    tbody.innerHTML = "";
    var rows = activity.filter(function (e) { return !q || (e.name + " " + e.user + " " + e.action + " " + e.detail).toLowerCase().indexOf(q) >= 0; }).slice(0, 300);
    if (!rows.length) tbody.appendChild(el("tr", null, [el("td", { colspan: "4", class: "hint", text: q ? "Nothing matches." : "No activity yet." })]));
    rows.forEach(function (e) {
      var when = new Date(e.at);
      tbody.appendChild(el("tr", null, [
        el("td", { class: "nowrap", title: when.toLocaleString(), text: when.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " + when.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) }),
        el("td", { text: e.name }),
        el("td", { text: e.action }),
        el("td", { class: "detail", text: e.detail || "" }),
      ]));
    });
  }
  $("activity-filter").addEventListener("input", renderActivity);

  // --- kiosks: status, tile sets, layout, alerts -----------------------------------
  function deviceLabel(d) {
    if (d.scanner) return "Zebra " + (d.model || "scanner");
    var ua = d.ua || "";
    var kind = /iPad/.test(ua) ? "iPad" : /iPhone/.test(ua) ? "iPhone" : /Android/.test(ua) ? (/Mobile/.test(ua) ? "Android phone" : "Android tablet")
      : /Macintosh/.test(ua) ? (/Safari/.test(ua) && !/Chrome/.test(ua) ? "Mac or iPad" : "Mac") : /Windows/.test(ua) ? "Windows PC" : /CrOS/.test(ua) ? "Chromebook" : "Device";
    return kind + (d.model && d.model !== "K" ? " " + d.model : "");
  }
  function groupsText(d) {
    if (!Array.isArray(d.groups)) return "All tiles";
    if (!d.groups.length) return "Nothing";
    return d.groups.map(function (id) {
      if (id === "") return "No group";
      var g = content && content.groups.filter(function (x) { return x.id === id; })[0];
      return g ? g.title.en : null;
    }).filter(Boolean).join(", ") || "Nothing";
  }
  function renderKiosks() {
    var online = stats.devices.filter(function (d) { return Date.now() - new Date(d.lastSeen).getTime() < ONLINE_MS; });
    var badge = $("kiosk-status");
    badge.className = "kiosk-status " + (online.length ? "ok" : stats.devices.length ? "bad" : "");
    $("kiosk-status-text").textContent = online.length ? online.length + (online.length === 1 ? " kiosk online" : " kiosks online")
      : stats.devices.length ? "No kiosks online" : "No kiosks yet";
    var tbody = $("kiosks-table").querySelector("tbody");
    tbody.innerHTML = "";
    if (!stats.devices.length) {
      tbody.appendChild(el("tr", null, [el("td", { colspan: "6", class: "hint", text: "No kiosk has checked in yet. Open the kiosk page on the tablet and it will appear here within a minute." })]));
      return;
    }
    var put = function (d, body, msg) { return api("PUT", "/api/admin/devices/" + d.id, body).then(function () { Object.assign(d, body); if (msg) toast(msg); }).catch(fail); };
    stats.devices.forEach(function (d) {
      var isOn = Date.now() - new Date(d.lastSeen).getTime() < ONLINE_MS;
      var name = el("input", { type: "text", value: d.name || "", placeholder: deviceLabel(d) + " (add a name)", maxlength: "60", "aria-label": "Kiosk name" });
      name.addEventListener("blur", function () { if (name.value.trim() !== (d.name || "")) put(d, { name: name.value.trim() }, "Kiosk renamed"); });
      name.addEventListener("keydown", function (ev) { if (ev.key === "Enter") { ev.preventDefault(); name.blur(); } });
      var shows = el("button", { type: "button", class: "btn btn--ghost btn--small", text: groupsText(d) });
      shows.addEventListener("click", function () { openKioskDialog(d); });
      var layout = el("select", { "aria-label": "Layout" }, [["auto", "Automatic"], ["tiles", "Tiles"], ["list", "List"], ["scanner", "Scanner"]].map(function (o) { return el("option", { value: o[0], text: o[1] }); }));
      layout.value = d.layout || "auto";
      layout.addEventListener("change", function () { put(d, { layout: layout.value }, "Layout saved — the kiosk updates within a minute"); });
      var watch = el("input", { type: "checkbox", "aria-label": "Alert if this kiosk goes offline" });
      watch.checked = Boolean(d.watch);
      watch.addEventListener("change", function () { put(d, { watch: watch.checked }, watch.checked ? "You'll be alerted if it goes offline" : "Alerts off for this kiosk"); });
      tbody.appendChild(el("tr", null, [
        el("td", null, [name, el("small", { text: deviceLabel(d) + (d.screen ? " · " + d.screen : "") + (d.path && d.path !== "/kiosk" ? " · on " + d.path : "") })]),
        el("td", { class: "nowrap" }, [el("span", { class: "dot " + (isOn ? "ok" : "bad") }), " ", isOn ? "Online" : "Last seen " + ago(d.lastSeen), d.alertedAt ? el("small", { text: "Alert sent" }) : null]),
        el("td", null, [shows]),
        el("td", null, [layout]),
        el("td", null, [el("label", { class: "check" }, [watch, " Alert"])]),
        el("td", null, [actionBtn("Forget", "Forget this kiosk", function () {
          if (!confirm("Remove this kiosk from the list? It reappears if it checks in again, with its settings reset.")) return;
          api("DELETE", "/api/admin/devices/" + d.id).then(loadStats).catch(fail);
        }, { cls: "btn btn--ghost btn--small" })]),
      ]));
    });
  }
  var dlgKiosk = $("dlg-kiosk");
  function openKioskDialog(d) {
    editing.kiosk = d;
    $("kiosk-title").textContent = "Tiles on " + (d.name || deviceLabel(d));
    var some = Array.isArray(d.groups);
    document.querySelectorAll("input[name=k-mode]").forEach(function (r) { r.checked = r.value === (some ? "some" : "all"); });
    var box = $("k-groups");
    box.innerHTML = "";
    [{ id: "", title: { en: "Tiles without a group" } }].concat(content.groups).forEach(function (g) {
      var cb = el("input", { type: "checkbox", value: g.id });
      cb.checked = some && d.groups.indexOf(g.id) >= 0;
      box.appendChild(el("label", null, [cb, g.title.en]));
    });
    box.hidden = !some;
    $("kiosk-error").hidden = true;
    dlgKiosk.showModal();
  }
  document.querySelectorAll("input[name=k-mode]").forEach(function (r) { r.addEventListener("change", function () { $("k-groups").hidden = r.value === "all" && r.checked; }); });
  $("kiosk-form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var d = editing.kiosk;
    var mode = (document.querySelector("input[name=k-mode]:checked") || {}).value;
    var groups = mode === "some" ? Array.prototype.map.call(document.querySelectorAll("#k-groups input:checked"), function (c) { return c.value; }) : null;
    if (groups && !groups.length) { $("kiosk-error").textContent = "Tick at least one group, or choose All tiles."; $("kiosk-error").hidden = false; return; }
    api("PUT", "/api/admin/devices/" + d.id, { groups: groups }).then(function () { dlgKiosk.close(); toast("Saved — the kiosk updates within a minute"); return loadStats(); }).catch(fail);
  });
  $("kiosk-status").addEventListener("click", function () { showTab("settings"); $("kiosks-panel").scrollIntoView({ behavior: "smooth" }); });
  function loadStats() {
    return api("GET", "/api/admin/stats").then(function (s) {
      stats = s;
      renderKiosks();
      if (content) { renderTiles(); if (!$("tab-activity").hidden) renderUsage(); }
    }).catch(function () {});
  }

  // --- alerts ------------------------------------------------------------------
  function renderAlerts() {
    var a = content.settings.alerts;
    $("al-enabled").checked = a.enabled; $("al-offlineMinutes").value = a.offlineMinutes;
    $("al-notifyRecovery").checked = a.notifyRecovery !== false; $("al-linkProblems").checked = a.linkProblems !== false;
    $("al-mondayBoardId").value = a.mondayBoardId ? a.mondayBoardId : "";
    $("al-webhookUrl").value = a.webhookUrl || "";
    $("al-monday-hint").textContent = content.mondayToken ? "Each alert becomes a new item on this board, with the details as an update."
      : "Needs a monday.com API token: add MONDAY_API_TOKEN on Railway (monday.com → your avatar → Developers → My access tokens).";
    $("al-monday-hint").className = "hint" + (content.mondayToken || !a.mondayBoardId ? "" : " hint--warn");
  }
  function alertsBody() {
    return { alerts: {
      enabled: $("al-enabled").checked, offlineMinutes: Number($("al-offlineMinutes").value), notifyRecovery: $("al-notifyRecovery").checked,
      linkProblems: $("al-linkProblems").checked, mondayBoardId: $("al-mondayBoardId").value.trim(), webhookUrl: $("al-webhookUrl").value.trim(),
    } };
  }
  $("alerts-form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    api("PUT", "/api/admin/settings", alertsBody()).then(function () { toast("Alert settings saved"); return reload(); }).catch(fail);
  });
  $("al-test").addEventListener("click", function () {
    var b = $("al-test");
    b.disabled = true;
    api("PUT", "/api/admin/settings", alertsBody()).then(function () { return api("POST", "/api/admin/alerts/test", {}); }).then(function (r) {
      var bad = r.results.filter(function (x) { return !x.ok; });
      toast(bad.length ? "Not sent: " + bad.map(function (x) { return x.channel + " — " + x.error; }).join("; ") : "Test alert sent (" + r.results.map(function (x) { return x.channel; }).join(" and ") + ")", bad.length > 0);
      return reload();
    }).catch(fail).finally(function () { b.disabled = false; });
  });

  // --- admins and your account ---------------------------------------------------
  function renderMe() {
    $("me-btn").textContent = "👤 " + me.name;
    $("admins-panel").hidden = !isOwner();
    $("account-panel").hidden = isOwner();
    $("account-text").textContent = "Signed in as " + me.name + " (" + me.username + "). You can change everything except other admins and restoring backups.";
    document.querySelectorAll(".owner-only").forEach(function (x) { x.hidden = !isOwner(); });
    document.querySelector(".owner-hint").hidden = isOwner();
    if (isOwner()) loadAdmins();
    if (!$("tab-settings").hidden) loadBackups();
    if (me.mustChangePassword) openPasswordDialog(true);
  }
  $("me-btn").addEventListener("click", function () {
    if (isOwner()) { toast("You're the owner. Your password is ADMIN_PASSWORD on Railway."); return; }
    openPasswordDialog(false);
  });
  function loadAdmins() {
    return api("GET", "/api/admin/admins").then(function (list) {
      var tbody = $("admins-table").querySelector("tbody");
      tbody.innerHTML = "";
      tbody.appendChild(el("tr", null, [el("td", { text: "Owner" }), el("td", null, [el("code", { text: "admin" })]), el("td", { text: "—" }), el("td", { text: "Always" }), el("td", { class: "hint", text: "Password: ADMIN_PASSWORD on Railway" })]));
      list.forEach(function (a) {
        var active = switchBtn(a.active, a.active ? "Can sign in" : "Switched off", function () {
          api("PUT", "/api/admin/admins/" + a.id, { active: !a.active }).then(function () { toast(a.active ? a.name + " switched off and signed out" : a.name + " can sign in again"); return loadAdmins(); }).catch(fail);
        });
        tbody.appendChild(el("tr", null, [
          el("td", { text: a.name }),
          el("td", null, [el("code", { text: a.username }), a.mustChangePassword ? el("small", { text: "Hasn't chosen a password yet" }) : null]),
          el("td", { text: a.lastLoginAt ? ago(a.lastLoginAt) : "never" }),
          el("td", { class: "switch-cell" }, [active]),
          el("td", null, [
            actionBtn("New password", "Give " + a.name + " a new temporary password", function () {
              if (!confirm("Give " + a.name + " a new temporary password? Their current one stops working straight away.")) return;
              api("POST", "/api/admin/admins/" + a.id + "/reset", {}).then(function (r) { showTempPassword(r); return loadAdmins(); }).catch(fail);
            }, { cls: "btn btn--ghost btn--small" }),
            " ",
            actionBtn("Remove", "Remove " + a.name, function () {
              if (!confirm("Remove " + a.name + "'s login? Their past activity stays in the log.")) return;
              api("DELETE", "/api/admin/admins/" + a.id).then(function () { toast("Removed " + a.name); return loadAdmins(); }).catch(fail);
            }, { cls: "btn btn--danger btn--small" }),
          ]),
        ]));
      });
    }).catch(fail);
  }
  var dlgAdmin = $("dlg-admin");
  $("add-admin").addEventListener("click", function () {
    $("admin-title").textContent = "Add admin";
    $("admin-fields").hidden = false; $("admin-result").hidden = true;
    $("admin-save").hidden = false; $("admin-cancel").textContent = "Cancel";
    $("ad-name").value = ""; $("ad-username").value = "";
    $("admin-error").hidden = true;
    dlgAdmin.showModal();
  });
  $("ad-name").addEventListener("input", function () {
    if (!$("ad-username").dataset.touched) $("ad-username").value = $("ad-name").value.trim().toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.+|\.+$/g, "").slice(0, 40);
  });
  $("ad-username").addEventListener("input", function () { this.dataset.touched = "1"; });
  $("admin-form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    if ($("admin-fields").hidden) { dlgAdmin.close(); return; }
    api("POST", "/api/admin/admins", { name: $("ad-name").value.trim(), username: $("ad-username").value.trim() }).then(function (r) {
      delete $("ad-username").dataset.touched;
      showTempPassword(r);
      return loadAdmins();
    }).catch(function (e) { $("admin-error").textContent = e.message; $("admin-error").hidden = false; });
  });
  function showTempPassword(r) {
    $("admin-title").textContent = "Login details for " + r.admin.name;
    $("admin-fields").hidden = true; $("admin-result").hidden = false;
    $("ad-r-name").textContent = r.admin.name;
    $("ad-r-url").textContent = location.origin + "/admin";
    $("ad-r-user").textContent = r.admin.username;
    $("ad-r-pass").textContent = r.tempPassword;
    $("admin-save").hidden = true; $("admin-cancel").textContent = "Done";
    if (!dlgAdmin.open) dlgAdmin.showModal();
  }

  var dlgPassword = $("dlg-password");
  var passwordForced = false;
  function openPasswordDialog(forced) {
    if (dlgPassword.open) return;
    passwordForced = forced;
    $("password-title").textContent = forced ? "Choose your own password" : "Change your password";
    $("password-intro").textContent = forced ? "You signed in with a temporary password. Choose your own to continue." : "";
    $("password-close").hidden = forced;
    ["pw-current", "pw-next", "pw-again"].forEach(function (id) { $(id).value = ""; });
    $("password-error").hidden = true;
    dlgPassword.showModal();
  }
  dlgPassword.addEventListener("cancel", function (ev) { if (passwordForced) ev.preventDefault(); });
  $("password-form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var err = $("password-error");
    if ($("pw-next").value !== $("pw-again").value) { err.textContent = "The two new passwords don't match."; err.hidden = false; return; }
    api("PUT", "/api/admin/me/password", { current: $("pw-current").value, next: $("pw-next").value }).then(function () {
      dlgPassword.close();
      toast("Password changed");
      if (passwordForced) location.reload();
    }).catch(function (e) { err.textContent = e.message; err.hidden = false; });
  });
  $("change-password").addEventListener("click", function () { openPasswordDialog(false); });

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
      .catch(fail).finally(function () { $("logo-upload").disabled = false; });
  });
  $("logo-remove").addEventListener("click", function () {
    if (!confirm("Remove the logo?")) return;
    api("DELETE", "/api/admin/logo").then(function () { toast("Logo removed"); return reload(); }).catch(fail);
  });

  // --- appearance --------------------------------------------------------------
  var A_SELECTS = ["theme", "accentStyle", "cardStyle", "radius", "font", "tileSize", "tileColumns", "tileLayout", "hubNamePosition", "greetingStyle", "introPosition", "headerAlign", "clock"];
  function syncColour(textId, pickerId) {
    var text = $(textId), picker = $(pickerId);
    picker.addEventListener("input", function () { text.value = picker.value; });
    text.addEventListener("input", function () { if (/^#[0-9a-f]{6}$/i.test(text.value.trim())) picker.value = text.value.trim(); });
  }
  syncColour("a-accent", "a-accent-picker");
  syncColour("a-background", "a-background-picker");
  $("a-background-clear").addEventListener("click", function () { $("a-background").value = ""; });
  $("a-clock").addEventListener("change", function () { $("a-clockAmPm").disabled = this.value !== "12h"; });
  function renderAppearance() {
    var a = content.appearance;
    A_SELECTS.forEach(function (k) { $("a-" + k).value = a[k]; });
    $("a-accent").value = a.accent; $("a-accent-picker").value = a.accent;
    $("a-background").value = a.background || ""; $("a-background-picker").value = a.background || "#f8f8f8";
    $("a-showCodes").checked = a.showCodes !== false; $("a-showDate").checked = a.showDate !== false;
    $("a-clockAmPm").checked = Boolean(a.clockAmPm);
    $("a-clockAmPm").disabled = a.clock !== "12h";
  }
  $("appearance-form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var body = {};
    A_SELECTS.forEach(function (k) { body[k] = $("a-" + k).value; });
    body.accent = $("a-accent").value.trim(); body.background = $("a-background").value.trim();
    body.showCodes = $("a-showCodes").checked; body.showDate = $("a-showDate").checked;
    body.clockAmPm = $("a-clockAmPm").checked;
    api("PUT", "/api/admin/appearance", body).then(function () { toast("Appearance saved"); return reload(); }).catch(fail);
  });

  // --- hub settings ------------------------------------------------------------
  function renderSettings() {
    var s = content.settings;
    setBi("s-hubName", s.hubName); setBi("s-intro", s.intro); setBi("s-teamWord", s.teamWord);
    $("s-lang-es").checked = s.languages.indexOf("es") >= 0;
    $("s-defaultLang").value = s.defaultLang;
    $("s-showQr").checked = s.showQr !== false;
    $("s-idleReturnSeconds").value = s.idleReturnSeconds;
    $("s-screensaverSeconds").value = s.screensaverSeconds;
    $("s-publicUrl").value = s.publicUrl || "";
    $("s-lockdown").value = s.lockdown || "tablets";
    $("s-scannerMode").value = s.scannerMode || "auto";
    $("s-formQr").checked = s.formQr !== false;
    $("s-publicUrl-hint").textContent = "Currently the QR code points to " + content.publicUrl + (s.publicUrl ? "" : " (taken from the address this page was opened on). Set it here if the hub has a custom domain.");
  }
  $("settings-form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var body = {
      hubName: getBi("s-hubName"), intro: getBi("s-intro"), teamWord: getBi("s-teamWord"),
      languages: $("s-lang-es").checked ? ["en", "es"] : ["en"], defaultLang: $("s-defaultLang").value, showQr: $("s-showQr").checked,
      idleReturnSeconds: Number($("s-idleReturnSeconds").value), screensaverSeconds: Number($("s-screensaverSeconds").value),
      publicUrl: $("s-publicUrl").value.trim(), lockdown: $("s-lockdown").value, scannerMode: $("s-scannerMode").value, formQr: $("s-formQr").checked,
    };
    api("PUT", "/api/admin/settings", body).then(function () { toast("Settings saved"); return reload(); }).catch(fail);
  });

  // --- backups -------------------------------------------------------------------
  function fmtSize(b) { return b > 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB"; }
  function loadBackups() {
    return api("GET", "/api/admin/backups").then(function (list) {
      var tbody = $("backups-table").querySelector("tbody");
      tbody.innerHTML = "";
      if (!list.length) tbody.appendChild(el("tr", null, [el("td", { colspan: "3", class: "hint", text: "The first automatic backup is made a few minutes after the hub starts, then every night." })]));
      list.forEach(function (b) {
        var day = b.name.replace(/^auto-|\.zip$/g, "");
        var cells = [el("a", { class: "btn btn--ghost btn--small", href: "/api/admin/backups/" + encodeURIComponent(b.name), download: "", text: "⬇ Download" })];
        if (isOwner()) {
          cells.push(" ");
          cells.push(actionBtn("Restore", "Restore the backup from " + day, function () {
            if (!confirm("Replace ALL tiles, groups, notes, settings, images, kiosks and admin logins with the backup from " + fmtDate(day) + "?")) return;
            api("POST", "/api/admin/backups/" + encodeURIComponent(b.name) + "/restore", {}).then(function () { toast("Backup from " + fmtDate(day) + " restored"); return reload().then(loadStats); }).catch(fail);
          }, { cls: "btn btn--danger btn--small" }));
        }
        tbody.appendChild(el("tr", null, [
          el("td", { text: fmtDate(day) + " · made " + ago(b.at) }),
          el("td", { class: "num", text: fmtSize(b.size) }),
          el("td", null, cells),
        ]));
      });
    }).catch(fail);
  }
  $("backup-now").addEventListener("click", function () {
    var b = $("backup-now");
    b.disabled = true;
    api("POST", "/api/admin/backups/run", {}).then(function () { toast("Backup made"); return loadBackups(); }).catch(fail).finally(function () { b.disabled = false; });
  });
  $("backup-form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var file = $("restore-file").files[0];
    if (!file) return toast("Choose a backup zip first.", true);
    if (!confirm("Replace ALL tiles, groups, notes, settings, images, kiosks and admin logins with the contents of \"" + file.name + "\"?")) return;
    var fd = new FormData();
    fd.append("backup", file);
    $("restore-btn").disabled = true;
    api("POST", "/api/admin/restore", fd).then(function () {
      $("restore-file").value = "";
      toast("Backup restored");
      return reload().then(loadStats);
    }).catch(fail).finally(function () { $("restore-btn").disabled = false; });
  });

  // --- load --------------------------------------------------------------------
  var firstLoad = true;
  function reload() {
    return api("GET", "/api/admin/content").then(function (c) {
      content = c;
      if (!me) { me = c.me; renderMe(); }
      renderTiles(); renderNotes(); renderLogo(); renderAlerts(); renderAppearance(); renderSettings();
      if (!$("tab-activity").hidden) renderUsage();
      if (!firstLoad) refreshPreview();
      firstLoad = false;
    });
  }
  reload().then(loadStats).catch(fail);
  setInterval(loadStats, 30000);
  showTab((location.hash || "#tiles").slice(1));
})();
