"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const archiver = require("archiver");
const AdmZip = require("adm-zip");
const { ValidationError } = require("./store");

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg)$/i;
const MAX_ENTRY_BYTES = 5 * 1024 * 1024;

/** A zip with content.json, stats.json, devices.json and the uploads folder (the logo). */
function createBackup({ store, stats, devices }) {
  return new Promise((resolve, reject) => {
    const archive = archiver("zip", { zlib: { level: 6 } });
    const chunks = [];
    archive.on("data", (c) => chunks.push(c));
    archive.on("error", reject);
    archive.on("end", () => resolve(Buffer.concat(chunks)));
    archive.append(JSON.stringify(store.get(), null, 2), { name: "content.json" });
    archive.append(JSON.stringify(stats.get(), null, 2), { name: "stats.json" });
    archive.append(JSON.stringify(devices.get(), null, 2), { name: "devices.json" });
    const logo = store.logoPath();
    if (logo) archive.file(logo, { name: `uploads/${path.basename(logo)}` });
    archive.finalize();
  });
}

/** Replace everything with the zip's contents. The content from just before is kept as before-restore-<time>.json. */
async function restoreBackup(buffer, { store, stats, devices }) {
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

  // Keep the current content in case the restore was a mistake (last two copies).
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await fsp.copyFile(store.contentPath, path.join(store.dataDir, `before-restore-${stamp}.json`)).catch(() => {});
  const olds = (await fsp.readdir(store.dataDir)).filter((f) => f.startsWith("before-restore-")).sort();
  for (const f of olds.slice(0, Math.max(0, olds.length - 2))) await fsp.unlink(path.join(store.dataDir, f)).catch(() => {});

  // The logo: only the file the backup's content.json points at, and only if it is a plain image file name.
  fs.mkdirSync(store.uploadsDir, { recursive: true });
  const logoName = typeof content.logo === "string" ? content.logo : "";
  if (logoName && IMAGE_EXT.test(logoName) && store.uploadPath(logoName)) {
    const e = entries.find((x) => x.entryName === `uploads/${logoName}` && !x.isDirectory);
    if (e && e.header.size <= MAX_ENTRY_BYTES) await fsp.writeFile(store.uploadPath(logoName), e.getData());
    else content.logo = "";
  } else {
    content.logo = "";
  }

  await store.replaceContent(content);
  // Remove images the restored content no longer uses.
  for (const f of await fsp.readdir(store.uploadsDir)) {
    if (f !== content.logo) await fsp.unlink(path.join(store.uploadsDir, f)).catch(() => {});
  }
  if (statsData && statsData.taps) { stats.get().taps = statsData.taps; await stats.flush(); }
  if (devicesData) { Object.keys(devices.get()).forEach((k) => delete devices.get()[k]); Object.assign(devices.get(), devicesData); await devices.flush(); }
}

module.exports = { createBackup, restoreBackup };
