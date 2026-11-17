"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { verifyPassword, hashPassword, OWNER_USERNAME } = require("./admins");

const COOKIE = "hub_admin";
const SESSION_HOURS = 12;

/** A signing key that survives restarts: SESSION_SECRET, or one generated once and kept in DATA_DIR. */
function loadSecret(dataDir, envSecret) {
  if (envSecret) return envSecret;
  const file = path.join(dataDir, "session.key");
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
  return fs.readFileSync(file, "utf8").trim();
}

function sha(s) {
  return crypto.createHash("sha256").update(String(s)).digest();
}

/** Counts failures per key inside a 15 minute window. */
function limiter(max) {
  const WINDOW = 15 * 60 * 1000;
  const buckets = new Map();
  return {
    tooMany(key) {
      const b = buckets.get(key);
      return Boolean(b) && Date.now() - b.first <= WINDOW && b.count >= max;
    },
    fail(key) {
      const b = buckets.get(key);
      if (!b || Date.now() - b.first > WINDOW) buckets.set(key, { first: Date.now(), count: 1 });
      else b.count++;
      if (buckets.size > 10000) buckets.clear();
    },
    ok(key) { buckets.delete(key); },
  };
}

/**
 * Two kinds of admin:
 *   - the owner: username "admin", password ADMIN_PASSWORD (a service variable). Can do everything,
 *     including managing other admins and restoring backups.
 *   - named admins (editors) from admins.json, added by the owner. Everything else.
 * A signed cookie remembers the login for 12 hours. It carries a fingerprint of ADMIN_PASSWORD for the
 * owner, or the admin's session version, so changing a password signs that account out everywhere.
 */
function createAuth({ dataDir, secret, adminPassword, admins }) {
  const key = crypto.createHash("sha256").update("hub-session:" + loadSecret(dataDir, secret)).digest();
  const sign = (data) => crypto.createHmac("sha256", key).update(data).digest("base64url");
  const fingerprint = adminPassword ? crypto.createHmac("sha256", key).update("pw:" + adminPassword).digest("base64url").slice(0, 16) : "";
  const ownerEnabled = Boolean(adminPassword);
  let dummyHash = "";
  hashPassword("not-a-real-password").then((h) => { dummyHash = h; });

  const OWNER = { id: "owner", username: OWNER_USERNAME, name: "Owner", role: "owner", mustChangePassword: false };
  const editor = (a) => ({ id: a.id, username: a.username, name: a.name, role: "editor", mustChangePassword: Boolean(a.mustChangePassword) });

  /** Is there any way to sign in? */
  const enabled = () => ownerEnabled || admins.all().some((a) => a.active !== false);

  /** Check a username and password. Returns the admin, or null. Takes about the same time either way. */
  async function authenticate(username, password) {
    const u = String(username || "").trim().toLowerCase();
    if (!u || u === OWNER_USERNAME) {
      if (!ownerEnabled) { await verifyPassword(password, dummyHash); return null; }
      await verifyPassword(password, dummyHash); // even out timing with named admins
      return crypto.timingSafeEqual(sha(password), sha(adminPassword)) ? OWNER : null;
    }
    const a = admins.byUsername(u);
    const ok = await verifyPassword(password, a ? a.passwordHash : dummyHash);
    return ok && a && a.active !== false ? editor(a) : null;
  }

  function cookieOptions(req) {
    // Over HTTPS: SameSite=None + Partitioned so signing in works while the hub is shown inside monday.com.
    return req.secure
      ? { httpOnly: true, secure: true, sameSite: "none", partitioned: true, path: "/" }
      : { httpOnly: true, secure: false, sameSite: "lax", path: "/" };
  }

  function issue(res, req, admin) {
    const body = admin.id === "owner"
      ? { u: "owner", f: fingerprint }
      : { u: admin.id, v: (admins.byId(admin.id) || {}).sessionVersion || 1 };
    const payload = Buffer.from(JSON.stringify({ ...body, e: Date.now() + SESSION_HOURS * 3600 * 1000 })).toString("base64url");
    res.cookie(COOKIE, payload + "." + sign(payload), { ...cookieOptions(req), maxAge: SESSION_HOURS * 3600 * 1000 });
  }

  function clear(res, req) {
    res.clearCookie(COOKIE, cookieOptions(req || { secure: false }));
    if (req && req.secure) res.clearCookie(COOKIE, { path: "/", secure: true, sameSite: "lax", httpOnly: true }); // cookie from before partitioning
  }

  function readCookie(req) {
    for (const part of (req.headers.cookie || "").split(";")) {
      const [k, ...v] = part.trim().split("=");
      if (k === COOKIE) return decodeURIComponent(v.join("="));
    }
    return "";
  }

  /** Verify "payload.signature" and return the payload object, or null. */
  function open(token) {
    const [payload, sig] = String(token || "").split(".");
    if (!payload || !sig) return null;
    if (!crypto.timingSafeEqual(sha(sig), sha(sign(payload)))) return null;
    let data;
    try { data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch (e) { return null; }
    return data && data.e > Date.now() ? data : null;
  }

  function currentAdmin(req) {
    const data = open(readCookie(req));
    if (!data) return null;
    if (data.u === "owner") return ownerEnabled && data.f === fingerprint ? OWNER : null;
    const a = admins.byId(data.u);
    if (!a || a.active === false || (a.sessionVersion || 1) !== data.v) return null;
    return editor(a);
  }

  /** Short-lived signed tokens, e.g. "this kiosk entered the right PIN for tile X". */
  function signToken(obj, ttlMs) {
    const payload = Buffer.from(JSON.stringify({ ...obj, e: Date.now() + ttlMs })).toString("base64url");
    return payload + "." + sign(payload);
  }

  function attach(req, res, next) {
    req.admin = currentAdmin(req);
    req.isAdmin = Boolean(req.admin);
    next();
  }

  // API calls that change things must carry this header; browsers won't send it cross-site.
  function csrf(req, res, next) {
    if (req.method !== "GET" && req.method !== "HEAD" && req.get("X-Requested-With") !== "hub") {
      return res.status(403).json({ error: "Bad request origin." });
    }
    next();
  }

  /** Signed in, and (for a new admin) has chosen their own password. */
  function requireAdminApi(req, res, next) {
    if (!req.admin) return res.status(401).json({ error: "Please sign in again." });
    if (req.admin.mustChangePassword && !/^\/me(\/|$)/.test(req.path)) {
      return res.status(403).json({ error: "Please choose your own password first.", code: "mustChangePassword" });
    }
    next();
  }

  function requireOwner(req, res, next) {
    if (!req.admin || req.admin.role !== "owner") return res.status(403).json({ error: "Only the owner (the \"admin\" login) can do that." });
    next();
  }

  const login = limiter(10);
  const loginUser = limiter(10);
  const pins = limiter(15);

  return {
    enabled, authenticate, issue, clear, attach, csrf, requireAdminApi, requireOwner, signToken, verifyToken: open,
    tooManyAttempts: (ip, username) => login.tooMany(ip) || loginUser.tooMany(String(username || "").toLowerCase()),
    recordFailure: (ip, username) => { login.fail(ip); loginUser.fail(String(username || "").toLowerCase()); },
    recordSuccess: (ip, username) => { login.ok(ip); loginUser.ok(String(username || "").toLowerCase()); },
    tooManyPinTries: pins.tooMany, recordPinFailure: pins.fail, recordPinSuccess: pins.ok,
  };
}

module.exports = { createAuth };
