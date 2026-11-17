"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const archiver = require("archiver");
const AdmZip = require("adm-zip");
const { ValidationError, normalizeContent } = require("./store");

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg)$/i;
const MAX_ENTRY_BYTES = 5 * 1024 * 1024;
const AUTO_KEEP = 7;
const AUTO_RE = /^auto-\d{4}-\d{2}-\d{2}\.zip$/;

/**
 * A zip with content.json (tiles, groups, notes, settings), stats.json (tap counts), devices.json (kiosks),
 * admins.json (named admin logins, passwords hashed) and the images in use (logo, tile icons).
 */
function createBackup({ store, stats, devices, admins }) {
  return new Promise((resolve, reject) => {
    const archive = archiver("zip", { zlib: { level: 6 } });
    const chunks = [];
    archive.on("data", (c) => chunks.push(c));
    archive.on("error", reject);
    archive.on("end", () => resolve(Buffer.concat(chunks)));
    archive.append(JSON.stringify(store.get(), null, 2), { name: "content.json" });
    archive.append(JSON.stringify(stats.get(), null, 2), { name: "stats.json" });
    archive.append(JSON.stringify(devices.get(), null, 2), { name: "devices.json" });
    if (admins) archive.append(JSON.stringify(admins.file.get(), null, 2), { name: "admins.json" });
    for (const name of store.referencedImages()) {
      const p = store.uploadPath(name);
      if (p && fs.existsSync(p)) archive.file(p, { name: `uploads/${name}` });
    }
    archive.finalize();
  });
}

/** Image names a content.json refers to (logo and tile icons). */
function imagesIn(content) {
  const refs = new Set();
  if (typeof content.logo === "string" && content.logo) refs.add(content.logo);
  const add = (icon) => { if (typeof icon === "string" && icon.startsWith("img:")) refs.add(icon.slice(4)); };
  (content.tiles || []).forEach((t) => add(t && t.icon));
  (content.trash || []).forEach((e) => add(e && e.item && e.item.icon));
  return refs;
}

/** Replace everything with the zip's contents. The content from just before is kept as before-restore-<time>.json. */
async function restoreBackup(buffer, { store, stats, devices, admins }) {
  let zip;
  try { zip = new AdmZip(buffer); } catch (e) { throw new ValidationError("That file isn't a zip."); }
  const entries = zip.getEntries();
  const entry = entries.find((e) => e.entryName === "content.json");
  if (!entry) throw new ValidationError("That zip doesn't look like an Employee Hub backup (no content.json).");
  let content;
  try { content = JSON.parse(entry.getData().toString("utf8")); } catch (e) { throw new ValidationError("content.json in the backup is not valid JSON."); }
  if (!content || typeof content !== "object" || !Array.isArray(content.tiles)) throw new ValidationError("That file doesn't look like an Employee Hub backup.");

  const readJson = (name) => {
    const e = entries.find((x) => x.entryName === name);
    if (!e) return null;
    try { const v = JSON.parse(e.getData().toString("utf8")); return v && typeof v === "object" ? v : null; } catch (err) { return null; }
  };
  const statsData = readJson("stats.json");
  const devicesData = readJson("devices.json");
  const adminsData = readJson("admins.json");

  // Keep the current content in case the restore was a mistake (last two copies).
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await fsp.copyFile(store.contentPath, path.join(store.dataDir, `before-restore-${stamp}.json`)).catch(() => {});
  const olds = (await fsp.readdir(store.dataDir)).filter((f) => f.startsWith("before-restore-")).sort();
  for (const f of olds.slice(0, Math.max(0, olds.length - 2))) await fsp.unlink(path.join(store.dataDir, f)).catch(() => {});

  // Images: only the ones the backup's content refers to, and only plain image file names.
  fs.mkdirSync(store.uploadsDir, { recursive: true });
  const wanted = imagesIn(content);
  const restored = new Set();
  for (const name of wanted) {
    if (!IMAGE_EXT.test(name) || !store.uploadPath(name)) continue;
    const e = entries.find((x) => x.entryName === `uploads/${name}` && !x.isDirectory);
    if (e && e.header.size <= MAX_ENTRY_BYTES) { await fsp.writeFile(store.uploadPath(name), e.getData()); restored.add(name); }
  }
  if (content.logo && !restored.has(content.logo)) content.logo = "";
  for (const t of content.tiles) if (t && typeof t.icon === "string" && t.icon.startsWith("img:") && !restored.has(t.icon.slice(4))) t.icon = "link";

  await store.replaceContent(content);
  // Remove images the restored content no longer uses.
  const keep = store.referencedImages();
  for (const f of await fsp.readdir(store.uploadsDir)) if (!keep.has(f)) await fsp.unlink(path.join(store.uploadsDir, f)).catch(() => {});
  if (statsData && statsData.taps) await stats.replace({ taps: statsData.taps });
  if (devicesData) await devices.replace(devicesData);
  if (adminsData && admins) await admins.replace(adminsData);
}

// --- automatic nightly backups ----------------------------------------------------

function autoDir(dataDir) { return path.join(dataDir, "backups"); }

/** Write today's automatic backup (replacing an earlier one from today) and keep the last 7. */
async function writeAutoBackup(ctx) {
  const dir = autoDir(ctx.store.dataDir);
  await fsp.mkdir(dir, { recursive: true });
  const name = `auto-${new Date().toISOString().slice(0, 10)}.zip`;
  const buf = await createBackup(ctx);
  const tmp = path.join(dir, `${name}.${process.pid}.tmp`);
  await fsp.writeFile(tmp, buf);
  await fsp.rename(tmp, path.join(dir, name));
  const all = (await fsp.readdir(dir)).filter((f) => AUTO_RE.test(f)).sort();
  for (const f of all.slice(0, Math.max(0, all.length - AUTO_KEEP))) await fsp.unlink(path.join(dir, f)).catch(() => {});
  return name;
}

async function listAutoBackups(dataDir) {
  const dir = autoDir(dataDir);
  const files = (await fsp.readdir(dir).catch(() => [])).filter((f) => AUTO_RE.test(f)).sort().reverse();
  return Promise.all(files.map(async (name) => {
    const st = await fsp.stat(path.join(dir, name));
    return { name, size: st.size, at: st.mtime.toISOString() };
  }));
}

/** Path of an automatic backup by name, or null (never anything outside the backups folder). */
function autoBackupPath(dataDir, name) {
  if (!AUTO_RE.test(String(name || ""))) return null;
  const p = path.join(autoDir(dataDir), name);
  return fs.existsSync(p) ? p : null;
}

module.exports = { createBackup, restoreBackup, writeAutoBackup, listAutoBackups, autoBackupPath, imagesIn, AUTO_KEEP };
