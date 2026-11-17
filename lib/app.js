"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const multer = require("multer");
const { Store, ValidationError, verifyTilePin } = require("./store");
const { Stats, Devices } = require("./stats");
const { createBackup, restoreBackup, writeAutoBackup, listAutoBackups, autoBackupPath } = require("./backup");
const { createAuth } = require("./auth");
const { Admins, AdminError, publicAdmin } = require("./admins");
const { Audit, toCsv } = require("./audit");
const { createAlerts } = require("./alerts");
const { createChecker } = require("./formcheck");
const { describeLink, normalizeUrl } = require("./links");
const { encodeQr, toSvg } = require("./qr");

const ROOT = path.join(__dirname, "..");
const PUBLIC = path.join(ROOT, "public");
const VIEWS = path.join(ROOT, "views");
const MAX_IMAGE_MB = 2;
const MAX_RESTORE_MB = 20;
const UNLOCK_MINUTES = 15;
const IMAGE_TYPES = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp", "image/svg+xml": ".svg" };
const BAD_LINK = ["blocked", "login", "notfound"];

// Sites allowed to show the hub inside a frame, e.g. a monday.com board view, dashboard widget or monday app.
const DEFAULT_FRAME_ANCESTORS = ["https://monday.com", "https://*.monday.com", "https://*.monday.app"];
const ANCESTOR_RE = /^https:\/\/(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(:\d{1,5})?$/i;

/** FRAME_ANCESTORS: space- or comma-separated https origins (wildcard subdomains allowed); "none" = only the hub itself. */
function parseFrameAncestors(value) {
  if (value == null || String(value).trim() === "") return DEFAULT_FRAME_ANCESTORS.slice();
  const list = String(value).split(/[\s,]+/).filter(Boolean);
  if (list.length === 1 && /^'?none'?$/i.test(list[0])) return [];
  const ok = list.filter((s) => ANCESTOR_RE.test(s));
  const bad = list.filter((s) => !ANCESTOR_RE.test(s));
  if (bad.length) console.warn(`FRAME_ANCESTORS: ignoring ${bad.join(", ")} (use https://site.com or https://*.site.com)`);
  return ok;
}

function buildCsp(frameAncestors) {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: https:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-src 'self' https:",   // monday.com forms (and any other https page an admin chooses) open inside the hub; the admin previews the kiosk
    `frame-ancestors ${["'self'", ...frameAncestors].join(" ")}`,
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
}

/** A fingerprint of the kiosk's own files. When it changes after a deploy, kiosks reload themselves. */
function buildId() {
  const hash = crypto.createHash("sha1");
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) walk(p);
      else hash.update(name).update(fs.readFileSync(p));
    }
  };
  walk(PUBLIC);
  return hash.digest("hex").slice(0, 12);
}

/** Which tile fields changed, for the activity log. */
function changedFields(before, after) {
  const names = { title: "title", description: "description", url: "link", icon: "icon", open: "open mode", active: "shown/hidden", code: "corner label", groupId: "group", schedule: "schedule", pinHash: "PIN" };
  return Object.keys(names).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k])).map((k) => names[k]);
}

/**
 * Build the Express app. `config`: dataDir, adminPassword, sessionSecret, publicUrl, frameAncestors, mondayToken
 *   (tests may also pass fetchImpl, and backgroundJobs: false to run jobs by hand through ctx.jobs)
 */
async function createApp(config) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const store = new Store(config.dataDir);
  store.init();
  const stats = new Stats(config.dataDir);
  stats.load();
  const devices = new Devices(config.dataDir);
  devices.load();
  const admins = new Admins(config.dataDir);
  admins.load();
  const audit = new Audit(config.dataDir);
  const auth = createAuth({ dataDir: config.dataDir, secret: config.sessionSecret, adminPassword: config.adminPassword, admins });
  const fetchImpl = config.fetchImpl || globalThis.fetch;
  const checker = createChecker({ fetchImpl });
  const alerts = createAlerts({ store, devices, fetchImpl, mondayToken: config.mondayToken || "" });
  const BUILD = buildId();
  const tmpDir = path.join(config.dataDir, "tmp");
  fs.mkdirSync(tmpDir, { recursive: true });
  const imageUpload = (field) => multer({
    storage: multer.diskStorage({ destination: tmpDir, filename: (req, file, cb) => cb(null, crypto.randomBytes(8).toString("hex")) }),
    limits: { fileSize: MAX_IMAGE_MB * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => cb(null, Boolean(IMAGE_TYPES[file.mimetype])),
  }).single(field);
  const restoreUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_RESTORE_MB * 1024 * 1024, files: 1 } });
  const backupCtx = { store, stats, devices, admins };
  const ctx = { config, store, stats, devices, admins, audit, auth, checker, alerts, build: BUILD, restoring: false };

  const frameAncestors = parseFrameAncestors(config.frameAncestors);
  const CSP = buildCsp(frameAncestors);
  const app = express();
  app.set("trust proxy", 1); // Railway terminates HTTPS in front of us
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Content-Security-Policy": CSP,
    });
    // X-Frame-Options can't name other sites, so it's only sent when no other site may frame the hub.
    if (!frameAncestors.length) res.set("X-Frame-Options", "SAMEORIGIN");
    next();
  });
  app.get("/healthz", (req, res) => res.send("ok"));
  app.use(auth.attach);

  const page = (res, file) => { res.set("Cache-Control", "no-store"); res.sendFile(file); };
  const publicUrl = (req) => store.get().settings.publicUrl || config.publicUrl || `${req.protocol}://${req.get("host")}`;
  const smallJson = express.json({ limit: "4kb", type: ["application/json", "text/plain"] });
  const savedOrigin = () => { try { return new URL(store.get().settings.publicUrl || config.publicUrl).origin; } catch (e) { return ""; } };
  const requestOrigin = (req) => { try { return new URL(publicUrl(req)).origin; } catch (e) { return ""; } };
  const tileName = (t) => (t && t.title && t.title.en) || "(untitled)";
  const log = (req, action, detail) => audit.log(req && req.admin, action, detail);

  /** Check a tile's link from the server and remember the result on the tile. */
  async function checkTile(tile, origin, fresh = false) {
    if (!tile || !tile.url) return tile;
    const result = await checker.check(tile.url, { origin, fresh });
    return store.setTileCheck(tile.id, tile.url, result);
  }

  /** Delete uploaded images nothing uses any more (older than an hour, so a fresh upload isn't removed before it's saved). */
  async function pruneImages() {
    const keep = store.referencedImages();
    const cutoff = Date.now() - 3600 * 1000;
    for (const f of await fsp.readdir(store.uploadsDir).catch(() => [])) {
      if (keep.has(f)) continue;
      const p = path.join(store.uploadsDir, f);
      const st = await fsp.stat(p).catch(() => null);
      if (st && st.mtimeMs < cutoff) await fsp.unlink(p).catch(() => {});
    }
  }

  // ---------------------------------------------------------------------------
  // Background jobs
  // ---------------------------------------------------------------------------
  /** Re-check every form link; alert about links that stopped working since the last check. */
  async function runLinkCheck({ by = null } = {}) {
    const problems = [];
    for (const t of store.get().tiles.filter((x) => x.url)) {
      const before = t.embedCheck && t.embedCheck.status;
      const after = await checkTile(t, savedOrigin(), true).catch(() => null);
      const status = after && after.embedCheck && after.embedCheck.status;
      if (status && BAD_LINK.includes(status) && before !== status && t.open === "embed") problems.push({ tile: tileName(t), status, detail: after.embedCheck.detail });
    }
    await store.setMeta({ lastLinkCheck: new Date().toISOString() });
    const words = { blocked: "can't be shown inside the hub (opens full screen)", login: "now asks for a monday.com sign-in", notfound: "was not found (deleted?)" };
    if (problems.length) {
      const detail = problems.map((p) => `• ${p.tile}: ${words[p.status]}`).join("\n");
      audit.log(by, "Link check found problems", problems.map((p) => `${p.tile}: ${p.status}`).join("; "));
      const a = store.get().settings.alerts;
      if (a.enabled && a.linkProblems) await alerts.send(`${problems.length} form link${problems.length === 1 ? "" : "s"} stopped working`, `${detail}\n\nOpen Admin → Tiles to fix them.`);
    }
    return problems;
  }

  async function runAutoBackup() {
    await stats.flush();
    await devices.flush();
    const name = await writeAutoBackup(backupCtx);
    await store.setMeta({ lastAutoBackup: new Date().toISOString() });
    return name;
  }

  /** Hourly: the daily link check and the nightly backup, each when it's more than ~a day old. Also tidy-up. */
  async function hourly() {
    const meta = store.get().meta;
    const day = 23 * 3600 * 1000;
    const due = (iso) => !iso || Date.now() - new Date(iso).getTime() > day;
    if (due(meta.lastAutoBackup)) await runAutoBackup().catch((e) => console.warn("Automatic backup failed:", e.message));
    if (due(meta.lastLinkCheck)) await runLinkCheck().catch((e) => console.warn("Daily link check failed:", e.message));
    // Tap counts of tiles that are gone for good (not even in the trash) are dropped.
    const known = new Set([...store.get().tiles.map((t) => t.id), ...store.get().trash.map((e) => e.item && e.item.id)]);
    for (const id of Object.keys(stats.get().taps)) if (!known.has(id)) stats.remove(id);
    await pruneImages();
  }

  ctx.jobs = { runLinkCheck, runAutoBackup, hourly, checkDevices: () => alerts.checkDevices(), pruneImages };

  if (config.backgroundJobs !== false && config.backgroundChecks !== false) {
    // Tiles saved by an older version have never been checked: check them shortly after start-up.
    setTimeout(async () => {
      for (const t of store.get().tiles.filter((x) => x.url && !x.embedCheck)) {
        await checkTile(t, savedOrigin()).catch((e) => console.warn("Link check failed:", e.message));
      }
    }, 3000).unref();
    setTimeout(() => hourly().catch((e) => console.warn(e.message)), 2 * 60000).unref();
    setInterval(() => hourly().catch((e) => console.warn(e.message)), 3600 * 1000).unref();
    setInterval(() => alerts.checkDevices().catch((e) => console.warn("Kiosk alert check failed:", e.message)), 60000).unref();
  }

  // ---------------------------------------------------------------------------
  // Kiosk pages (no login: the hub is for everyone who scans the code)
  // ---------------------------------------------------------------------------
  app.get("/kiosk", (req, res) => page(res, path.join(PUBLIC, "index.html")));
  app.get(["/", "/index.html"], (req, res) => res.redirect(302, "/kiosk"));
  app.get("/open/t/:id", (req, res) => page(res, path.join(PUBLIC, "open.html")));
  app.get("/qr", (req, res) => page(res, path.join(PUBLIC, "qr.html")));

  /** QR code of the hub, or with ?tile=<id> of that tile's form (never for PIN-protected tiles). */
  app.get("/qr.svg", (req, res) => {
    let target = publicUrl(req);
    if (req.query.tile) {
      const tile = store.findTile(String(req.query.tile));
      if (!tile || !tile.active || !tile.url || tile.pinHash || !store.get().settings.formQr) return res.status(404).type("text/plain").send("No QR code for that tile.");
      target = store.tileTarget(tile).url.replace("://forms.monday.com/forms/embed/", "://forms.monday.com/forms/"); // the phone gets the normal form page
    }
    let svg;
    try {
      svg = toSvg(encodeQr(target), { title: `QR code linking to ${target}` });
    } catch (e) {
      return res.status(422).type("text/plain").send("That address is too long to turn into a QR code.");
    }
    res.set("Cache-Control", "no-cache");
    res.type("image/svg+xml").send(svg);
  });

  // The uploaded logo. Pages add ?v=<name> so a new upload isn't hidden by caching.
  app.get("/logo", (req, res) => {
    const p = store.logoPath();
    if (!p) return res.status(404).type("text/plain").send("No logo");
    res.set("Content-Security-Policy", "sandbox");
    res.set("Cache-Control", "public, max-age=86400");
    res.sendFile(p, { dotfiles: "deny" }, (err) => err && !res.headersSent && res.status(404).send("No logo"));
  });

  // Uploaded tile icons. Names are unique per upload, so they can be cached for a long time.
  app.get("/img/:name", (req, res) => {
    const name = req.params.name;
    const p = /^icon-[a-z0-9-]+\.(png|jpe?g|gif|webp|svg)$/.test(name) ? store.uploadPath(name) : null;
    if (!p || !fs.existsSync(p)) return res.status(404).type("text/plain").send("Not found");
    res.set("Content-Security-Policy", "sandbox");
    res.set("Cache-Control", "public, max-age=31536000, immutable");
    res.sendFile(p, { dotfiles: "deny" }, (err) => err && !res.headersSent && res.status(404).send("Not found"));
  });

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------
  app.get("/api/hub", (req, res) => {
    res.set("Cache-Control", "no-cache");
    const device = /^[a-f0-9]{16,32}$/.test(String(req.query.device || "")) ? devices.get1(String(req.query.device)) : null;
    res.json({
      ...store.publicView({ groups: device ? device.groups : null }), publicUrl: publicUrl(req), build: BUILD,
      device: { named: Boolean(device && (device.name || device.watch)), layout: (device && device.layout) || "auto" },
    });
  });

  // A tile was tapped (usage counts). ?h= is the kiosk's local hour, for the time-of-day chart.
  app.post("/api/tap/:id", (req, res) => {
    const tile = store.findTile(req.params.id);
    const h = Number.parseInt(req.query.h, 10);
    if (tile && tile.active) stats.tap(tile.id, Number.isInteger(h) ? h : undefined);
    res.status(204).end();
  });

  // A kiosk device checking in, so the admin can see it's online.
  app.post("/api/heartbeat", smallJson, (req, res) => {
    const b = req.body || {};
    const id = String(b.deviceId || "");
    if (/^[a-f0-9]{16,32}$/.test(id)) devices.beat(id, { ua: req.get("user-agent"), screen: b.screen, path: b.path, model: b.model, scanner: b.scanner });
    res.status(204).end();
  });

  // PIN-protected tiles: a correct PIN returns a short-lived token that unlocks the tile's link.
  app.post("/api/tiles/:id/unlock", smallJson, (req, res) => {
    const tile = store.findTile(req.params.id);
    if (!tile || !tile.active) return res.status(404).json({ error: "That tile no longer exists." });
    if (auth.tooManyPinTries(req.ip)) return res.status(429).json({ error: "Too many tries. Please wait 15 minutes.", code: "locked" });
    if (!verifyTilePin(tile, req.body && req.body.pin)) {
      auth.recordPinFailure(req.ip);
      return res.status(403).json({ error: "Incorrect PIN.", code: "wrong" });
    }
    auth.recordPinSuccess(req.ip);
    res.json({ ok: true, token: auth.signToken({ t: tile.id }, UNLOCK_MINUTES * 60000) });
  });

  app.get("/api/tiles/:id/link", (req, res) => {
    res.set("Cache-Control", "no-store");
    const tile = store.findTile(req.params.id);
    if (!tile || !tile.active) return res.status(404).json({ error: "That tile no longer exists." });
    if (tile.pinHash) {
      const data = auth.verifyToken(req.query.k);
      if (!data || data.t !== tile.id) return res.status(403).json({ error: "Please enter the PIN again.", code: "expired" });
    }
    const target = store.tileTarget(tile);
    res.json({ id: tile.id, title: tile.title, url: target.url, embedUrl: target.embedUrl, open: tile.open, fullPage: target.fullPage });
  });

  // ---------------------------------------------------------------------------
  // Admin sign in / out
  // ---------------------------------------------------------------------------
  app.get("/admin/login", (req, res) => {
    if (req.isAdmin) return res.redirect("/admin");
    page(res, path.join(VIEWS, "login.html"));
  });

  app.post("/admin/login", express.urlencoded({ extended: false, limit: "10kb" }), async (req, res) => {
    const username = String((req.body && req.body.username) || "").trim().toLowerCase().slice(0, 60);
    const back = (code) => res.redirect(`/admin/login?error=${code}${username ? "&u=" + encodeURIComponent(username) : ""}`);
    if (!auth.enabled()) return back("disabled");
    if (auth.tooManyAttempts(req.ip, username)) return back("locked");
    const admin = await auth.authenticate(username, String((req.body && req.body.password) || ""));
    if (!admin) {
      auth.recordFailure(req.ip, username);
      audit.log(null, "Failed sign-in", `${username || "admin"} from ${req.ip}`);
      return back("wrong");
    }
    auth.recordSuccess(req.ip, username);
    if (admin.role !== "owner") await admins.recordLogin(admin.id);
    auth.issue(res, req, admin);
    audit.log(admin, "Signed in", "");
    res.redirect("/admin?signedin=1"); // lets /admin tell "never signed in" from "the browser didn't keep the sign-in"
  });

  app.post("/admin/logout", (req, res) => {
    if (req.admin) audit.log(req.admin, "Signed out", "");
    auth.clear(res, req);
    res.redirect("/admin/login?signedout=1");
  });

  app.get("/admin", (req, res) => {
    if (!req.isAdmin) return res.redirect(req.query.signedin ? "/admin/login?error=cookie" : "/admin/login");
    page(res, path.join(VIEWS, "admin.html"));
  });

  // ---------------------------------------------------------------------------
  // Admin API
  // ---------------------------------------------------------------------------
  const api = express.Router();
  api.use(auth.requireAdminApi, auth.csrf, express.json({ limit: "200kb" }));
  api.use((req, res, next) => {
    if (ctx.restoring && req.method !== "GET") return res.status(503).json({ error: "A backup is being restored — try again in a moment." });
    next();
  });

  // --- me and admins ---
  api.get("/me", (req, res) => res.json({ ...req.admin, ownerEnabled: Boolean(config.adminPassword) }));
  api.put("/me/password", async (req, res) => {
    if (req.admin.role === "owner") throw new ValidationError("The owner's password is the ADMIN_PASSWORD variable on Railway: change it there.");
    const a = await admins.changePassword(req.admin.id, req.body && req.body.current, req.body && req.body.next);
    auth.issue(res, req, { id: a.id }); // other devices are signed out; this one stays signed in
    log(req, "Changed password", "");
    res.json({ ok: true });
  });
  api.get("/admins", auth.requireOwner, (req, res) => res.json(admins.list()));
  api.post("/admins", auth.requireOwner, async (req, res) => {
    const out = await admins.create(req.body || {});
    log(req, "Added admin", `${out.admin.name} (${out.admin.username})`);
    res.status(201).json(out);
  });
  api.put("/admins/:id", auth.requireOwner, async (req, res) => {
    const a = await admins.update(req.params.id, req.body || {});
    log(req, "Changed admin", `${a.name} (${a.username})${req.body && req.body.active === false ? ": switched off" : ""}`);
    res.json(a);
  });
  api.post("/admins/:id/reset", auth.requireOwner, async (req, res) => {
    const out = await admins.resetPassword(req.params.id);
    log(req, "Reset password", `${out.admin.name} (${out.admin.username})`);
    res.json(out);
  });
  api.delete("/admins/:id", auth.requireOwner, async (req, res) => {
    const a = admins.byId(req.params.id);
    await admins.remove(req.params.id);
    log(req, "Removed admin", a ? `${a.name} (${a.username})` : "");
    res.json({ ok: true });
  });

  // --- content ---
  api.get("/content", (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ ...store.adminView(), publicUrl: publicUrl(req), adminEnabled: auth.enabled(), me: req.admin, mondayToken: Boolean(config.mondayToken) });
  });

  api.put("/settings", async (req, res) => {
    const next = await store.saveSettings(req.body);
    log(req, req.body && req.body.alerts ? "Changed alert settings" : "Changed settings", Object.keys(req.body || {}).join(", "));
    res.json(next);
  });
  api.put("/appearance", async (req, res) => {
    const next = await store.saveAppearance(req.body);
    log(req, "Changed appearance", Object.keys(req.body || {}).join(", "));
    res.json(next);
  });

  const strip = ({ pinHash, pinSalt, ...t }) => ({ ...t, hasPin: Boolean(pinHash) });
  api.post("/tiles", async (req, res) => {
    const tile = await store.addTile(req.body);
    log(req, "Added tile", tileName(tile));
    res.status(201).json(strip(await checkTile(tile, requestOrigin(req))));
  });
  api.put("/tiles/order", async (req, res) => { await store.reorderTiles(req.body && req.body.ids); log(req, "Reordered tiles", ""); res.json({ ok: true }); });
  // Check every tile's link again now (e.g. after changing a form's sharing settings in monday.com).
  api.post("/tiles/check", async (req, res) => {
    const origin = requestOrigin(req);
    for (const t of store.get().tiles.filter((x) => x.url)) await checkTile(t, origin, true);
    await store.setMeta({ lastLinkCheck: new Date().toISOString() });
    log(req, "Checked links", "");
    res.json(store.adminView().tiles);
  });
  api.put("/tiles/:id", async (req, res) => {
    const before = store.findTile(req.params.id);
    let tile = await store.editTile(req.params.id, req.body);
    if (tile.url && !tile.embedCheck) tile = await checkTile(tile, requestOrigin(req));
    const what = before ? changedFields(before, tile) : [];
    if (what.length) log(req, "Changed tile", `${tileName(tile)}: ${what.join(", ")}`);
    if (before && before.icon !== tile.icon) pruneImages().catch(() => {});
    res.json(strip(tile));
  });
  api.delete("/tiles/:id", async (req, res) => {
    const t = store.findTile(req.params.id);
    const undo = await store.removeTile(req.params.id);
    log(req, "Deleted tile", tileName(t));
    res.json({ ok: true, undo });
  });

  api.post("/groups", async (req, res) => { const g = await store.addGroup(req.body); log(req, "Added group", g.title.en); res.status(201).json(g); });
  api.put("/groups/order", async (req, res) => { await store.reorderGroups(req.body && req.body.ids); log(req, "Reordered groups", ""); res.json({ ok: true }); });
  api.put("/groups/:id", async (req, res) => { const g = await store.editGroup(req.params.id, req.body); log(req, "Changed group", g.title.en); res.json(g); });
  api.delete("/groups/:id", async (req, res) => {
    const g = store.get().groups.find((x) => x.id === req.params.id);
    const undo = await store.removeGroup(req.params.id);
    log(req, "Deleted group", g ? g.title.en : "");
    res.json({ ok: true, undo });
  });

  api.post("/notes", async (req, res) => { const n = await store.addNote(req.body); log(req, "Added note", n.title.en || n.body.en.slice(0, 60)); res.status(201).json(n); });
  api.put("/notes/order", async (req, res) => { await store.reorderNotes(req.body && req.body.ids); log(req, "Reordered notes", ""); res.json({ ok: true }); });
  api.put("/notes/:id", async (req, res) => { const n = await store.editNote(req.params.id, req.body); log(req, "Changed note", n.title.en || n.body.en.slice(0, 60)); res.json(n); });
  api.delete("/notes/:id", async (req, res) => {
    const n = store.get().notes.find((x) => x.id === req.params.id);
    const undo = await store.removeNote(req.params.id);
    log(req, "Deleted note", n ? n.title.en || n.body.en.slice(0, 60) : "");
    res.json({ ok: true, undo });
  });

  api.post("/undo/:id", async (req, res) => {
    const { collection, item } = await store.undo(req.params.id);
    const kind = { tiles: "tile", notes: "note", groups: "group" }[collection];
    log(req, "Undid delete", `${kind}: ${(item.title && item.title.en) || ""}`);
    res.json({ ok: true, collection });
  });

  // What is this link? Lets the admin page say "monday.com form — opens inside the hub" as you paste.
  api.get("/link-info", async (req, res) => {
    let url;
    try { url = normalizeUrl(req.query.url); } catch (e) { return res.json({ ok: false, error: e.message }); }
    const info = { ok: true, url, ...describeLink(url) };
    if (req.query.check === "1") info.check = await checker.check(url, { origin: requestOrigin(req) });
    res.json(info);
  });

  // --- images: logo and tile icons ---
  api.post("/logo", imageUpload("logo"), async (req, res) => {
    if (!req.file) throw new ValidationError("Choose a PNG, JPG, GIF, WebP or SVG image.");
    const name = `logo-${Date.now()}${IMAGE_TYPES[req.file.mimetype]}`;
    const old = store.logoPath();
    await fsp.rename(req.file.path, store.uploadPath(name));
    await store.setLogo(name);
    if (old) await fsp.unlink(old).catch(() => {});
    log(req, "Uploaded logo", req.file.originalname);
    res.json({ logo: name });
  });
  api.delete("/logo", async (req, res) => {
    const old = store.logoPath();
    await store.setLogo("");
    if (old) await fsp.unlink(old).catch(() => {});
    log(req, "Removed logo", "");
    res.json({ ok: true });
  });
  // An image for a tile icon. It's used once a tile is saved with { icon: "img:<name>" }.
  api.post("/images", imageUpload("image"), async (req, res) => {
    if (!req.file) throw new ValidationError("Choose a PNG, JPG, GIF, WebP or SVG image.");
    const name = `icon-${crypto.randomBytes(6).toString("hex")}${IMAGE_TYPES[req.file.mimetype]}`;
    await fsp.rename(req.file.path, store.uploadPath(name));
    res.status(201).json({ icon: `img:${name}`, url: `/img/${name}` });
  });

  // --- usage, kiosks, activity ---
  api.get("/stats", (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ usage: stats.summary(), devices: devices.list(), now: new Date().toISOString(), lastLinkCheck: store.get().meta.lastLinkCheck || "" });
  });
  api.get("/stats.csv", (req, res) => {
    const titles = new Map([...store.get().tiles, ...store.get().trash.map((e) => e.item).filter(Boolean)].map((t) => [t.id, tileName(t)]));
    const rows = stats.rows((id) => titles.get(id) || "(deleted tile)");
    res.set("Content-Disposition", `attachment; filename="employee-hub-taps-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.type("text/csv").send("﻿" + toCsv(rows));
  });
  api.put("/devices/:id", (req, res) => {
    const b = req.body || {};
    const fields = {};
    if (b.name !== undefined) fields.name = b.name;
    if (b.watch !== undefined) fields.watch = b.watch;
    if (b.layout !== undefined) {
      if (!["auto", "tiles", "list", "scanner"].includes(b.layout)) throw new ValidationError("Layout must be automatic, tiles, list or scanner.");
      fields.layout = b.layout;
    }
    if (b.groups !== undefined) {
      if (b.groups === null) fields.groups = null;
      else {
        if (!Array.isArray(b.groups)) throw new ValidationError("Choose which groups this kiosk shows.");
        const valid = new Set(["", ...store.get().groups.map((g) => g.id)]);
        fields.groups = [...new Set(b.groups.map(String))].filter((g) => valid.has(g));
      }
    }
    const before = devices.get1(req.params.id);
    if (!devices.set(req.params.id, fields)) return res.status(404).json({ error: "That kiosk is no longer listed." });
    log(req, "Changed kiosk", `${(before && before.name) || req.params.id.slice(0, 6)}: ${Object.keys(fields).join(", ")}`);
    res.json({ ok: true });
  });
  api.delete("/devices/:id", (req, res) => {
    const d = devices.get1(req.params.id);
    devices.forget(req.params.id);
    log(req, "Forgot kiosk", (d && d.name) || req.params.id.slice(0, 6));
    res.json({ ok: true });
  });
  api.get("/activity", async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(await audit.recent(Math.min(Number(req.query.limit) || 300, 2000)));
  });
  api.get("/activity.csv", async (req, res) => {
    const rows = (await audit.recent(50000)).map((e) => [e.at, e.name, e.user, e.action, e.detail]);
    res.set("Content-Disposition", `attachment; filename="employee-hub-activity-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.type("text/csv").send("﻿" + toCsv([["When (UTC)", "Name", "Username", "Action", "Details"], ...rows]));
  });

  // --- alerts ---
  api.post("/alerts/test", async (req, res) => {
    const a = store.get().settings.alerts;
    if (!a.webhookUrl && !a.mondayBoardId) throw new ValidationError("Add a webhook address or a monday.com board first, and save.");
    const results = await alerts.send("Test alert from the Employee Hub", `Sent by ${req.admin.name} from the admin page. If you can read this, alerts are working.`);
    log(req, "Sent test alert", results.map((r) => `${r.channel}: ${r.ok ? "ok" : r.error}`).join("; "));
    res.json({ results });
  });

  // --- backups ---
  api.get("/backup", async (req, res) => {
    await stats.flush();
    await devices.flush();
    const zip = await createBackup(backupCtx);
    log(req, "Downloaded backup", "");
    res.set("Content-Disposition", `attachment; filename="employee-hub-backup-${new Date().toISOString().slice(0, 10)}.zip"`);
    res.type("application/zip").send(zip);
  });
  async function doRestore(req, buffer, label) {
    ctx.restoring = true;
    try {
      await restoreBackup(buffer, backupCtx);
    } finally {
      ctx.restoring = false;
    }
    log(req, "Restored backup", label);
  }
  api.post("/restore", auth.requireOwner, restoreUpload.single("backup"), async (req, res) => {
    if (!req.file) throw new ValidationError("Choose a backup zip first.");
    await doRestore(req, req.file.buffer, req.file.originalname);
    res.json({ ok: true });
  });
  api.get("/backups", async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(await listAutoBackups(config.dataDir));
  });
  api.post("/backups/run", async (req, res) => {
    const name = await runAutoBackup();
    log(req, "Made a backup", name);
    res.json({ name, list: await listAutoBackups(config.dataDir) });
  });
  api.get("/backups/:name", (req, res) => {
    const p = autoBackupPath(config.dataDir, req.params.name);
    if (!p) return res.status(404).json({ error: "That backup no longer exists." });
    log(req, "Downloaded backup", req.params.name);
    res.download(p, `employee-hub-${req.params.name}`);
  });
  api.post("/backups/:name/restore", auth.requireOwner, async (req, res) => {
    const p = autoBackupPath(config.dataDir, req.params.name);
    if (!p) return res.status(404).json({ error: "That backup no longer exists." });
    await doRestore(req, await fsp.readFile(p), req.params.name);
    res.json({ ok: true });
  });

  app.use("/api/admin", api);

  // Static assets (CSS/JS). HTML pages are served through the routes above.
  app.use(express.static(PUBLIC, { index: false }));

  // ---------------------------------------------------------------------------
  // Errors
  // ---------------------------------------------------------------------------
  app.use((req, res) => {
    if (req.path.startsWith("/api/")) return res.status(404).json({ error: "Not found." });
    res.status(404).type("text/plain").send("Not found");
  });
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof ValidationError || err instanceof AdminError) return res.status(err.status || 400).json({ error: err.message });
    if (err instanceof multer.MulterError) {
      const max = req.path.endsWith("/restore") ? MAX_RESTORE_MB : MAX_IMAGE_MB;
      const msg = err.code === "LIMIT_FILE_SIZE" ? `The file is too big (max ${max} MB).` : "Please upload one file.";
      return res.status(400).json({ error: msg });
    }
    if (err && err.type === "entity.parse.failed") return res.status(400).json({ error: "The request body was not valid JSON." });
    if (err && err.type === "entity.too.large") return res.status(413).json({ error: "The request was too large." });
    console.error(err);
    res.status(500).json({ error: "Something went wrong on the server." });
  });

  return { app, ctx };
}

module.exports = { createApp, parseFrameAncestors, DEFAULT_FRAME_ANCESTORS, publicAdmin };
