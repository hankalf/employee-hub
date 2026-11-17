"use strict";

const path = require("path");
const crypto = require("crypto");
const { promisify } = require("util");
const { JsonFile } = require("./jsonfile");

const scrypt = promisify(crypto.scrypt);
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,39}$/;
const OWNER_USERNAME = "admin";

class AdminError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const key = await scrypt(String(password), salt, 32);
  return `scrypt$${salt}$${key.toString("hex")}`;
}

async function verifyPassword(password, stored) {
  const [kind, salt, hash] = String(stored || "").split("$");
  if (kind !== "scrypt" || !salt || !hash) return false;
  const key = await scrypt(String(password), salt, 32);
  const expected = Buffer.from(hash, "hex");
  return expected.length === key.length && crypto.timingSafeEqual(key, expected);
}

/** Readable temporary password, e.g. "maple-river-4821". */
function tempPassword() {
  const words = ["amber", "birch", "cedar", "delta", "ember", "frost", "grove", "harbor", "iris", "juniper", "kestrel", "lumen", "maple", "north", "orchid", "pine", "quartz", "river", "slate", "tundra", "upland", "violet", "willow", "zephyr"];
  const pick = () => words[crypto.randomInt(words.length)];
  return `${pick()}-${pick()}-${crypto.randomInt(1000, 10000)}`;
}

function checkNewPassword(password) {
  const p = String(password || "");
  if (p.length < 8) throw new AdminError("Passwords must be at least 8 characters.");
  if (p.length > 200) throw new AdminError("That password is too long.");
  return p;
}

const publicAdmin = (a) => ({
  id: a.id, username: a.username, name: a.name, role: "editor", active: a.active !== false,
  mustChangePassword: Boolean(a.mustChangePassword), createdAt: a.createdAt, lastLoginAt: a.lastLoginAt || "",
});

/**
 * Named admin accounts kept in admins.json. The built-in owner account ("admin" with ADMIN_PASSWORD)
 * is not stored here: it comes from the service variable.
 */
class Admins {
  constructor(dataDir) {
    this.file = new JsonFile(path.join(dataDir, "admins.json"), { admins: [] });
  }

  load() {
    const d = this.file.load();
    d.admins = Array.isArray(d.admins) ? d.admins : [];
  }

  all() { return this.file.get().admins; }
  list() { return this.all().map(publicAdmin); }
  byId(id) { return this.all().find((a) => a.id === id) || null; }
  byUsername(u) { const n = String(u || "").trim().toLowerCase(); return this.all().find((a) => a.username === n) || null; }

  /** Add an admin with a temporary password, shown once; they choose their own at first sign-in. */
  async create({ username, name }) {
    const u = String(username || "").trim().toLowerCase();
    if (!USERNAME_RE.test(u)) throw new AdminError("Usernames are 2–40 letters, numbers, dots, dashes or underscores.");
    if (u === OWNER_USERNAME) throw new AdminError(`"${OWNER_USERNAME}" is the owner's username.`);
    if (this.byUsername(u)) throw new AdminError("That username is already taken.");
    const displayName = String(name || "").trim().slice(0, 60) || u;
    const password = tempPassword();
    const admin = {
      id: crypto.randomBytes(6).toString("base64url"), username: u, name: displayName, active: true,
      passwordHash: await hashPassword(password), mustChangePassword: true, sessionVersion: 1,
      createdAt: new Date().toISOString(), lastLoginAt: "",
    };
    await this.file.update((d) => { d.admins.push(admin); });
    return { admin: publicAdmin(admin), tempPassword: password };
  }

  async update(id, { name, active }) {
    if (!this.byId(id)) throw new AdminError("That admin no longer exists.", 404);
    await this.file.update((d) => {
      const a = d.admins.find((x) => x.id === id);
      if (name !== undefined) a.name = String(name || "").trim().slice(0, 60) || a.username;
      if (active !== undefined) {
        a.active = Boolean(active);
        if (!a.active) a.sessionVersion = (a.sessionVersion || 1) + 1; // signs them out
      }
    });
    return publicAdmin(this.byId(id));
  }

  async resetPassword(id) {
    if (!this.byId(id)) throw new AdminError("That admin no longer exists.", 404);
    const password = tempPassword();
    const passwordHash = await hashPassword(password);
    await this.file.update((d) => {
      const a = d.admins.find((x) => x.id === id);
      a.passwordHash = passwordHash;
      a.mustChangePassword = true;
      a.sessionVersion = (a.sessionVersion || 1) + 1;
    });
    return { admin: publicAdmin(this.byId(id)), tempPassword: password };
  }

  async changePassword(id, current, next) {
    const a = this.byId(id);
    if (!a) throw new AdminError("That admin no longer exists.", 404);
    if (!(await verifyPassword(current, a.passwordHash))) throw new AdminError("Your current password isn't right.", 403);
    checkNewPassword(next);
    if (next === current) throw new AdminError("Choose a password different from the current one.");
    const passwordHash = await hashPassword(next);
    await this.file.update((d) => {
      const x = d.admins.find((y) => y.id === id);
      x.passwordHash = passwordHash;
      x.mustChangePassword = false;
      x.sessionVersion = (x.sessionVersion || 1) + 1;
    });
    return this.byId(id);
  }

  async remove(id) {
    if (!this.byId(id)) throw new AdminError("That admin no longer exists.", 404);
    await this.file.update((d) => { d.admins = d.admins.filter((a) => a.id !== id); });
  }

  async recordLogin(id) {
    await this.file.update((d) => {
      const a = d.admins.find((x) => x.id === id);
      if (a) a.lastLoginAt = new Date().toISOString();
    });
  }

  /** Replace everything (restore). */
  async replace(data) {
    const next = { admins: Array.isArray(data && data.admins) ? data.admins.filter((a) => a && a.id && a.username && a.passwordHash) : [] };
    await this.file.write(next);
    this.file.data = next;
  }
}

module.exports = { Admins, AdminError, hashPassword, verifyPassword, tempPassword, OWNER_USERNAME, publicAdmin };
