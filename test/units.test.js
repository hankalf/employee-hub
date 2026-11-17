"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const jsQR = require("jsqr");
const { normalizeUrl, describeLink } = require("../lib/links");
const { encodeQr, toSvg } = require("../lib/qr");
const { validateTile, validateSettings, validateNote, validateAppearance, ValidationError, DEFAULT_APPEARANCE } = require("../lib/store");

test("normalizeUrl adds https and rejects non-web links", () => {
  assert.equal(normalizeUrl("forms.monday.com/forms/abc?r=use1"), "https://forms.monday.com/forms/abc?r=use1");
  assert.equal(normalizeUrl("  https://Example.com/Path "), "https://example.com/Path");
  assert.equal(normalizeUrl("", { allowEmpty: true }), "");
  assert.throws(() => normalizeUrl(""), /enter a link/);
  assert.throws(() => normalizeUrl("javascript:alert(1)"), /http/);
  assert.throws(() => normalizeUrl("not a url"), /web address/);
});

test("describeLink turns a monday form share link into its embed address", () => {
  const d = describeLink("https://forms.monday.com/forms/9f8e7d6c?r=use1");
  assert.equal(d.kind, "form");
  assert.equal(d.embedUrl, "https://forms.monday.com/forms/embed/9f8e7d6c?r=use1");
  assert.equal(describeLink("https://forms.monday.com/forms/embed/9f8e7d6c?r=use1").embedUrl, "https://forms.monday.com/forms/embed/9f8e7d6c?r=use1");
  assert.equal(describeLink("https://view.monday.com/1234567890-abc?r=use1").embedUrl, "https://view.monday.com/embed/1234567890-abc?r=use1");
  assert.equal(describeLink("https://acme.monday.com/boards/1234567890/views/1").kind, "monday");
  assert.equal(describeLink("https://docs.google.com/x").kind, "web");
});

test("QR codes scan back to the hub address", () => {
  for (const url of ["https://hub.up.railway.app/", "https://employee-hub-production-1234.up.railway.app/?lang=es"]) {
    const m = encodeQr(url);
    const scale = 4, margin = 4;
    const size = (m.length + margin * 2) * scale;
    const data = new Uint8ClampedArray(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const mx = Math.floor(x / scale) - margin, my = Math.floor(y / scale) - margin;
        const dark = mx >= 0 && my >= 0 && mx < m.length && my < m.length && m[my][mx];
        const v = dark ? 0 : 255, i = (y * size + x) * 4;
        data[i] = data[i + 1] = data[i + 2] = v; data[i + 3] = 255;
      }
    }
    const res = jsQR(data, size, size);
    assert.ok(res, "jsQR should decode the code");
    assert.equal(res.data, url);
  }
  assert.match(toSvg(encodeQr("https://x.example/"), { title: "a <b>" }), /aria-label="a &lt;b&gt;"/);
  assert.throws(() => encodeQr("x".repeat(400)), /too long/);
});

test("tiles validate and normalise", () => {
  const t = validateTile({ title: "PTO", url: "forms.monday.com/forms/abc", icon: "", open: "embed" });
  assert.equal(t.url, "https://forms.monday.com/forms/abc");
  assert.equal(t.icon, "link");
  assert.deepEqual(t.title, { en: "PTO", es: "" });
  assert.equal(validateTile({ title: { en: "x" } }).url, "");
  assert.throws(() => validateTile({ title: "" }), ValidationError);
  assert.throws(() => validateTile({ title: "x", url: "ftp://nope" }), /http/);
  assert.throws(() => validateTile({ title: "x", open: "popup" }), /Open mode/);
});

test("settings validate languages and idle time", () => {
  const base = validateSettings({}, { hubName: { en: "Hub", es: "" }, languages: ["en", "es"], defaultLang: "es" });
  const s = validateSettings({ languages: ["es"], idleReturnSeconds: "0", publicUrl: "hub.example.com" }, base);
  assert.deepEqual(s.languages, ["en", "es"]);
  assert.equal(s.idleReturnSeconds, 0);
  assert.equal(s.publicUrl, "https://hub.example.com/");
  assert.equal(validateSettings({ languages: ["en"] }, s).defaultLang, "en");
  assert.throws(() => validateSettings({ idleReturnSeconds: 5000 }, base), /Return to home/);
  assert.throws(() => validateSettings({ hubName: "" }, base), /Hub name/);
});

test("the kiosk note validates", () => {
  const n = validateNote({ active: true, style: "important", title: "Safety meeting", body: { en: "Friday 2pm", es: "Viernes 2pm" }, until: "2026-12-31" });
  assert.equal(n.active, true);
  assert.equal(n.style, "important");
  assert.equal(n.body.es, "Viernes 2pm");
  assert.equal(n.until, "2026-12-31");
  assert.deepEqual(validateNote(null), { active: false, style: "info", title: { en: "", es: "" }, body: { en: "", es: "" }, until: "" });
  assert.throws(() => validateNote({ style: "loud" }), /Note style/);
  assert.throws(() => validateNote({ until: "31/12/2026" }), /date/);
  assert.throws(() => validateNote({ body: "x".repeat(601) }), /600/);
});

test("appearance validates colours and options", () => {
  const a = validateAppearance({ theme: "dark", accentStyle: "solid", accent: "#FF8800", background: "", cardStyle: "outline", radius: "square", font: "serif", tileSize: "compact", tileColumns: 4, showCodes: false }, DEFAULT_APPEARANCE);
  assert.equal(a.theme, "dark");
  assert.equal(a.accent, "#ff8800");
  assert.equal(a.background, "");
  assert.equal(a.tileColumns, "4");
  assert.equal(a.showCodes, false);
  assert.equal(a.showDate, true);
  assert.equal(validateAppearance({ background: "#123456" }, a).background, "#123456");
  assert.throws(() => validateAppearance({ accent: "red" }, a), /colour/);
  assert.throws(() => validateAppearance({ tileColumns: "9" }, a), /Tiles per row/);
  assert.throws(() => validateAppearance({ theme: "sepia" }, a), /Theme/);
});
