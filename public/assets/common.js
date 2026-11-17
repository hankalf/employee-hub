/* Shared helpers for the kiosk pages: language, translations, icons, appearance, fetch. */
(function () {
  "use strict";

  var STR = {
    en: {
      openOnPhone: "Open on your phone", switchLang: "Cambiar a español",
      morning: "Good morning", afternoon: "Good afternoon", evening: "Good evening",
      comingSoon: "Coming soon", loading: "Loading…", couldNotLoad: "Could not load this right now.",
      backToHub: "Back to hub", openNewTab: "Open in new tab", openFull: "Open full screen",
      returning: "Returning to the hub in {x}s", tapToStay: "Tap anywhere to keep working",
      noTools: "No tools have been added yet.", noToolsAdmin: "Sign in to the admin area to add your monday.com form links.",
      qrEyebrow: "Take it with you", qrTitle: "Scan to open the hub", qrPrint: "Print this code",
      qrAlt: "QR code linking to the employee hub", linkMissing: "This tool isn't set up yet. Please tell a lead.",
      notFound: "That tool no longer exists.", frameBlocked: "If the form doesn't appear, tap \"Open full screen\" at the top.",
      leadsOnly: "Leads only", pinFor: "Enter the PIN for {x}", pinWrong: "Incorrect PIN. Try again.",
      pinLocked: "Too many tries. Please wait 15 minutes.", pinExpired: "Please enter the PIN again.", cancel: "Cancel", open: "Open",
      tapToStart: "Tap anywhere to start",
      onPhone: "On your phone", phoneTitle: "Fill this in on your phone", phoneBody: "Scan the code with your phone's camera to open this form there and free up the kiosk.", close: "Close",
    },
    es: {
      openOnPhone: "Abrir en su teléfono", switchLang: "Switch to English",
      morning: "Buenos días", afternoon: "Buenas tardes", evening: "Buenas noches",
      comingSoon: "Próximamente", loading: "Cargando…", couldNotLoad: "No se pudo cargar ahora.",
      backToHub: "Volver al portal", openNewTab: "Abrir en otra pestaña", openFull: "Abrir en pantalla completa",
      returning: "Volviendo al portal en {x}s", tapToStay: "Toque en cualquier lugar para seguir",
      noTools: "Aún no se han agregado herramientas.", noToolsAdmin: "Inicie sesión en el área de administración para agregar los enlaces de formularios de monday.com.",
      qrEyebrow: "Llévelo con usted", qrTitle: "Escanee para abrir el portal", qrPrint: "Imprimir este código",
      qrAlt: "Código QR que abre el portal del empleado", linkMissing: "Esta herramienta aún no está lista. Avise a un líder.",
      notFound: "Esa herramienta ya no existe.", frameBlocked: "Si el formulario no aparece, toque \"Abrir en pantalla completa\" arriba.",
      leadsOnly: "Solo líderes", pinFor: "Ingrese el PIN de {x}", pinWrong: "PIN incorrecto. Intente de nuevo.",
      pinLocked: "Demasiados intentos. Espere 15 minutos.", pinExpired: "Ingrese el PIN de nuevo.", cancel: "Cancelar", open: "Abrir",
      tapToStart: "Toque en cualquier lugar para comenzar",
      onPhone: "En su teléfono", phoneTitle: "Llénelo en su teléfono", phoneBody: "Escanee el código con la cámara de su teléfono para abrir este formulario ahí y dejar libre el quiosco.", close: "Cerrar",
    },
  };

  // Names used by the original hub (and a few friendly aliases) → emoji. Anything else is shown as typed.
  var ICONS = {
    link: "🔗", Link: "🔗", document: "📄", Document: "📄", video: "🎥", Video: "🎥", safety: "🛡️", Safety: "🛡️",
    schedule: "📅", Schedule: "📅", payroll: "💵", Payroll: "💵", training: "🎓", Training: "🎓", contact: "📞", Contact: "📞",
    board: "📊", clipboard: "📋", wrench: "🔧", calendar: "📅", hardhat: "🦺", forklift: "🚜", truck: "🚛", alert: "⚠️",
    info: "ℹ️", star: "⭐", chat: "💬", map: "🗺️", user: "👤", check: "✅", flag: "🚩", bell: "🔔", home: "🏠", key: "🔑",
    mail: "✉️", tools: "🧰", pto: "🏖️", gear: "🦺",
  };
  var NOTE_ICONS = { info: "ℹ️", important: "📣", success: "✅" };

  var LANG_KEY = "hub-lang";
  var current = null;

  function lang() {
    if (current) return current;
    try { current = localStorage.getItem(LANG_KEY) || ""; } catch (e) { current = ""; }
    return current;
  }
  function setLang(l) {
    current = l;
    try { localStorage.setItem(LANG_KEY, l); } catch (e) { /* private mode */ }
    document.documentElement.lang = l;
  }
  /** Pick the language to show: saved choice if the hub offers it, otherwise the hub's default. */
  function resolveLang(settings) {
    var langs = (settings && settings.languages) || ["en"];
    var saved = lang();
    var l = langs.indexOf(saved) >= 0 ? saved : (settings && settings.defaultLang) || langs[0];
    setLang(l);
    return l;
  }
  function t(key, x) {
    var d = STR[lang()] || STR.en;
    var s = d[key] != null ? d[key] : STR.en[key] || key;
    return s.replace("{x}", x == null ? "" : String(x));
  }
  /** Admin-entered bilingual text: {en, es}. Falls back to English. */
  function pick(obj) {
    if (!obj) return "";
    if (typeof obj === "string") return obj;
    return obj[lang()] || obj.en || "";
  }
  function icon(name) {
    var s = (name || "").trim();
    return ICONS[s] || s || "🔗";
  }
  function locale() { return lang() === "es" ? "es-US" : "en-US"; }
  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === "class") e.className = attrs[k];
      else if (k === "text") e.textContent = attrs[k];
      else if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) e.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return e;
  }
  function fetchJson(url) {
    return fetch(url, { cache: "no-store" }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var err = new Error(j.error || ("HTTP " + r.status)); err.status = r.status; throw err; }
        return j;
      });
    });
  }

  /** Apply the admin's appearance settings to the page. */
  function applyAppearance(a) {
    a = a || {};
    var root = document.documentElement;
    root.classList.toggle("theme-light", a.theme === "light");
    root.classList.toggle("theme-dark", a.theme === "dark");
    root.setAttribute("data-cards", a.cardStyle || "frosted");
    root.setAttribute("data-radius", a.radius || "round");
    root.setAttribute("data-font", a.font || "system");
    root.setAttribute("data-tiles", a.tileSize || "large");
    if (a.accent) root.style.setProperty("--accent", a.accent); else root.style.removeProperty("--accent");
    if (a.accentStyle === "solid" && a.accent) root.style.setProperty("--spectrum", a.accent); else root.style.removeProperty("--spectrum");
    if (a.background) root.style.setProperty("--bg", a.background); else root.style.removeProperty("--bg");
    var cols = String(a.tileColumns || "auto");
    if (/^\d+$/.test(cols)) root.style.setProperty("--tile-cols", "repeat(" + cols + ", 1fr)"); else root.style.removeProperty("--tile-cols");
  }

  /** Logo (if uploaded) or the accent pill, plus the hub name, inside a .brand link. */
  function renderBrand(container, hub) {
    container.innerHTML = "";
    var name = pick(hub.settings.hubName) || "Employee Hub";
    if (hub.logo) container.appendChild(el("img", { class: "brand-logo", src: "/logo?v=" + encodeURIComponent(hub.logo), alt: "" }));
    else container.appendChild(el("span", { class: "pill spectrum", "aria-hidden": "true" }));
    container.appendChild(el("span", { class: "brand-name", text: name }));
    container.setAttribute("aria-label", name);
  }

  /** The EN/ES switch in the top bar. Only shown when more than one language is enabled. */
  function renderLangToggle(container, settings, onChange) {
    container.innerHTML = "";
    var langs = (settings && settings.languages) || ["en"];
    if (langs.length < 2) { container.hidden = true; return; }
    container.hidden = false;
    container.setAttribute("aria-label", t("switchLang"));
    langs.forEach(function (l) {
      var b = el("button", { type: "button", "aria-pressed": String(l === lang()), text: l.toUpperCase() });
      b.addEventListener("click", function () { if (l !== lang()) { setLang(l); onChange(); } });
      container.appendChild(b);
    });
  }

  /** Local date as YYYY-MM-DD on this device, for note dates and tile schedules. */
  function today() {
    var d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  /** Notes that are switched on and inside their date range right now. */
  function currentNotes(notes) {
    var t = today();
    return (notes || []).filter(function (n) {
      return n.active && (!n.from || n.from <= t) && (!n.until || n.until >= t) && (pick(n.title) || pick(n.body));
    });
  }
  /** Is a scheduled tile available at this moment on this device's clock? */
  function tileAvailable(t) {
    var s = t.schedule;
    if (!s) return true;
    var now = new Date();
    var day = now.getDay(), hm = String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0");
    var onDay = s.days.indexOf(day) >= 0, onPrevDay = s.days.indexOf((day + 6) % 7) >= 0;
    if (s.start < s.end) return onDay && hm >= s.start && hm < s.end;
    return (onDay && hm >= s.start) || (onPrevDay && hm < s.end); // overnight window
  }
  /** A random id for this device, kept in localStorage, so the admin can see which kiosks are online. */
  function deviceId() {
    var id = "";
    try { id = localStorage.getItem("hub-device") || ""; } catch (e) { /* private mode */ }
    if (!/^[a-f0-9]{16,32}$/.test(id)) {
      var a = new Uint8Array(12);
      (window.crypto || {}).getRandomValues ? crypto.getRandomValues(a) : a.forEach(function (_, i) { a[i] = Math.floor(Math.random() * 256); });
      id = Array.prototype.map.call(a, function (b) { return b.toString(16).padStart(2, "0"); }).join("");
      try { localStorage.setItem("hub-device", id); } catch (e) { /* ignore */ }
    }
    return id;
  }
  // --- Zebra handheld scanners -------------------------------------------------------
  // Zebra models: TC21/TC26, TC52/TC57/TC58, TC72/TC77, TC8300, MC2200/MC3300/MC9300, EC50/EC55, ET40/ET45, WT6300, CC600…
  var ZEBRA_RE = /\b(?:TC[1-9]\d(?:\d{2})?|MC[2-9]\d{1,3}|EC[3-5]\d|ET[4-8]\d|WT6\d{3}|CC6\d{2,3}|PS20|HC[25]0)[A-Za-z]{0,3}\b|Zebra|EnterpriseBrowser/;
  var scannerInfo = (function () {
    var cached = null;
    try { cached = JSON.parse(localStorage.getItem("hub-scanner") || "null"); } catch (e) { /* ignore */ }
    var m = ZEBRA_RE.exec(navigator.userAgent);
    if (m) return { scanner: true, model: m[0] };
    return cached && typeof cached.scanner === "boolean" ? cached : { scanner: false, model: "" };
  })();
  /**
   * Recent Chrome hides the device model in the user agent ("Android 10; K"), so ask for it through
   * User-Agent Client Hints. Calls back with true when the answer changed what we thought.
   */
  function detectScanner(onChange) {
    var uad = navigator.userAgentData;
    if (!uad || !uad.getHighEntropyValues) return;
    uad.getHighEntropyValues(["model"]).then(function (v) {
      var model = String((v && v.model) || "");
      var next = { scanner: ZEBRA_RE.test(model) || ZEBRA_RE.test(navigator.userAgent), model: model || scannerInfo.model };
      var changed = next.scanner !== scannerInfo.scanner || next.model !== scannerInfo.model;
      scannerInfo = next;
      try { localStorage.setItem("hub-scanner", JSON.stringify(next)); } catch (e) { /* ignore */ }
      if (changed && onChange) onChange();
    }).catch(function () {});
  }

  // ?layout=scanner|list|tiles on the address forces a layout on this device (remembered); ?layout=auto clears it.
  (function rememberLayoutParam() {
    var p = new URLSearchParams(location.search).get("layout");
    if (!p) return;
    try {
      if (p === "auto") localStorage.removeItem("hub-layout");
      else if (["tiles", "list", "scanner"].indexOf(p) >= 0) localStorage.setItem("hub-layout", p);
    } catch (e) { /* ignore */ }
  })();

  /** Which layout this device uses: address override > admin's choice for this kiosk > Zebra detection > Appearance. */
  function resolveLayout(hub) {
    var forced = "";
    try { forced = localStorage.getItem("hub-layout") || ""; } catch (e) { /* ignore */ }
    if (["tiles", "list", "scanner"].indexOf(forced) >= 0) return forced;
    var dev = hub.device && hub.device.layout;
    if (["tiles", "list", "scanner"].indexOf(dev) >= 0) return dev;
    if (hub.settings.scannerMode !== "off" && scannerInfo.scanner) return "scanner";
    return (hub.appearance && hub.appearance.tileLayout) || "tiles";
  }
  function applyLayout(layout) {
    var root = document.documentElement;
    ["tiles", "list", "scanner"].forEach(function (l) { root.classList.toggle("layout-" + l, l === layout); });
    return layout;
  }

  function heartbeat() {
    var body = JSON.stringify({ deviceId: deviceId(), screen: window.innerWidth + "x" + window.innerHeight, path: location.pathname, model: scannerInfo.model, scanner: scannerInfo.scanner });
    fetch("/api/heartbeat", { method: "POST", headers: { "Content-Type": "text/plain" }, body: body, keepalive: true }).catch(function () {});
  }
  function startHeartbeat() {
    heartbeat();
    setInterval(heartbeat, 60000);
  }
  function countTap(id) {
    fetch("/api/tap/" + encodeURIComponent(id) + "?h=" + new Date().getHours(), { method: "POST", keepalive: true }).catch(function () {});
  }

  /** A tile icon: an uploaded image ("img:icon-ab12.png") or an emoji. */
  function iconEl(icon, cls) {
    var s = String(icon || "");
    if (/^img:icon-[a-z0-9-]+\.(png|jpe?g|gif|webp|svg)$/.test(s)) {
      return el("span", { class: cls + " has-img", "aria-hidden": "true" }, [el("img", { src: "/img/" + s.slice(4), alt: "", draggable: "false" })]);
    }
    return el("span", { class: cls, "aria-hidden": "true", text: ICONS[s] || s || "🔗" });
  }

  var phone = /iPhone|iPod|Android.*Mobile|Windows Phone|Mobile.*Firefox/i.test(navigator.userAgent);

  /**
   * Kiosk mode for wall tablets and computers: keep the screen awake and block the gestures people
   * trigger by accident (pinch-zoom, double-tap zoom, text selection, long-press menus, dragging images).
   */
  var kioskOn = false;
  var wakeLock = null;
  function requestWake() {
    if (!kioskOn || document.visibilityState !== "visible" || !("wakeLock" in navigator) || wakeLock) return;
    navigator.wakeLock.request("screen").then(function (l) {
      wakeLock = l;
      l.addEventListener("release", function () { wakeLock = null; });
    }).catch(function () { /* not allowed yet (e.g. needs a tap first) */ });
  }
  function block(ev) { if (kioskOn) ev.preventDefault(); }
  function applyKioskMode(settings, device) {
    var mode = (settings && settings.lockdown) || "tablets";
    var on = mode === "named" ? Boolean(device && device.named) : mode === "tablets" ? !phone : false;
    kioskOn = on;
    document.documentElement.classList.toggle("kiosk-lock", on);
    if (on) requestWake();
    else if (wakeLock) { wakeLock.release().catch(function () {}); wakeLock = null; }
  }
  document.addEventListener("visibilitychange", requestWake);
  document.addEventListener("pointerdown", requestWake, { passive: true });
  document.addEventListener("contextmenu", block);
  document.addEventListener("dragstart", block);
  document.addEventListener("gesturestart", block);   // Safari pinch
  document.addEventListener("gesturechange", block);
  document.addEventListener("touchmove", function (ev) { if (kioskOn && ev.touches && ev.touches.length > 1) ev.preventDefault(); }, { passive: false });
  document.addEventListener("wheel", function (ev) { if (kioskOn && ev.ctrlKey) ev.preventDefault(); }, { passive: false }); // trackpad / ctrl+wheel zoom
  document.addEventListener("keydown", function (ev) { if (kioskOn && (ev.ctrlKey || ev.metaKey) && /^[-+=0]$/.test(ev.key)) ev.preventDefault(); });

  /** "07:44" (12-hour, as XX:XX), "19:44" (24-hour), optionally with AM/PM. Returns { hm, ampm }. */
  function clockParts(date, mode, withAmPm) {
    var h = date.getHours(), m = String(date.getMinutes()).padStart(2, "0");
    if (mode === "24h") return { hm: String(h).padStart(2, "0") + ":" + m, ampm: "" };
    var h12 = h % 12 || 12;
    return { hm: String(h12).padStart(2, "0") + ":" + m, ampm: withAmPm ? (h < 12 ? "AM" : "PM") : "" };
  }

  /** Is the hub itself being shown inside another site's frame (e.g. a monday.com board view)? */
  var framed = (function () { try { return window.self !== window.top; } catch (e) { return true; } })();

  window.Hub = { framed: framed, clockParts: clockParts, t: t, pick: pick, icon: icon, noteIcon: function (s) { return NOTE_ICONS[s] || NOTE_ICONS.info; }, lang: lang, setLang: setLang, resolveLang: resolveLang,
    locale: locale, el: el, fetchJson: fetchJson, applyAppearance: applyAppearance, renderBrand: renderBrand, renderLangToggle: renderLangToggle, today: today,
    currentNotes: currentNotes, tileAvailable: tileAvailable, startHeartbeat: startHeartbeat, countTap: countTap,
    deviceId: deviceId, iconEl: iconEl, applyKioskMode: applyKioskMode, isPhone: phone,
    detectScanner: detectScanner, resolveLayout: resolveLayout, applyLayout: applyLayout, scanner: function () { return scannerInfo; } };
})();
