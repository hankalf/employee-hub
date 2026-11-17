"use strict";

const path = require("path");
const { JsonFile } = require("./jsonfile");

const KEEP_DAYS = 90;
const MAX_DEVICES = 100;
const FORGET_UNNAMED_DAYS = 30;
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
  /** Replace everything (restore). */
  async replace(data) {
    this.file.data = data;
    await this.flush();
  }
}

/**
 * Tile tap counts: a total, the last tap, a count per day and per hour of the day (the kiosk's local hour)
 * for the last 90 days.
 */
class Stats extends LazyFile {
  constructor(dataDir) { super(path.join(dataDir, "stats.json"), { taps: {} }); }

  load() {
    const d = super.load();
    d.taps = d.taps && typeof d.taps === "object" ? d.taps : {};
    return d;
  }

  tap(tileId, hour) {
    const d = this.get();
    const t = d.taps[tileId] || (d.taps[tileId] = { total: 0, lastAt: "", days: {}, hours: {} });
    t.hours = t.hours || {};
    const today = ymd();
    const h = Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : new Date().getUTCHours();
    t.total++;
    t.lastAt = new Date().toISOString();
    t.days[today] = (t.days[today] || 0) + 1;
    const row = t.hours[today] || (t.hours[today] = new Array(24).fill(0));
    row[h]++;
    const cutoff = daysAgo(KEEP_DAYS);
    for (const day of Object.keys(t.days)) if (day < cutoff) delete t.days[day];
    for (const day of Object.keys(t.hours)) if (day < cutoff) delete t.hours[day];
    this.touch();
  }

  remove(tileId) {
    const d = this.get();
    if (d.taps[tileId]) { delete d.taps[tileId]; this.touch(); }
  }

  /** { tileId: { total, last7, last30, lastAt, hours30: [24 numbers] } } */
  summary() {
    const out = {};
    const d7 = daysAgo(6), d30 = daysAgo(29);
    for (const [id, t] of Object.entries(this.get().taps)) {
      let last7 = 0, last30 = 0;
      const hours30 = new Array(24).fill(0);
      for (const [day, n] of Object.entries(t.days || {})) {
        if (day >= d30) last30 += n;
        if (day >= d7) last7 += n;
      }
      for (const [day, row] of Object.entries(t.hours || {})) {
        if (day >= d30 && Array.isArray(row)) row.forEach((n, i) => { hours30[i] += Number(n) || 0; });
      }
      out[id] = { total: t.total || 0, last7, last30, lastAt: t.lastAt || "", hours30 };
    }
    return out;
  }

  /** Rows for a spreadsheet: one per tile per day, with the taps in each hour of that day. */
  rows(titleOf) {
    const header = ["Date", "Tile", "Taps", ...Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, "0")}:00`)];
    const rows = [];
    for (const [id, t] of Object.entries(this.get().taps)) {
      for (const [day, n] of Object.entries(t.days || {})) {
        const hours = (t.hours || {})[day];
        rows.push([day, titleOf(id), n, ...(Array.isArray(hours) ? hours : new Array(24).fill(""))]);
      }
    }
    rows.sort((a, b) => (b[0] + a[1]).localeCompare(a[0] + b[1]));
    return [header, ...rows];
  }
}

/**
 * Devices showing the kiosk, so the admin can see which are online, name them, choose which tiles each
 * shows, and get an alert when a watched one goes quiet.
 */
class Devices extends LazyFile {
  constructor(dataDir) { super(path.join(dataDir, "devices.json"), {}); }

  beat(id, info = {}) {
    const d = this.get();
    const now = new Date().toISOString();
    const prev = d[id] || { name: "", firstSeen: now, watch: false, groups: null, alertedAt: null };
    d[id] = {
      ...prev, firstSeen: prev.firstSeen || now, lastSeen: now,
      ua: String(info.ua || "").slice(0, 200), screen: String(info.screen || "").slice(0, 20), path: String(info.path || "").slice(0, 100),
      model: String(info.model || "").replace(/[^\w .-]/g, "").slice(0, 40), scanner: Boolean(info.scanner),
    };
    this.prune();
    this.touch();
  }

  /** Drop phones that scanned the QR once: unnamed, unwatched devices not seen for 30 days; and keep at most 100. */
  prune() {
    const d = this.get();
    const cutoff = new Date(Date.now() - FORGET_UNNAMED_DAYS * 86400000).toISOString();
    for (const [id, v] of Object.entries(d)) if (!v.name && !v.watch && !v.groups && (!v.layout || v.layout === "auto") && (v.lastSeen || "") < cutoff) delete d[id];
    const ids = Object.keys(d);
    if (ids.length > MAX_DEVICES) {
      ids.filter((id) => !d[id].name && !d[id].watch).sort((a, b) => (d[a].lastSeen || "").localeCompare(d[b].lastSeen || ""))
        .slice(0, ids.length - MAX_DEVICES).forEach((id) => delete d[id]);
    }
  }

  list() {
    return Object.entries(this.get()).map(([id, v]) => ({ id, watch: false, groups: null, alertedAt: null, layout: "auto", model: "", scanner: false, ...v }))
      .sort((a, b) => (b.lastSeen || "").localeCompare(a.lastSeen || ""));
  }

  get1(id) { return this.get()[id] || null; }

  /** Change name, watch, or groups (null = all tiles, or a list of group ids where "" means tiles without a group). */
  set(id, fields) {
    const d = this.get();
    if (!d[id]) return false;
    if (fields.name !== undefined) d[id].name = String(fields.name || "").trim().slice(0, 60);
    if (fields.watch !== undefined) { d[id].watch = Boolean(fields.watch); if (!d[id].watch) d[id].alertedAt = null; }
    if (fields.groups !== undefined) d[id].groups = fields.groups;
    if (fields.layout !== undefined) d[id].layout = fields.layout;
    this.touch();
    return true;
  }

  rename(id, name) { return this.set(id, { name }); }

  markAlerted(id, at) {
    const d = this.get();
    if (d[id]) { d[id].alertedAt = at; this.touch(); }
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
