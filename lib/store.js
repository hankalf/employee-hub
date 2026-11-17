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
  screensaverSeconds: 180,
  publicUrl: "",
  showQr: true,
};

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
  if (!s) return allowEmpty ? "" : dflt;
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

/** Show a tile only on some days between two times. `{days: [1,2,3,4,5], start: "05:00", end: "08:00"}`; end before start spans midnight. */
function validateSchedule(v) {
  if (!v || typeof v !== "object" || v.enabled === false) return null;
  const raw = Array.isArray(v.days) ? v.days : [];
  const days = [...new Set(raw.map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort();
  if (!days.length) throw new ValidationError("Pick at least one day for the tile's schedule.");
  const time = (s, label) => {
    const t = str(s, 5, label);
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) throw new ValidationError(`${label} must be a time like 05:00.`);
    return t;
  };
  const start = time(v.start, "Start time"), end = time(v.end, "End time");
  if (start === end) throw new ValidationError("The schedule's start and end times must be different.");
  return { days, start, end };
}

const hashPin = (pin, salt) => crypto.scryptSync(pin, salt, 32).toString("hex");

function validateTile(input, existing = {}, groups = []) {
  const groupId = str(input.groupId, 20, "Group");
  if (groupId && !groups.some((g) => g.id === groupId)) throw new ValidationError("That group no longer exists.");
  // The PIN is never read back from input as a hash: only a new PIN or a clear request changes it.
  let pinHash = existing.pinHash || "", pinSalt = existing.pinSalt || "";
  if (input.clearPin) { pinHash = ""; pinSalt = ""; }
  if (input.pin != null && input.pin !== "") {
    const p = str(input.pin, 8, "PIN");
    if (!/^\d{4,8}$/.test(p)) throw new ValidationError("The PIN must be 4 to 8 digits.");
    pinSalt = crypto.randomBytes(8).toString("hex");
    pinHash = hashPin(p, pinSalt);
  }
  const title = bilingual(input.title, 80, "Title", { required: true });
  const description = bilingual(input.description, 200, "Description");
  const link = url(input.url, "Link", true);
  // The server's check of the link belongs to that exact link: a new link starts unchecked.
  const sameLink = existing.url === link;
  return {
    id: existing.id || newId(),
    title,
    description,
    icon: str(input.icon, 40, "Icon") || "link",
    url: link,
    resolvedUrl: sameLink ? existing.resolvedUrl || "" : "",
    embedCheck: sameLink ? existing.embedCheck || null : null,
    open: oneOf(input.open, OPEN_MODES, "embed", "Open mode"),
    active: bool(input.active, true),
    code: str(input.code, 6, "Code"),
    groupId,
    schedule: validateSchedule(input.schedule),
    pinHash, pinSalt,
  };
}

function verifyTilePin(tile, pin) {
  if (!tile.pinHash) return true;
  const p = String(pin || "");
  if (!/^\d{4,8}$/.test(p)) return false;
  return crypto.timingSafeEqual(Buffer.from(hashPin(p, tile.pinSalt), "hex"), Buffer.from(tile.pinHash, "hex"));
}

function validateGroup(input, existing = {}) {
  return { id: existing.id || newId(), title: bilingual(input.title, 60, "Group name", { required: true }) };
}

/** A note shown beside the greeting between two dates. */
function validateNote(input, existing = {}) {
  const i = input && typeof input === "object" ? input : {};
  const n = {
    id: existing.id || newId(),
    active: bool(i.active, true),
    style: oneOf(i.style, NOTE_STYLES, "info", "Note style"),
    title: bilingual(i.title, 80, "Note title"),
    body: bilingual(i.body, 600, "Note text"),
    from: ymd(i.from, "Show from"),
    until: ymd(i.until, "Show until"),
  };
  if (!n.title.en && !n.body.en) throw new ValidationError("A note needs a title or some text.");
  if (n.from && n.until && n.until < n.from) throw new ValidationError("\"Show until\" must be on or after \"Show from\".");
  return n;
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
  if (input.screensaverSeconds !== undefined) s.screensaverSeconds = int(input.screensaverSeconds, 0, 7200, 180, "Screensaver after");
  if (input.publicUrl !== undefined) s.publicUrl = url(input.publicUrl, "Public address", true);
  if (input.showQr !== undefined) s.showQr = Boolean(input.showQr);
  return s;
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

/** Bring content from any earlier version up to the current shape. */
function normalizeContent(c) {
  c.tiles = (Array.isArray(c.tiles) ? c.tiles : []).map((t) => ({
    groupId: "", schedule: null, pinHash: "", pinSalt: "", resolvedUrl: "", embedCheck: null, ...t,
    schedule: t.schedule && t.schedule.days ? t.schedule : null,
  }));
  c.groups = Array.isArray(c.groups) ? c.groups : [];
  c.notes = Array.isArray(c.notes) ? c.notes : [];
  if (c.note && typeof c.note === "object") {
    const n = c.note;
    const hasText = (n.title && n.title.en) || (n.body && n.body.en);
    if (hasText) c.notes.push({ id: newId(), active: Boolean(n.active), style: n.style || "info", title: n.title || { en: "", es: "" }, body: n.body || { en: "", es: "" }, from: "", until: n.until || "" });
  }
  delete c.note;
  c.settings = { ...DEFAULT_SETTINGS, ...(c.settings || {}) };
  c.appearance = { ...DEFAULT_APPEARANCE, ...(c.appearance || {}) };
  c.logo = typeof c.logo === "string" ? c.logo : "";
  // Leftovers from the version with board panels and quick links.
  delete c.panels;
  delete c.links;
  delete c.optionLabels;
  delete c.settings.timeZone;
  delete c.settings.refreshSeconds;
  return c;
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
    normalizeContent(this.file.load());
  }

  get() {
    return this.file.get();
  }

  update(mutator) {
    return this.file.update(mutator);
  }

  /** Replace everything (used by restore). Throws if the shape is wrong. */
  async replaceContent(content) {
    if (!content || typeof content !== "object" || !Array.isArray(content.tiles)) throw new ValidationError("That file doesn't look like an Employee Hub backup.");
    const next = normalizeContent(JSON.parse(JSON.stringify(content)));
    await this.file.write(next);
    this.file.data = next;
  }

  // --- tiles -----------------------------------------------------------------
  findTile(id) { return this.get().tiles.find((x) => x.id === id); }

  async addTile(input) {
    const item = validateTile(input || {}, {}, this.get().groups);
    await this.update((c) => { c.tiles.push(item); });
    return item;
  }

  async editTile(id, input) {
    const existing = this.findTile(id);
    if (!existing) throw new ValidationError("That tile no longer exists.", 404);
    const item = validateTile({ ...existing, ...(input || {}) }, existing, this.get().groups);
    await this.update((c) => { c.tiles[c.tiles.findIndex((x) => x.id === id)] = item; });
    return item;
  }

  async removeTile(id) {
    if (!this.findTile(id)) throw new ValidationError("That tile no longer exists.", 404);
    await this.update((c) => { c.tiles = c.tiles.filter((x) => x.id !== id); });
  }

  reorderTiles(ids) { return this.reorder("tiles", ids); }

  /** Save the server's check of a tile's link, unless the link was changed in the meantime. */
  async setTileCheck(id, link, result) {
    const tile = this.findTile(id);
    if (!tile || tile.url !== link) return tile || null;
    const embedCheck = { status: result.status, detail: result.detail || "", checkedAt: result.checkedAt || new Date().toISOString() };
    await this.update((c) => {
      const t = c.tiles.find((x) => x.id === id);
      if (t && t.url === link) { t.resolvedUrl = result.resolvedUrl || ""; t.embedCheck = embedCheck; }
    });
    return this.findTile(id);
  }

  /** Where a tile really points (short links resolved), what goes in the iframe, and whether to skip the iframe. */
  tileTarget(t) {
    const target = t.resolvedUrl || t.url;
    const d = describeLink(target);
    const status = t.embedCheck && t.embedCheck.status;
    // Forms monday won't show inside another site, and pages behind a sign-in, open full screen instead.
    const fullPage = t.open === "embed" && (status === "blocked" || status === "login" || d.kind === "monday");
    return { url: target, embedUrl: target ? d.embedUrl : "", kind: t.url ? d.kind : "none", fullPage };
  }

  // --- groups ----------------------------------------------------------------
  async addGroup(input) {
    const g = validateGroup(input || {});
    await this.update((c) => { c.groups.push(g); });
    return g;
  }

  async editGroup(id, input) {
    const existing = this.get().groups.find((x) => x.id === id);
    if (!existing) throw new ValidationError("That group no longer exists.", 404);
    const g = validateGroup({ ...existing, ...(input || {}) }, existing);
    await this.update((c) => { c.groups[c.groups.findIndex((x) => x.id === id)] = g; });
    return g;
  }

  async removeGroup(id) {
    if (!this.get().groups.some((x) => x.id === id)) throw new ValidationError("That group no longer exists.", 404);
    await this.update((c) => {
      c.groups = c.groups.filter((x) => x.id !== id);
      c.tiles.forEach((t) => { if (t.groupId === id) t.groupId = ""; });
    });
  }

  reorderGroups(ids) { return this.reorder("groups", ids); }

  // --- notes -----------------------------------------------------------------
  async addNote(input) {
    const n = validateNote(input);
    await this.update((c) => { c.notes.push(n); });
    return n;
  }

  async editNote(id, input) {
    const existing = this.get().notes.find((x) => x.id === id);
    if (!existing) throw new ValidationError("That note no longer exists.", 404);
    const n = validateNote({ ...existing, ...(input || {}) }, existing);
    await this.update((c) => { c.notes[c.notes.findIndex((x) => x.id === id)] = n; });
    return n;
  }

  async removeNote(id) {
    if (!this.get().notes.some((x) => x.id === id)) throw new ValidationError("That note no longer exists.", 404);
    await this.update((c) => { c.notes = c.notes.filter((x) => x.id !== id); });
  }

  reorderNotes(ids) { return this.reorder("notes", ids); }

  /** Put `ids` first, in that order; anything not listed keeps its relative order after them. */
  async reorder(collection, ids) {
    if (!Array.isArray(ids)) throw new ValidationError("Expected a list of ids.");
    await this.update((c) => {
      const byId = new Map(c[collection].map((x) => [x.id, x]));
      const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
      c[collection] = [...ordered, ...c[collection].filter((x) => !ids.includes(x.id))];
    });
  }

  // --- settings, appearance, logo ---------------------------------------------
  async saveSettings(input) {
    const next = validateSettings(input || {}, this.get().settings);
    await this.update((c) => { c.settings = next; });
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

  // --- views -----------------------------------------------------------------
  /** What the kiosk (anyone with the address) sees. PIN-protected tiles don't reveal their link. */
  publicView() {
    const c = this.get();
    return {
      settings: c.settings,
      appearance: c.appearance,
      logo: this.logoPath() ? c.logo : "",
      groups: c.groups,
      notes: c.notes.filter((n) => n.active),
      tiles: c.tiles.filter((t) => t.active).map((t) => {
        const locked = Boolean(t.pinHash);
        const target = this.tileTarget(t);
        return {
          id: t.id, title: t.title, description: t.description, icon: t.icon, code: t.code, open: t.open,
          groupId: t.groupId || "", schedule: t.schedule || null, locked, hasLink: Boolean(t.url),
          url: locked ? "" : target.url, embedUrl: locked ? "" : target.embedUrl, kind: target.kind, fullPage: target.fullPage,
        };
      }),
    };
  }

  /** What the admin page gets: everything except PIN hashes. */
  adminView() {
    const c = this.get();
    return { ...c, logo: this.logoPath() ? c.logo : "", tiles: c.tiles.map(({ pinHash, pinSalt, ...t }) => ({ ...t, hasPin: Boolean(pinHash) })) };
  }
}

module.exports = {
  Store, ValidationError, validateTile, validateGroup, validateNote, validateSettings, validateAppearance, validateSchedule, verifyTilePin, normalizeContent,
  LANGS, OPEN_MODES, NOTE_STYLES, THEMES, ACCENT_STYLES, CARD_STYLES, RADII, FONTS, TILE_SIZES, TILE_COLUMNS,
  DEFAULT_SETTINGS, DEFAULT_APPEARANCE,
};
