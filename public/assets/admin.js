/* Admin area: tiles and groups, notes, settings (kiosks, logo, appearance, hub, backup). Talks to /api/admin/*. */
(function () {
  "use strict";
  var H = window.Hub;
  var el = H.el;
  var $ = function (id) { return document.getElementById(id); };
  var content = null;
  var stats = { usage: {}, devices: [] };
  var editing = { tile: null, group: null, note: null };

  var EMOJI = ["📋", "🔧", "🏖️", "🦺", "🔗", "📄", "🎥", "🛡️", "📅", "💵", "🎓", "📞", "🚛", "🚜", "📦", "⚠️", "✅", "⭐", "ℹ️", "💬", "🗺️", "👤", "🚩", "🔔", "🏠", "🔑", "✉️", "🧰", "📊", "🧊", "🍽️", "🩺", "🕒", "📣"];
  var DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var ONLINE_MS = 3 * 60 * 1000;

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
  var fail = function (e) { toast(e.message, true); };
  function refreshPreview() {
    var f = $("preview");
    try { f.contentWindow.location.reload(); } catch (e) { f.src = "/kiosk?" + Date.now(); }
  }

  // --- tabs --------------------------------------------------------------------
  var TABS = ["tiles", "notes", "settings"];
  function showTab(name) {
    if (TABS.indexOf(name) < 0) name = "tiles";
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
  function moveTile(tile, dir) {
    var sameGroup = content.tiles.filter(function (t) { return (t.groupId || "") === (tile.groupId || ""); });
    var i = sameGroup.indexOf(tile), other = sameGroup[i + dir];
    if (!other) return;
    var ids = content.tiles.map(function (t) { return t.id; });
    var a = ids.indexOf(tile.id), b = ids.indexOf(other.id);
    ids[a] = other.id; ids[b] = tile.id;
    api("PUT", "/api/admin/tiles/order", { ids: ids }).then(reload).catch(fail);
  }
  function moveGroup(i, dir) {
    var ids = content.groups.map(function (g) { return g.id; });
    var j = i + dir;
    if (j < 0 || j >= ids.length) return;
    var tmp = ids[i]; ids[i] = ids[j]; ids[j] = tmp;
    api("PUT", "/api/admin/groups/order", { ids: ids }).then(reload).catch(fail);
  }
  function tileRow(t, list) {
    var i = list.indexOf(t);
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
      actionBtn("↑", "Move up", function () { moveTile(t, -1); }, { disabled: i === 0 }),
      actionBtn("↓", "Move down", function () { moveTile(t, 1); }, { disabled: i === list.length - 1 }),
      actionBtn("Edit", "Edit " + t.title.en, function () { openTileEditor(t); }),
      actionBtn("Delete", "Delete " + t.title.en, function () {
        if (!confirm("Delete \"" + t.title.en + "\"? This can't be undone.")) return;
        api("DELETE", "/api/admin/tiles/" + t.id).then(function () { toast("Deleted"); return reload(); }).catch(fail);
      }, { cls: "del" }),
    ]);
    return el("li", { class: t.active ? "" : "inactive" }, [
      el("span", { class: "ico", "aria-hidden": "true", text: H.icon(t.icon) }),
      el("div", { class: "main" }, [el("strong", { text: t.title.en || "(untitled)" }), el("div", { class: "tags" }, tags)]),
      el("div", { class: "usage", title: u.total + " taps in total" + (u.lastAt ? ", last " + ago(u.lastAt) : "") }, [el("strong", { text: String(u.last30) }), "taps · 30 days"]),
      actions,
    ]);
  }
  function renderTiles() {
    var box = $("tiles-lists");
    box.innerHTML = "";
    if (!content.tiles.length && !content.groups.length) {
      box.appendChild(el("div", { class: "items frost" }, [el("p", { class: "empty-note", text: "No tiles yet. Add one for each monday.com form." })]));
      return;
    }
    var sections = [{ id: "", title: null }].concat(content.groups);
    sections.forEach(function (g, gi) {
      var list = content.tiles.filter(function (t) { return (t.groupId || "") === g.id; });
      if (!g.id && !list.length && content.groups.length) return;
      var block = el("div", { class: "group-block" });
      if (g.id) {
        var idx = gi - 1;
        block.appendChild(el("div", { class: "group-head" }, [
          el("h3", { text: g.title.en + (g.title.es ? "  ·  " + g.title.es : "") }),
          actionBtn("↑", "Move group up", function () { moveGroup(idx, -1); }, { disabled: idx === 0 }),
          actionBtn("↓", "Move group down", function () { moveGroup(idx, 1); }, { disabled: idx === content.groups.length - 1 }),
          actionBtn("Edit group", "Edit group " + g.title.en, function () { openGroupEditor(g); }),
        ]));
      } else if (content.groups.length) {
        block.appendChild(el("div", { class: "group-head" }, [el("h3", { text: "No group (shown first)" })]));
      }
      var ul = el("ul", { class: "items frost" });
      if (!list.length) ul.appendChild(el("li", { class: "empty-note", text: "No tiles in this group yet. Edit a tile and choose this group." }));
      list.forEach(function (t) { ul.appendChild(tileRow(t, list)); });
      block.appendChild(ul);
      box.appendChild(block);
    });
  }

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
    $("item-error").hidden = true;
    $("item-delete").hidden = !item;
    liveLinkHint($("i-url"), $("i-url-hint"), null);
    dlgItem.showModal();
  }
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
  $("item-delete").addEventListener("click", function () {
    if (!confirm("Delete this tile? This can't be undone.")) return;
    api("DELETE", "/api/admin/tiles/" + editing.tile.id).then(function () { dlgItem.close(); toast("Deleted"); return reload(); }).catch(fail);
  });
  $("add-tile").addEventListener("click", function () { openTileEditor(null); });
  $("check-links").addEventListener("click", function () {
    var b = $("check-links");
    b.disabled = true; b.textContent = "Checking…";
    api("POST", "/api/admin/tiles/check", {}).then(function (tiles) {
      var bad = tiles.filter(function (t) { return t.open === "embed" && t.embedCheck && ["blocked", "login", "notfound"].indexOf(t.embedCheck.status) >= 0; });
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
    if (!confirm("Delete this group? Its tiles are kept and move to \"No group\".")) return;
    api("DELETE", "/api/admin/groups/" + editing.group.id).then(function () { dlgGroup.close(); toast("Group deleted"); return reload(); }).catch(fail);
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
  function renderNotes() {
    var ul = $("notes-list");
    ul.innerHTML = "";
    if (!content.notes.length) ul.appendChild(el("li", { class: "empty-note", text: "No notes yet. Add one to show an announcement beside the greeting." }));
    content.notes.forEach(function (n, i) {
      var st = noteStatus(n);
      var styleTag = { info: "Info", important: "Important", success: "Good news" }[n.style] || "Info";
      var ids = content.notes.map(function (x) { return x.id; });
      var move = function (dir) {
        var j = i + dir; if (j < 0 || j >= ids.length) return;
        var tmp = ids[i]; ids[i] = ids[j]; ids[j] = tmp;
        api("PUT", "/api/admin/notes/order", { ids: ids }).then(reload).catch(fail);
      };
      ul.appendChild(el("li", { class: n.active ? "" : "inactive" }, [
        el("span", { class: "ico", "aria-hidden": "true", text: H.noteIcon(n.style) }),
        el("div", { class: "main" }, [
          el("strong", { text: n.title.en || n.body.en.slice(0, 60) }),
          el("div", { class: "tags" }, [el("span", { class: "tag " + st.cls, text: st.text }), el("span", { class: "tag", text: styleTag })]),
        ]),
        el("div", { class: "actions" }, [
          switchBtn(n.active, n.active ? "Switched on" : "Switched off", function () { api("PUT", "/api/admin/notes/" + n.id, { active: !n.active }).then(reload).catch(fail); }),
          actionBtn("↑", "Move up", function () { move(-1); }, { disabled: i === 0 }),
          actionBtn("↓", "Move down", function () { move(1); }, { disabled: i === content.notes.length - 1 }),
          actionBtn("Edit", "Edit note", function () { openNoteEditor(n); }),
          actionBtn("Delete", "Delete note", function () {
            if (!confirm("Delete this note?")) return;
            api("DELETE", "/api/admin/notes/" + n.id).then(function () { toast("Deleted"); return reload(); }).catch(fail);
          }, { cls: "del" }),
        ]),
      ]));
    });
  }
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
  $("note-delete").addEventListener("click", function () {
    if (!confirm("Delete this note?")) return;
    api("DELETE", "/api/admin/notes/" + editing.note.id).then(function () { dlgNote.close(); toast("Deleted"); return reload(); }).catch(fail);
  });
  $("add-note").addEventListener("click", function () { openNoteEditor(null); });
  document.querySelectorAll("dialog [data-close]").forEach(function (b) { b.addEventListener("click", function () { b.closest("dialog").close(); }); });

  // --- kiosks (heartbeat) ------------------------------------------------------
  function deviceLabel(d) {
    var ua = d.ua || "";
    var kind = /iPad/.test(ua) ? "iPad" : /iPhone/.test(ua) ? "iPhone" : /Android/.test(ua) ? (/Mobile/.test(ua) ? "Android phone" : "Android tablet")
      : /Macintosh/.test(ua) ? (/Safari/.test(ua) && !/Chrome/.test(ua) ? "Mac or iPad" : "Mac") : /Windows/.test(ua) ? "Windows PC" : /CrOS/.test(ua) ? "Chromebook" : "Device";
    return kind;
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
      tbody.appendChild(el("tr", null, [el("td", { colspan: "5", class: "hint", text: "No kiosk has checked in yet. Open the kiosk page on the tablet and it will appear here within a minute." })]));
      return;
    }
    stats.devices.forEach(function (d) {
      var isOn = Date.now() - new Date(d.lastSeen).getTime() < ONLINE_MS;
      var name = el("input", { type: "text", value: d.name || "", placeholder: deviceLabel(d) + " (add a name)", maxlength: "60", "aria-label": "Kiosk name" });
      var save = function () {
        if (name.value.trim() === (d.name || "")) return;
        api("PUT", "/api/admin/devices/" + d.id, { name: name.value }).then(function () { d.name = name.value.trim(); toast("Kiosk renamed"); }).catch(fail);
      };
      name.addEventListener("blur", save);
      name.addEventListener("keydown", function (ev) { if (ev.key === "Enter") { ev.preventDefault(); name.blur(); } });
      tbody.appendChild(el("tr", null, [
        el("td", null, [name, el("small", { text: deviceLabel(d) + (d.path && d.path !== "/kiosk" ? " · on " + d.path : "") })]),
        el("td", null, [el("span", { class: "dot " + (isOn ? "ok" : "bad") }), " ", isOn ? "Online" : "Last seen " + ago(d.lastSeen)]),
        el("td", { text: d.screen || "" }),
        el("td", { text: ago(d.firstSeen) }),
        el("td", null, [actionBtn("Forget", "Forget this kiosk", function () {
          if (!confirm("Remove this kiosk from the list? It reappears if it checks in again.")) return;
          api("DELETE", "/api/admin/devices/" + d.id).then(loadStats).catch(fail);
        }, { cls: "btn btn--ghost btn--small" })]),
      ]));
    });
  }
  $("kiosk-status").addEventListener("click", function () { showTab("settings"); $("kiosks-panel").scrollIntoView({ behavior: "smooth" }); });
  function loadStats() {
    return api("GET", "/api/admin/stats").then(function (s) {
      stats = s;
      renderKiosks();
      if (content) renderTiles();
    }).catch(function () {});
  }

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
  var A_SELECTS = ["theme", "accentStyle", "cardStyle", "radius", "font", "tileSize", "tileColumns", "hubNamePosition", "greetingStyle", "introPosition", "headerAlign", "clock"];
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
    $("s-publicUrl-hint").textContent = "Currently the QR code points to " + content.publicUrl + (s.publicUrl ? "" : " (taken from the address this page was opened on). Set it here if the hub has a custom domain.");
  }
  $("settings-form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var body = {
      hubName: getBi("s-hubName"), intro: getBi("s-intro"), teamWord: getBi("s-teamWord"),
      languages: $("s-lang-es").checked ? ["en", "es"] : ["en"], defaultLang: $("s-defaultLang").value, showQr: $("s-showQr").checked,
      idleReturnSeconds: Number($("s-idleReturnSeconds").value), screensaverSeconds: Number($("s-screensaverSeconds").value),
      publicUrl: $("s-publicUrl").value.trim(),
    };
    api("PUT", "/api/admin/settings", body).then(function () { toast("Settings saved"); return reload(); }).catch(fail);
  });

  // --- backup and restore ------------------------------------------------------
  $("backup-form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var file = $("restore-file").files[0];
    if (!file) return toast("Choose a backup zip first.", true);
    if (!confirm("Replace ALL tiles, groups, notes, settings and the logo with the contents of \"" + file.name + "\"?")) return;
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
      renderTiles(); renderNotes(); renderLogo(); renderAppearance(); renderSettings();
      if (!firstLoad) refreshPreview();
      firstLoad = false;
    });
  }
  reload().then(loadStats).catch(fail);
  setInterval(loadStats, 30000);
  showTab((location.hash || "#tiles").slice(1));
})();
