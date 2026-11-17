/* Shared helpers for the kiosk pages: language, translations, icons, appearance, fetch. */
(function () {
  "use strict";

  var STR = {
    en: {
      openOnPhone: "Open on your phone", switchLang: "Cambiar a español",
      morning: "Good morning", afternoon: "Good afternoon", evening: "Good evening",
      comingSoon: "Coming soon", loading: "Loading…", couldNotLoad: "Could not load this right now.",
      backToHub: "Back to hub", openNewTab: "Open in new tab",
      returning: "Returning to the hub in {x}s", tapToStay: "Tap anywhere to keep working",
      noTools: "No tools have been added yet.", noToolsAdmin: "Sign in to the admin area to add your monday.com form links.",
      qrEyebrow: "Take it with you", qrTitle: "Scan to open the hub", qrPrint: "Print this code",
      qrAlt: "QR code linking to the employee hub", linkMissing: "This tool isn't set up yet. Please tell a lead.",
      notFound: "That tool no longer exists.", frameBlocked: "If the form doesn't appear here, open it in a new tab.",
    },
    es: {
      openOnPhone: "Abrir en su teléfono", switchLang: "Switch to English",
      morning: "Buenos días", afternoon: "Buenas tardes", evening: "Buenas noches",
      comingSoon: "Próximamente", loading: "Cargando…", couldNotLoad: "No se pudo cargar ahora.",
      backToHub: "Volver al portal", openNewTab: "Abrir en otra pestaña",
      returning: "Volviendo al portal en {x}s", tapToStay: "Toque en cualquier lugar para seguir",
      noTools: "Aún no se han agregado herramientas.", noToolsAdmin: "Inicie sesión en el área de administración para agregar los enlaces de formularios de monday.com.",
      qrEyebrow: "Llévelo con usted", qrTitle: "Escanee para abrir el portal", qrPrint: "Imprimir este código",
      qrAlt: "Código QR que abre el portal del empleado", linkMissing: "Esta herramienta aún no está lista. Avise a un líder.",
      notFound: "Esa herramienta ya no existe.", frameBlocked: "Si el formulario no aparece aquí, ábralo en otra pestaña.",
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

  /** Local date as YYYY-MM-DD on this device, for the note's "show until" date. */
  function today() {
    var d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  window.Hub = { t: t, pick: pick, icon: icon, noteIcon: function (s) { return NOTE_ICONS[s] || NOTE_ICONS.info; }, lang: lang, setLang: setLang, resolveLang: resolveLang,
    locale: locale, el: el, fetchJson: fetchJson, applyAppearance: applyAppearance, renderBrand: renderBrand, renderLangToggle: renderLangToggle, today: today };
})();
