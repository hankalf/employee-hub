"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { JsonFile } = require("./jsonfile");
const { normalizeUrl, describeLink } = require("./links");

const SEED = path.join(__dirname, "..", "seed", "content.json");

const LANGS = ["en", "es"];
const OPEN_MODES = ["embed", "tab"];
const NOTE_STYLES = ["info", "important", "success"];
const THEMES = ["auto", "light", "dark"];
const ACCENT_STYLES = ["spectrum", "solid"];
const CARD_STYLES = ["frosted", "solid", "outline"];
const RADII = ["round", "soft", "square"];
const FONTS = ["system", "rounded", "serif"];
const TILE_SIZES = ["large", "medium", "compact"];
const TILE_COLUMNS = ["auto", "2", "3", "4", "5"];

const DEFAULT_SETTINGS = {
  hubName: { en: "Employee Hub", es: "Portal del Empleado" },
  intro: { en: "Tap a tool to get started. Every submission goes straight to the right people.",
    es: "Toque una herramienta para comenzar. Cada envío llega directo a las personas correctas." },
  teamWord: { en: "team", es: "equipo" },
  languages: ["en", "es"],
  defaultLang: "en",
  idleReturnSeconds: 300,
  publicUrl: "",
  showQr: true,
};

const DEFAULT_NOTE = { active: false, style: "info", title: { en: "", es: "" }, body: { en: "", es: "" }, until: "" };

const DEFAULT_APPEARANCE = {
  theme: "auto", accentStyle: "spectrum", accent: "#0358f7", background: "",
  cardStyle: "frosted", radius: "round", font: "system", tileSize: "large", tileColumns: "auto",
  showCodes: true, showDate: true, showIntro: true,
};

class ValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const newId = () => crypto.randomBytes(5).toString("base64url");

function str(v, max, label) {
  if (v == null) return "";
  if (typeof v !== "string") throw new ValidationError(`${label} must be text.`);
  const s = v.trim();
  if (s.length > max) throw new ValidationError(`${label} can be at most ${max} characters.`);
  return s;
}

/** Text in English and Spanish. Accepts a plain string (English) or {en, es}. */
function bilingual(v, max, label, { required = false } = {}) {
  const o = typeof v === "string" ? { en: v } : v && typeof v === "object" ? v : {};
  const out = { en: str(o.en, max, label), es: str(o.es, max, label) };
  if (required && !out.en) throw new ValidationError(`${label} (English) is required.`);
  return out;
}

function int(v, min, max, dflt, label) {
  if (v == null || v === "") return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new ValidationError(`${label} must be a whole number between ${min} and ${max}.`);
  return n;
}

const bool = (v, dflt) => (v == null ? dflt : Boolean(v));

function oneOf(v, options, dflt, label) {
  if (v == null || v === "") return dflt;
  if (!options.includes(String(v))) throw new ValidationError(`${label} must be one of: ${options.join(", ")}.`);
  return String(v);
}

function hexColour(v, dflt, label, { allowEmpty = false } = {}) {
  const s = str(v, 9, label).toLowerCase();
  if (!s) {
    if (allowEmpty) return "";
    return dflt;
  }
  if (!/^#[0-9a-f]{6}$/.test(s)) throw new ValidationError(`${label} must be a colour like #0358f7.`);
  return s;
}

function ymd(v, label) {
  const s = str(v, 10, label);
  if (!s) return "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) throw new ValidationError(`${label} must be a date (YYYY-MM-DD).`);
  return s;
}

function url(v, label, allowEmpty) {
  try { return normalizeUrl(v, { allowEmpty }); } catch (e) { throw new ValidationError(`${label}: ${e.message}`); }
}

function validateTile(input, existing = {}) {
  return {
    id: existing.id || newId(),
    title: bilingual(input.title, 80, "Title", { required: true }),
    description: bilingual(input.description, 200, "Description"),
    icon: str(input.icon, 40, "Icon") || "link",
    url: url(input.url, "Link", true),
    open: oneOf(input.open, OPEN_MODES, "embed", "Open mode"),
    active: bool(input.active, true),
    code: str(input.code, 6, "Code"),
  };
}

function validateSettings(input, current) {
  const s = { ...DEFAULT_SETTINGS, ...current };
  if (input.hubName !== undefined) s.hubName = bilingual(input.hubName, 60, "Hub name", { required: true });
  if (input.intro !== undefined) s.intro = bilingual(input.intro, 200, "Intro");
  if (input.teamWord !== undefined) s.teamWord = bilingual(input.teamWord, 40, "Greeting word");
  if (input.languages !== undefined) {
    const arr = Array.isArray(input.languages) ? input.languages : [input.languages];
    const langs = arr.map((l) => String(l)).filter((l) => LANGS.includes(l));
    if (!langs.includes("en")) langs.unshift("en");
    s.languages = LANGS.filter((l) => langs.includes(l));
  }
  if (input.defaultLang !== undefined) s.defaultLang = oneOf(input.defaultLang, LANGS, "en", "Default language");
  if (!s.languages.includes(s.defaultLang)) s.defaultLang = s.languages[0];
  if (input.idleReturnSeconds !== undefined) s.idleReturnSeconds = int(input.idleReturnSeconds, 0, 3600, 300, "Return to home after");
  if (input.publicUrl !== undefined) s.publicUrl = url(input.publicUrl, "Public address", true);
  if (input.showQr !== undefined) s.showQr = Boolean(input.showQr);
  return s;
}

/** The note shown beside the greeting on the kiosk. */
function validateNote(input) {
  const i = input && typeof input === "object" ? input : {};
  return {
    active: bool(i.active, false),
    style: oneOf(i.style, NOTE_STYLES, "info", "Note style"),
    title: bilingual(i.title, 80, "Note title"),
    body: bilingual(i.body, 600, "Note text"),
    until: ymd(i.until, "Show until"),
  };
}

function validateAppearance(input, current) {
  const i = input && typeof input === "object" ? input : {};
  const a = { ...DEFAULT_APPEARANCE, ...(current || {}) };
  if (i.theme !== undefined) a.theme = oneOf(i.theme, THEMES, "auto", "Theme");
  if (i.accentStyle !== undefined) a.accentStyle = oneOf(i.accentStyle, ACCENT_STYLES, "spectrum", "Accent style");
  if (i.accent !== undefined) a.accent = hexColour(i.accent, DEFAULT_APPEARANCE.accent, "Accent colour");
  if (i.background !== undefined) a.background = hexColour(i.background, "", "Background colour", { allowEmpty: true });
  if (i.cardStyle !== undefined) a.cardStyle = oneOf(i.cardStyle, CARD_STYLES, "frosted", "Card style");
  if (i.radius !== undefined) a.radius = oneOf(i.radius, RADII, "round", "Corners");
  if (i.font !== undefined) a.font = oneOf(i.font, FONTS, "system", "Font");
  if (i.tileSize !== undefined) a.tileSize = oneOf(i.tileSize, TILE_SIZES, "large", "Tile size");
  if (i.tileColumns !== undefined) a.tileColumns = oneOf(i.tileColumns, TILE_COLUMNS, "auto", "Tiles per row");
  if (i.showCodes !== undefined) a.showCodes = Boolean(i.showCodes);
  if (i.showDate !== undefined) a.showDate = Boolean(i.showDate);
  if (i.showIntro !== undefined) a.showIntro = Boolean(i.showIntro);
  return a;
}

/**
 * Everything the hub shows is kept in content.json inside DATA_DIR, with the
 * logo in DATA_DIR/uploads. On Railway, DATA_DIR should be a mounted Volume so
 * both survive redeploys.
 */
class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.contentPath = path.join(dataDir, "content.json");
    this.uploadsDir = path.join(dataDir, "uploads");
    this.file = new JsonFile(this.contentPath, {});
  }

  init() {
    fs.mkdirSync(this.uploadsDir, { recursive: true });
    if (!fs.existsSync(this.contentPath)) {
      fs.copyFileSync(SEED, this.contentPath);
      console.log(`Seeded starter content into ${this.dataDir}`);
    }
    const c = this.file.load();
    c.tiles = Array.isArray(c.tiles) ? c.tiles : [];
    c.settings = { ...DEFAULT_SETTINGS, ...(c.settings || {}) };
    c.note = { ...DEFAULT_NOTE, ...(c.note || {}) };
    c.appearance = { ...DEFAULT_APPEARANCE, ...(c.appearance || {}) };
    c.logo = typeof c.logo === "string" ? c.logo : "";
    // Leftovers from the earlier version with board panels and quick links.
    delete c.panels;
    delete c.links;
    delete c.optionLabels;
    delete c.settings.timeZone;
    delete c.settings.refreshSeconds;
  }

  get() {
    return this.file.get();
  }

  update(mutator) {
    return this.file.update(mutator);
  }

  findTile(id) {
    return this.get().tiles.find((x) => x.id === id);
  }

  async addTile(input) {
    const item = validateTile(input || {});
    await this.update((c) => { c.tiles.push(item); });
    return item;
  }

  async editTile(id, input) {
    const existing = this.findTile(id);
    if (!existing) throw new ValidationError("That tile no longer exists.", 404);
    const item = validateTile({ ...existing, ...(input || {}) }, existing);
    await this.update((c) => { c.tiles[c.tiles.findIndex((x) => x.id === id)] = item; });
    return item;
  }

  async removeTile(id) {
    if (!this.findTile(id)) throw new ValidationError("That tile no longer exists.", 404);
    await this.update((c) => { c.tiles = c.tiles.filter((x) => x.id !== id); });
  }

  /** Put `ids` first, in that order; anything not listed keeps its relative order after them. */
  async reorderTiles(ids) {
    if (!Array.isArray(ids)) throw new ValidationError("Expected a list of ids.");
    await this.update((c) => {
      const byId = new Map(c.tiles.map((x) => [x.id, x]));
      const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
      c.tiles = [...ordered, ...c.tiles.filter((x) => !ids.includes(x.id))];
    });
  }

  async saveSettings(input) {
    const next = validateSettings(input || {}, this.get().settings);
    await this.update((c) => { c.settings = next; });
    return next;
  }

  async saveNote(input) {
    const next = validateNote(input);
    await this.update((c) => { c.note = next; });
    return next;
  }

  async saveAppearance(input) {
    const next = validateAppearance(input, this.get().appearance);
    await this.update((c) => { c.appearance = next; });
    return next;
  }

  async setLogo(name) {
    await this.update((c) => { c.logo = name || ""; });
  }

  /** Only ever resolve plain file names inside the uploads folder. */
  uploadPath(name) {
    if (!name || typeof name !== "string" || name !== path.basename(name) || name.startsWith(".")) return null;
    return path.join(this.uploadsDir, name);
  }

  logoPath() {
    const p = this.uploadPath(this.get().logo);
    return p && fs.existsSync(p) ? p : null;
  }

  /** What the kiosk (anyone with the address) sees. */
  publicView() {
    const c = this.get();
    return {
      settings: c.settings,
      note: c.note,
      appearance: c.appearance,
      logo: this.logoPath() ? c.logo : "",
      tiles: c.tiles.filter((t) => t.active).map((t) => ({
        id: t.id, title: t.title, description: t.description, icon: t.icon, code: t.code, open: t.open,
        url: t.url, embedUrl: t.url ? describeLink(t.url).embedUrl : "", kind: t.url ? describeLink(t.url).kind : "none",
      })),
    };
  }
}

module.exports = {
  Store, ValidationError, validateTile, validateSettings, validateNote, validateAppearance,
  LANGS, OPEN_MODES, NOTE_STYLES, THEMES, ACCENT_STYLES, CARD_STYLES, RADII, FONTS, TILE_SIZES, TILE_COLUMNS,
  DEFAULT_SETTINGS, DEFAULT_NOTE, DEFAULT_APPEARANCE,
};
