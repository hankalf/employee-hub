"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const jsQR = require("jsqr");
const { normalizeUrl, describeLink, extractFromEmbedCode } = require("../lib/links");
const { encodeQr, toSvg } = require("../lib/qr");
const { createChecker, framingAllowed, sourceMatches } = require("../lib/formcheck");
const { fakeWeb } = require("./fake-web");
const { validateTile, validateSettings, validateNote, validateAppearance, validateSchedule, verifyTilePin, normalizeContent, ValidationError, DEFAULT_APPEARANCE } = require("../lib/store");

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

test("notes validate text and dates", () => {
  const n = validateNote({ active: true, style: "important", title: "Safety meeting", body: { en: "Friday 2pm", es: "Viernes 2pm" }, from: "2026-12-01", until: "2026-12-31" });
  assert.equal(n.active, true);
  assert.equal(n.style, "important");
  assert.equal(n.body.es, "Viernes 2pm");
  assert.equal(n.from, "2026-12-01");
  assert.match(n.id, /^[\w-]+$/);
  assert.equal(validateNote({ body: "x" }, { id: "keep" }).id, "keep");
  assert.throws(() => validateNote({}), /title or some text/);
  assert.throws(() => validateNote({ title: "x", style: "loud" }), /Note style/);
  assert.throws(() => validateNote({ title: "x", until: "31/12/2026" }), /date/);
  assert.throws(() => validateNote({ title: "x", from: "2026-12-10", until: "2026-12-01" }), /on or after/);
  assert.throws(() => validateNote({ body: "x".repeat(601) }), /600/);
});

test("tile schedules validate days and times", () => {
  assert.equal(validateSchedule(null), null);
  assert.equal(validateSchedule({ enabled: false, days: [1] }), null);
  assert.deepEqual(validateSchedule({ days: [5, 1, "3", 1], start: "05:00", end: "08:30" }), { days: [1, 3, 5], start: "05:00", end: "08:30" });
  assert.deepEqual(validateSchedule({ days: [0, 6], start: "22:00", end: "06:00" }).days, [0, 6]);
  assert.throws(() => validateSchedule({ days: [], start: "05:00", end: "08:00" }), /at least one day/);
  assert.throws(() => validateSchedule({ days: [1], start: "5am", end: "08:00" }), /time like/);
  assert.throws(() => validateSchedule({ days: [1], start: "08:00", end: "08:00" }), /different/);
});

test("tile PINs are hashed, checked, kept and cleared", () => {
  const t = validateTile({ title: "Gear settings", pin: "4321" });
  assert.ok(t.pinHash && t.pinSalt);
  assert.ok(!JSON.stringify(t).includes("4321"));
  assert.equal(verifyTilePin(t, "4321"), true);
  assert.equal(verifyTilePin(t, "1234"), false);
  assert.equal(verifyTilePin(t, "abc"), false);
  const kept = validateTile({ ...t, title: "Renamed" }, t);
  assert.equal(kept.pinHash, t.pinHash);
  assert.equal(validateTile({ ...t, clearPin: true }, t).pinHash, "");
  assert.equal(verifyTilePin(validateTile({ title: "Open" }), ""), true);
  assert.throws(() => validateTile({ title: "x", pin: "12" }), /4 to 8 digits/);
  assert.throws(() => validateTile({ title: "x", groupId: "nope" }, {}, []), /group/);
  assert.equal(validateTile({ title: "x", groupId: "g1" }, {}, [{ id: "g1" }]).groupId, "g1");
});

test("content from older versions is upgraded", () => {
  const c = normalizeContent({
    tiles: [{ id: "a", title: { en: "A" } }], panels: [1], links: [1], optionLabels: {},
    note: { active: true, style: "important", title: { en: "Old note" }, body: { en: "" }, until: "2027-01-01" },
    settings: { timeZone: "UTC", refreshSeconds: 60 },
  });
  assert.equal(c.notes.length, 1);
  assert.equal(c.notes[0].title.en, "Old note");
  assert.equal(c.notes[0].until, "2027-01-01");
  assert.equal(c.note, undefined);
  assert.deepEqual(c.groups, []);
  assert.equal(c.tiles[0].groupId, "");
  assert.equal(c.tiles[0].schedule, null);
  assert.equal(c.settings.screensaverSeconds, 180);
  for (const gone of ["panels", "links", "optionLabels"]) assert.equal(c[gone], undefined);
  assert.equal(c.settings.timeZone, undefined);
  assert.deepEqual(normalizeContent({ tiles: [], note: { active: false, title: { en: "" }, body: { en: "" } } }).notes, []);
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

test("short monday links are recognised", () => {
  assert.equal(describeLink("https://wkf.ms/3AbC9xY").kind, "form-short");
});

test("framing headers are read like a browser would", () => {
  const origin = "https://hub.up.railway.app";
  const H = (o) => new Headers(o);
  assert.equal(framingAllowed(H({}), origin).allowed, true);
  assert.equal(framingAllowed(H({ "x-frame-options": "DENY" }), origin).allowed, false);
  assert.equal(framingAllowed(H({ "x-frame-options": "SAMEORIGIN" }), origin).allowed, false);
  assert.equal(framingAllowed(H({ "x-frame-options": "SAMEORIGIN", "content-security-policy": "frame-ancestors *" }), origin).allowed, true, "CSP wins over X-Frame-Options");
  assert.equal(framingAllowed(H({ "content-security-policy": "default-src 'self'; frame-ancestors 'self' https://*.monday.com" }), origin).allowed, false);
  assert.equal(framingAllowed(H({ "content-security-policy": "frame-ancestors https:" }), origin).allowed, true);
  assert.equal(framingAllowed(H({ "content-security-policy": "frame-ancestors 'none'" }), origin).allowed, false);
  assert.ok(sourceMatches("*.up.railway.app", origin));
  assert.ok(sourceMatches("https://hub.up.railway.app", origin));
  assert.ok(!sourceMatches("http://hub.up.railway.app", origin));
  assert.ok(!sourceMatches("other.example", origin));
});

test("the checker follows short links, caches, and copes with failures", async () => {
  const web = fakeWeb();
  const checker = createChecker({ fetchImpl: web.fetchImpl });
  const a = await checker.check("https://wkf.ms/abc", { origin: "https://hub.example" });
  assert.equal(a.status, "ok");
  assert.equal(a.resolvedUrl, "https://forms.monday.com/forms/abc123?r=use1");
  assert.equal(a.embedUrl, "https://forms.monday.com/forms/embed/abc123?r=use1");
  const n = web.calls.length;
  await checker.check("https://wkf.ms/abc", { origin: "https://hub.example" });
  assert.equal(web.calls.length, n, "results are cached");
  await checker.check("https://wkf.ms/abc", { origin: "https://hub.example", fresh: true });
  assert.ok(web.calls.length > n);
  assert.equal((await checker.check("https://wkf.ms/old")).status, "notfound");
  assert.equal((await checker.check("https://forms.monday.com/forms/login1?r=use1")).status, "login");
  const down = await checker.check("https://unreachable.invalid/x");
  assert.equal(down.status, "unknown");
  assert.match(down.detail, /couldn't be reached/);
});

test("monday embed code is accepted and the form address taken out of it", () => {
  const code = '<iframe src="https://forms.monday.com/forms/embed/9f8e7d6c?r=use1" width="650" height="500" style="border: 0; box-shadow: 5px 5px 56px 0px rgba(0,0,0,0.25);"></iframe>';
  assert.equal(normalizeUrl(code), "https://forms.monday.com/forms/embed/9f8e7d6c?r=use1");
  assert.equal(describeLink(normalizeUrl(code)).kind, "form");
  assert.equal(normalizeUrl("<iframe width='650'\n  src='https://forms.monday.com/forms/embed/abc?r=use1&amp;lang=es'></iframe>"), "https://forms.monday.com/forms/embed/abc?r=use1&lang=es");
  assert.equal(normalizeUrl('<iframe src="//forms.monday.com/forms/embed/abc?r=use1"></iframe>'), "https://forms.monday.com/forms/embed/abc?r=use1");
  assert.equal(extractFromEmbedCode("https://wkf.ms/abc"), "https://wkf.ms/abc");
  assert.throws(() => normalizeUrl("<div>no form here</div>"), /embed code/);
  assert.throws(() => normalizeUrl('<iframe src="javascript:alert(1)"></iframe>'), /http/);
});

test("layout and clock settings validate, and the old intro switch is upgraded", () => {
  const a = validateAppearance({ hubNamePosition: "headline", greetingStyle: "before", introPosition: "bottom", headerAlign: "center", clock: "24h", clockAmPm: true }, DEFAULT_APPEARANCE);
  assert.equal(a.hubNamePosition, "headline");
  assert.equal(a.greetingStyle, "before");
  assert.equal(a.introPosition, "bottom");
  assert.equal(a.headerAlign, "center");
  assert.equal(a.clock, "24h");
  assert.equal(a.clockAmPm, true);
  assert.equal(DEFAULT_APPEARANCE.clock, "12h");
  assert.equal(DEFAULT_APPEARANCE.hubNamePosition, "topbar");
  assert.throws(() => validateAppearance({ hubNamePosition: "footer" }, a), /Hub name position/);
  assert.throws(() => validateAppearance({ greetingStyle: "loud" }, a), /Greeting/);
  assert.throws(() => validateAppearance({ introPosition: "sideways" }, a), /Intro line/);
  assert.throws(() => validateAppearance({ headerAlign: "right" }, a), /alignment/);
  assert.throws(() => validateAppearance({ clock: "analog" }, a), /Clock/);
  // An older admin page sending showIntro: false still hides the intro line
  assert.equal(validateAppearance({ showIntro: false }, DEFAULT_APPEARANCE).introPosition, "hidden");
  assert.equal(validateAppearance({ showIntro: false }, DEFAULT_APPEARANCE).showIntro, undefined);
  // Saved content from before: showIntro false becomes introPosition hidden; true keeps the default
  assert.equal(normalizeContent({ tiles: [], appearance: { showIntro: false } }).appearance.introPosition, "hidden");
  const upgraded = normalizeContent({ tiles: [], appearance: { showIntro: true, theme: "dark" } }).appearance;
  assert.equal(upgraded.introPosition, "below");
  assert.equal(upgraded.theme, "dark");
  assert.equal(upgraded.clock, "12h");
  assert.equal(upgraded.showIntro, undefined);
});
