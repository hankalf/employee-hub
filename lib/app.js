"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const multer = require("multer");
const { Store, ValidationError, verifyTilePin } = require("./store");
const { Stats, Devices } = require("./stats");
const { createBackup, restoreBackup } = require("./backup");
const { createAuth } = require("./auth");
const { describeLink, normalizeUrl } = require("./links");
const { encodeQr, toSvg } = require("./qr");

const ROOT = path.join(__dirname, "..");
const PUBLIC = path.join(ROOT, "public");
const VIEWS = path.join(ROOT, "views");
const MAX_LOGO_MB = 2;
const MAX_RESTORE_MB = 20;
const UNLOCK_MINUTES = 15;
const LOGO_TYPES = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp", "image/svg+xml": ".svg" };

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: https:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-src 'self' https:",   // monday.com forms (and any other https page an admin chooses) open inside the hub; the admin previews the kiosk
  "frame-ancestors 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

/**
 * Build the Express app. `config`: dataDir, adminPassword, sessionSecret, publicUrl
 */
async function createApp(config) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const store = new Store(config.dataDir);
  store.init();
  const stats = new Stats(config.dataDir);
  stats.load();
  const devices = new Devices(config.dataDir);
  devices.load();
  const auth = createAuth({ dataDir: config.dataDir, secret: config.sessionSecret, adminPassword: config.adminPassword });
  const tmpDir = path.join(config.dataDir, "tmp");
  fs.mkdirSync(tmpDir, { recursive: true });
  const logoUpload = multer({
    storage: multer.diskStorage({ destination: tmpDir, filename: (req, file, cb) => cb(null, crypto.randomBytes(8).toString("hex")) }),
    limits: { fileSize: MAX_LOGO_MB * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => cb(null, Boolean(LOGO_TYPES[file.mimetype])),
  });
  const restoreUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_RESTORE_MB * 1024 * 1024, files: 1 } });
  const ctx = { config, store, stats, devices, auth, restoring: false };

  const app = express();
  app.set("trust proxy", 1); // Railway terminates HTTPS in front of us
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "SAMEORIGIN",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Content-Security-Policy": CSP,
    });
    next();
  });
  app.get("/healthz", (req, res) => res.send("ok"));
  app.use(auth.attach);

  const page = (res, file) => { res.set("Cache-Control", "no-store"); res.sendFile(file); };
  const publicUrl = (req) => store.get().settings.publicUrl || config.publicUrl || `${req.protocol}://${req.get("host")}`;
  const smallJson = express.json({ limit: "4kb", type: ["application/json", "text/plain"] });

  // ---------------------------------------------------------------------------
  // Kiosk pages (no login: the hub is for everyone who scans the code)
  // ---------------------------------------------------------------------------
  app.get("/kiosk", (req, res) => page(res, path.join(PUBLIC, "index.html")));
  app.get(["/", "/index.html"], (req, res) => res.redirect(302, "/kiosk"));
  app.get("/open/t/:id", (req, res) => page(res, path.join(PUBLIC, "open.html")));
  app.get("/qr", (req, res) => page(res, path.join(PUBLIC, "qr.html")));

  app.get("/qr.svg", (req, res) => {
    const target = publicUrl(req);
    let svg;
    try {
      svg = toSvg(encodeQr(target), { title: `QR code linking to ${target}` });
    } catch (e) {
      return res.status(422).type("text/plain").send("The hub address is too long to turn into a QR code.");
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

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------
  app.get("/api/hub", (req, res) => {
    res.set("Cache-Control", "no-cache");
    res.json({ ...store.publicView(), publicUrl: publicUrl(req) });
  });

  // A tile was tapped (usage counts).
  app.post("/api/tap/:id", (req, res) => {
    const tile = store.findTile(req.params.id);
    if (tile && tile.active) stats.tap(tile.id);
    res.status(204).end();
  });

  // A kiosk device checking in, so the admin can see it's online.
  app.post("/api/heartbeat", smallJson, (req, res) => {
    const b = req.body || {};
    const id = String(b.deviceId || "");
    if (/^[a-f0-9]{16,32}$/.test(id)) devices.beat(id, { ua: req.get("user-agent"), screen: b.screen, path: b.path });
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
    res.json({ id: tile.id, title: tile.title, url: tile.url, embedUrl: tile.url ? describeLink(tile.url).embedUrl : "", open: tile.open });
  });

  // ---------------------------------------------------------------------------
  // Admin sign in / out
  // ---------------------------------------------------------------------------
  app.get("/admin/login", (req, res) => {
    if (req.isAdmin) return res.redirect("/admin");
    page(res, path.join(VIEWS, "login.html"));
  });

  app.post("/admin/login", express.urlencoded({ extended: false, limit: "10kb" }), (req, res) => {
    if (!auth.enabled) return res.redirect("/admin/login?error=disabled");
    if (auth.tooManyAttempts(req.ip)) return res.redirect("/admin/login?error=locked");
    const password = String((req.body && req.body.password) || "");
    if (!auth.checkPassword(password)) {
      auth.recordFailure(req.ip);
      console.warn(`Failed admin sign-in from ${req.ip}`);
      return res.redirect("/admin/login?error=wrong");
    }
    auth.recordSuccess(req.ip);
    auth.issue(res, req);
    res.redirect("/admin");
  });

  app.post("/admin/logout", (req, res) => {
    auth.clear(res);
    res.redirect("/admin/login?signedout=1");
  });

  app.get("/admin", (req, res) => {
    if (!req.isAdmin) return res.redirect("/admin/login");
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

  api.get("/content", (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ ...store.adminView(), publicUrl: publicUrl(req), adminEnabled: auth.enabled });
  });

  api.put("/settings", async (req, res) => res.json(await store.saveSettings(req.body)));
  api.put("/appearance", async (req, res) => res.json(await store.saveAppearance(req.body)));

  const strip = ({ pinHash, pinSalt, ...t }) => ({ ...t, hasPin: Boolean(pinHash) });
  api.post("/tiles", async (req, res) => res.status(201).json(strip(await store.addTile(req.body))));
  api.put("/tiles/order", async (req, res) => { await store.reorderTiles(req.body && req.body.ids); res.json({ ok: true }); });
  api.put("/tiles/:id", async (req, res) => res.json(strip(await store.editTile(req.params.id, req.body))));
  api.delete("/tiles/:id", async (req, res) => { await store.removeTile(req.params.id); stats.remove(req.params.id); res.json({ ok: true }); });

  api.post("/groups", async (req, res) => res.status(201).json(await store.addGroup(req.body)));
  api.put("/groups/order", async (req, res) => { await store.reorderGroups(req.body && req.body.ids); res.json({ ok: true }); });
  api.put("/groups/:id", async (req, res) => res.json(await store.editGroup(req.params.id, req.body)));
  api.delete("/groups/:id", async (req, res) => { await store.removeGroup(req.params.id); res.json({ ok: true }); });

  api.post("/notes", async (req, res) => res.status(201).json(await store.addNote(req.body)));
  api.put("/notes/order", async (req, res) => { await store.reorderNotes(req.body && req.body.ids); res.json({ ok: true }); });
  api.put("/notes/:id", async (req, res) => res.json(await store.editNote(req.params.id, req.body)));
  api.delete("/notes/:id", async (req, res) => { await store.removeNote(req.params.id); res.json({ ok: true }); });

  // What is this link? Lets the admin page say "monday.com form — opens inside the hub" as you paste.
  api.get("/link-info", (req, res) => {
    let url;
    try { url = normalizeUrl(req.query.url); } catch (e) { return res.json({ ok: false, error: e.message }); }
    res.json({ ok: true, url, ...describeLink(url) });
  });

  api.post("/logo", logoUpload.single("logo"), async (req, res) => {
    if (!req.file) throw new ValidationError("Choose a PNG, JPG, GIF, WebP or SVG image.");
    const name = `logo-${Date.now()}${LOGO_TYPES[req.file.mimetype]}`;
    const old = store.logoPath();
    await fsp.rename(req.file.path, store.uploadPath(name));
    await store.setLogo(name);
    if (old) await fsp.unlink(old).catch(() => {});
    res.json({ logo: name });
  });

  api.delete("/logo", async (req, res) => {
    const old = store.logoPath();
    await store.setLogo("");
    if (old) await fsp.unlink(old).catch(() => {});
    res.json({ ok: true });
  });

  // Usage counts and kiosk devices
  api.get("/stats", (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ usage: stats.summary(), devices: devices.list(), now: new Date().toISOString() });
  });
  api.put("/devices/:id", (req, res) => {
    if (!devices.rename(req.params.id, req.body && req.body.name)) return res.status(404).json({ error: "That kiosk is no longer listed." });
    res.json({ ok: true });
  });
  api.delete("/devices/:id", (req, res) => {
    devices.forget(req.params.id);
    res.json({ ok: true });
  });

  // Backup and restore
  api.get("/backup", async (req, res) => {
    await stats.flush();
    await devices.flush();
    const zip = await createBackup({ store, stats, devices });
    const stamp = new Date().toISOString().slice(0, 10);
    res.set("Content-Disposition", `attachment; filename="employee-hub-backup-${stamp}.zip"`);
    res.type("application/zip").send(zip);
  });
  api.post("/restore", restoreUpload.single("backup"), async (req, res) => {
    if (!req.file) throw new ValidationError("Choose a backup zip first.");
    ctx.restoring = true;
    try {
      await restoreBackup(req.file.buffer, { store, stats, devices });
    } finally {
      ctx.restoring = false;
    }
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
    if (err instanceof ValidationError) return res.status(err.status || 400).json({ error: err.message });
    if (err instanceof multer.MulterError) {
      const max = req.path.endsWith("/restore") ? MAX_RESTORE_MB : MAX_LOGO_MB;
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

module.exports = { createApp };
