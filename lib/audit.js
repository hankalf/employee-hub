"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const MAX_BYTES = 5 * 1024 * 1024;

/**
 * Append-only activity log (one JSON object per line): who changed what, and when.
 * Rotates to activity.1.log past 5 MB, so roughly the last 50,000 entries are kept.
 */
class Audit {
  constructor(dataDir) {
    this.file = path.join(dataDir, "activity.log");
    this.old = path.join(dataDir, "activity.1.log");
    this.queue = Promise.resolve();
  }

  log(admin, action, detail) {
    const entry = {
      at: new Date().toISOString(),
      user: admin ? admin.username : "system",
      name: admin ? admin.name : "System",
      action,
      detail: String(detail || "").slice(0, 500),
    };
    this.queue = this.queue.then(async () => {
      const st = await fsp.stat(this.file).catch(() => null);
      if (st && st.size > MAX_BYTES) await fsp.rename(this.file, this.old).catch(() => {});
      await fsp.appendFile(this.file, JSON.stringify(entry) + "\n");
    }).catch((err) => console.error("Activity log write failed:", err.message));
    return this.queue;
  }

  /** Most recent entries first. */
  async recent(limit = 500) {
    await this.queue;
    const lines = [];
    for (const f of [this.file, this.old]) {
      if (lines.length >= limit || !fs.existsSync(f)) continue;
      const text = await fsp.readFile(f, "utf8");
      lines.push(...text.trim().split("\n").filter(Boolean).reverse());
    }
    return lines.slice(0, limit).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  }
}

/** A CSV cell, quoted, and safe to open in Excel (no formula injection). */
function csvCell(v) {
  let s = String(v == null ? "" : v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}
const toCsv = (rows) => rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";

module.exports = { Audit, toCsv, csvCell };
