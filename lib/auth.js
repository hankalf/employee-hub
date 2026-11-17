"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

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
 * The admin area has one login: the ADMIN_PASSWORD service variable. A signed
 * cookie remembers the login for 12 hours. The cookie also carries a fingerprint
 * of the password, so changing ADMIN_PASSWORD signs every admin out.
 */
function createAuth({ dataDir, secret, adminPassword }) {
  const key = crypto.createHash("sha256").update("hub-session:" + loadSecret(dataDir, secret)).digest();
  const sign = (data) => crypto.createHmac("sha256", key).update(data).digest("base64url");
  const fingerprint = adminPassword ? crypto.createHmac("sha256", key).update("pw:" + adminPassword).digest("base64url").slice(0, 16) : "";
  const enabled = Boolean(adminPassword);

  function checkPassword(candidate) {
    if (!enabled) return false;
    return crypto.timingSafeEqual(sha(candidate), sha(adminPassword));
  }

  function issue(res, req) {
    const payload = Buffer.from(JSON.stringify({ f: fingerprint, e: Date.now() + SESSION_HOURS * 3600 * 1000 })).toString("base64url");
    res.cookie(COOKIE, payload + "." + sign(payload), {
      httpOnly: true, sameSite: "lax", secure: req.secure, maxAge: SESSION_HOURS * 3600 * 1000, path: "/",
    });
  }

  function clear(res) {
    res.clearCookie(COOKIE, { path: "/" });
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

  function isAdmin(req) {
    if (!enabled) return false;
    const data = open(readCookie(req));
    return Boolean(data) && data.f === fingerprint;
  }

  /** Short-lived signed tokens, e.g. "this kiosk entered the right PIN for tile X". */
  function signToken(obj, ttlMs) {
    const payload = Buffer.from(JSON.stringify({ ...obj, e: Date.now() + ttlMs })).toString("base64url");
    return payload + "." + sign(payload);
  }

  function attach(req, res, next) {
    req.isAdmin = isAdmin(req);
    next();
  }

  // API calls that change things must carry this header; browsers won't send it cross-site.
  function csrf(req, res, next) {
    if (req.method !== "GET" && req.method !== "HEAD" && req.get("X-Requested-With") !== "hub") {
      return res.status(403).json({ error: "Bad request origin." });
    }
    next();
  }

  function requireAdminApi(req, res, next) {
    if (!req.isAdmin) return res.status(401).json({ error: "Please sign in again." });
    next();
  }

  const login = limiter(10);
  const pins = limiter(15);

  return {
    enabled, checkPassword, issue, clear, attach, csrf, requireAdminApi, signToken, verifyToken: open,
    tooManyAttempts: login.tooMany, recordFailure: login.fail, recordSuccess: login.ok,
    tooManyPinTries: pins.tooMany, recordPinFailure: pins.fail, recordPinSuccess: pins.ok,
  };
}

module.exports = { createAuth };
