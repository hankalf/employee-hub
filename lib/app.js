"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const multer = require("multer");
const { Store, ValidationError } = require("./store");
const { createAuth } = require("./auth");
const { describeLink, normalizeUrl } = require("./links");
const { encodeQr, toSvg } = require("./qr");

const ROOT = path.join(__dirname, "..");
const PUBLIC = path.join(ROOT, "public");
const VIEWS = path.join(ROOT, "views");
const MAX_LOGO_MB = 2;
const LOGO_TYPES = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp", "image/svg+xml": ".svg" };

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: https:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-src 'self' https:",   // monday.com forms (and any other https page an admin chooses) open inside the hub; the admin previews the kiosk
  "frame-ancestors 'self'",    // the admin page previews the kiosk in a frame
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
  const auth = createAuth({ dataDir: config.dataDir, secret: config.sessionSecret, adminPassword: config.adminPassword });
  const tmpDir = path.join(config.dataDir, "tmp");
  fs.mkdirSync(tmpDir, { recursive: true });
  const logoUpload = multer({
    storage: multer.diskStorage({ destination: tmpDir, filename: (req, file, cb) => cb(null, crypto.randomBytes(8).toString("hex")) }),
    limits: { fileSize: MAX_LOGO_MB * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => cb(null, Boolean(LOGO_TYPES[file.mimetype])),
  });
  const ctx = { config, store, auth };

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

  // ---------------------------------------------------------------------------
  // Kiosk pages (no login: the hub is for everyone who scans the code)
  // ---------------------------------------------------------------------------
  app.get("/kiosk", (req, res) => page(res, path.join(PUBLIC, "index.html")));
  app.get(["/", "/index.html"], (req, res) => res.redirect(302, "/kiosk"));
  app.get(["/open/t/:id"], (req, res) => page(res, path.join(PUBLIC, "open.html")));
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

  api.get("/content", (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ ...store.get(), logo: store.logoPath() ? store.get().logo : "", publicUrl: publicUrl(req), adminEnabled: auth.enabled });
  });

  api.put("/settings", async (req, res) => res.json(await store.saveSettings(req.body)));
  api.put("/note", async (req, res) => res.json(await store.saveNote(req.body)));
  api.put("/appearance", async (req, res) => res.json(await store.saveAppearance(req.body)));

  api.post("/tiles", async (req, res) => res.status(201).json(await store.addTile(req.body)));
  api.put("/tiles/order", async (req, res) => {
    await store.reorderTiles(req.body && req.body.ids);
    res.json({ ok: true });
  });
  api.put("/tiles/:id", async (req, res) => res.json(await store.editTile(req.params.id, req.body)));
  api.delete("/tiles/:id", async (req, res) => {
    await store.removeTile(req.params.id);
    res.json({ ok: true });
  });

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
      const msg = err.code === "LIMIT_FILE_SIZE" ? `The image is too big (max ${MAX_LOGO_MB} MB).` : "Please upload one image file.";
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
