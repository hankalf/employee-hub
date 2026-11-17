"use strict";

const path = require("path");
const { JsonFile } = require("./jsonfile");

const KEEP_DAYS = 90;
const MAX_DEVICES = 50;
const ymd = (d = new Date()) => d.toISOString().slice(0, 10);
const daysAgo = (n) => ymd(new Date(Date.now() - n * 86400000));

/** A small file that is written a couple of seconds after the last change rather than on every change. */
class LazyFile {
  constructor(file, defaults) {
    this.file = new JsonFile(file, defaults);
    this.timer = null;
  }
  load() { return this.file.load(); }
  get() { return this.file.get(); }
  touch() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.file.write(this.file.get()).catch((e) => console.error("Could not save", this.file.path, e.message)); }, 2000);
    this.timer.unref();
  }
  async flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    await this.file.write(this.file.get());
  }
}

/** Tile tap counts: a total, the last tap, and a count per day for the last 90 days. */
class Stats extends LazyFile {
  constructor(dataDir) { super(path.join(dataDir, "stats.json"), { taps: {} }); }

  tap(tileId) {
    const d = this.get();
    const t = d.taps[tileId] || (d.taps[tileId] = { total: 0, lastAt: "", days: {} });
    const today = ymd();
    t.total++;
    t.lastAt = new Date().toISOString();
    t.days[today] = (t.days[today] || 0) + 1;
    const cutoff = daysAgo(KEEP_DAYS);
    for (const day of Object.keys(t.days)) if (day < cutoff) delete t.days[day];
    this.touch();
  }

  remove(tileId) {
    const d = this.get();
    if (d.taps[tileId]) { delete d.taps[tileId]; this.touch(); }
  }

  /** { tileId: { total, last7, last30, lastAt } } */
  summary() {
    const out = {};
    const d7 = daysAgo(6), d30 = daysAgo(29);
    for (const [id, t] of Object.entries(this.get().taps)) {
      let last7 = 0, last30 = 0;
      for (const [day, n] of Object.entries(t.days || {})) {
        if (day >= d30) last30 += n;
        if (day >= d7) last7 += n;
      }
      out[id] = { total: t.total || 0, last7, last30, lastAt: t.lastAt || "" };
    }
    return out;
  }
}

/** Kiosk devices that have reported in, so the admin can see which iPads are online. */
class Devices extends LazyFile {
  constructor(dataDir) { super(path.join(dataDir, "devices.json"), {}); }

  beat(id, info = {}) {
    const d = this.get();
    const now = new Date().toISOString();
    const prev = d[id] || { name: "", firstSeen: now };
    d[id] = { name: prev.name || "", firstSeen: prev.firstSeen || now, lastSeen: now,
      ua: String(info.ua || "").slice(0, 200), screen: String(info.screen || "").slice(0, 20), path: String(info.path || "").slice(0, 100) };
    const ids = Object.keys(d);
    if (ids.length > MAX_DEVICES) {
      ids.sort((a, b) => (d[a].lastSeen || "").localeCompare(d[b].lastSeen || ""));
      for (const old of ids.slice(0, ids.length - MAX_DEVICES)) delete d[old];
    }
    this.touch();
  }

  list() {
    return Object.entries(this.get()).map(([id, v]) => ({ id, ...v })).sort((a, b) => (b.lastSeen || "").localeCompare(a.lastSeen || ""));
  }

  rename(id, name) {
    const d = this.get();
    if (!d[id]) return false;
    d[id].name = String(name || "").trim().slice(0, 60);
    this.touch();
    return true;
  }

  forget(id) {
    const d = this.get();
    if (!d[id]) return false;
    delete d[id];
    this.touch();
    return true;
  }
}

module.exports = { Stats, Devices };
