"use strict";

// End-to-end tests against a real server on a random port with a throwaway data folder.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const AdmZip = require("adm-zip");
const { createApp } = require("../lib/app");
const { fakeWeb } = require("./fake-web");

const ADMIN_PASSWORD = "hub-test-pass";
let server, base, dataDir, ctx;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-test-"));
  const origLog = console.log;
  console.log = () => {};
  const created = await createApp({ dataDir, adminPassword: ADMIN_PASSWORD, sessionSecret: "", publicUrl: "", fetchImpl: fakeWeb().fetchImpl, backgroundChecks: false });
  ctx = created.ctx;
  const app = created.app;
  console.log = origLog;
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** A tiny browser: keeps the admin cookie and sends the CSRF header on API writes. */
function client() {
  let cookie = "";
  async function request(method, url, { json, form, body, headers = {} } = {}) {
    const h = { ...headers };
    if (cookie) h.Cookie = cookie;
    if (url.startsWith("/api/") && method !== "GET" && !("X-Requested-With" in h)) h["X-Requested-With"] = "hub";
    let payload = body;
    if (json !== undefined) { h["Content-Type"] = "application/json"; payload = JSON.stringify(json); }
    if (form) { h["Content-Type"] = "application/x-www-form-urlencoded"; payload = new URLSearchParams(form).toString(); }
    const res = await fetch(base + url, { method, headers: h, body: payload, redirect: "manual" });
    for (const set of res.headers.getSetCookie()) {
      const m = /^hub_admin=([^;]*)/.exec(set);
      if (m) cookie = m[1] ? "hub_admin=" + m[1] : "";
    }
    return res;
  }
  return { request, get: (u, o) => request("GET", u, o), post: (u, o) => request("POST", u, o), put: (u, o) => request("PUT", u, o), del: (u, o) => request("DELETE", u, o) };
}

async function signIn() {
  const c = client();
  const res = await c.post("/admin/login", { form: { password: ADMIN_PASSWORD } });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/admin?signedin=1");
  return c;
}

test("health check and kiosk pages are public", async () => {
  assert.equal((await fetch(base + "/healthz")).status, 200);
  const root = await fetch(base + "/", { redirect: "manual" });
  assert.equal(root.status, 302);
  assert.equal(root.headers.get("location"), "/kiosk");
  for (const p of ["/kiosk", "/qr", "/open/t/abc"]) {
    const r = await fetch(base + p);
    assert.equal(r.status, 200, p);
    assert.match(r.headers.get("content-type"), /text\/html/);
    assert.match(r.headers.get("content-security-policy"), /frame-src 'self' https:/);
    assert.match(r.headers.get("content-security-policy"), /frame-ancestors 'self' https:\/\/monday\.com https:\/\/\*\.monday\.com https:\/\/\*\.monday\.app(;|$)/);
    assert.equal(r.headers.get("x-frame-options"), null, "X-Frame-Options would stop monday.com from framing the hub");
  }
  const svg = await fetch(base + "/qr.svg");
  assert.equal(svg.status, 200);
  assert.match(svg.headers.get("content-type"), /image\/svg\+xml/);
  assert.equal((await fetch(base + "/logo")).status, 404);
  assert.equal((await fetch(base + "/nope")).status, 404);
  assert.equal((await fetch(base + "/api/nope")).status, 404);
});

test("the public hub view has the seeded tiles, notes and appearance", async () => {
  const hub = await (await fetch(base + "/api/hub")).json();
  assert.equal(hub.tiles.length, 4);
  assert.equal(hub.tiles[0].id, "checklist");
  assert.equal(hub.tiles[0].kind, "none");
  assert.equal(hub.tiles[0].locked, false);
  assert.deepEqual(hub.notes, []); // the seeded note is switched off
  assert.deepEqual(hub.groups, []);
  assert.equal(hub.appearance.theme, "auto");
  assert.equal(hub.logo, "");
  assert.match(hub.publicUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.deepEqual(hub.settings.languages, ["en", "es"]);
});

test("admin area needs the password; writes need the CSRF header", async () => {
  const c = client();
  assert.equal((await c.get("/admin")).status, 302);
  assert.equal((await c.get("/api/admin/content")).status, 401);
  const bad = await c.post("/admin/login", { form: { password: "nope" } });
  assert.equal(bad.headers.get("location"), "/admin/login?error=wrong");
  assert.equal((await c.get("/api/admin/content")).status, 401);
  const ok = await signIn();
  assert.equal((await ok.get("/admin")).status, 200);
  const content = await (await ok.get("/api/admin/content")).json();
  assert.equal(content.tiles.length, 4);
  assert.equal(content.adminEnabled, true);
  const noHeader = await ok.post("/api/admin/tiles", { json: { title: "x" }, headers: { "X-Requested-With": "" } });
  assert.equal(noHeader.status, 403);
  const out = await ok.post("/admin/logout");
  assert.equal(out.status, 302);
  assert.equal((await ok.get("/api/admin/content")).status, 401);
});

test("tiles: add, edit, reorder, delete, with validation", async () => {
  const c = await signIn();
  let r = await c.post("/api/admin/tiles", { json: { title: { en: "Visitor sign-in", es: "Registro de visitantes" }, url: "forms.monday.com/forms/abc123?r=use1", icon: "📝", open: "embed" } });
  assert.equal(r.status, 201);
  const tile = await r.json();
  assert.equal(tile.url, "https://forms.monday.com/forms/abc123?r=use1");
  r = await c.post("/api/admin/tiles", { json: { title: "", url: "x" } });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /Title/);
  r = await c.put(`/api/admin/tiles/${tile.id}`, { json: { url: "javascript:alert(1)" } });
  assert.equal(r.status, 400);
  r = await c.put(`/api/admin/tiles/${tile.id}`, { json: { active: false } });
  assert.equal((await r.json()).active, false);

  let hub = await (await fetch(base + "/api/hub")).json();
  assert.ok(!hub.tiles.some((t) => t.id === tile.id), "inactive tiles are hidden from the kiosk");
  await c.put(`/api/admin/tiles/${tile.id}`, { json: { active: true } });
  hub = await (await fetch(base + "/api/hub")).json();
  const shown = hub.tiles.find((t) => t.id === tile.id);
  assert.equal(shown.kind, "form");
  assert.equal(shown.embedUrl, "https://forms.monday.com/forms/embed/abc123?r=use1");

  r = await c.put("/api/admin/tiles/order", { json: { ids: [tile.id, "pto"] } });
  assert.equal(r.status, 200);
  hub = await (await fetch(base + "/api/hub")).json();
  assert.deepEqual(hub.tiles.slice(0, 2).map((t) => t.id), [tile.id, "pto"]);

  assert.equal((await c.del(`/api/admin/tiles/${tile.id}`)).status, 200);
  assert.equal((await c.del(`/api/admin/tiles/${tile.id}`)).status, 404);
  const info = await (await c.get("/api/admin/link-info?url=" + encodeURIComponent("https://forms.monday.com/forms/zzz?r=use1"))).json();
  assert.equal(info.kind, "form");
});

test("notes: add, schedule, reorder, delete", async () => {
  const c = await signIn();
  let r = await c.post("/api/admin/notes", { json: { style: "important", title: { en: "Safety meeting" }, body: { en: "Friday 2pm in the break room", es: "Viernes 2pm" }, until: "2099-01-01" } });
  assert.equal(r.status, 201);
  const a = await r.json();
  r = await c.post("/api/admin/notes", { json: { title: "Next week", from: "2099-01-01" } });
  const b = await r.json();
  assert.equal((await c.post("/api/admin/notes", { json: { style: "loud", title: "x" } })).status, 400);
  assert.equal((await c.post("/api/admin/notes", { json: {} })).status, 400);
  let hub = await (await fetch(base + "/api/hub")).json();
  assert.deepEqual(hub.notes.map((n) => n.id), [a.id, b.id]); // dates are applied on the kiosk's own clock
  await c.put("/api/admin/notes/order", { json: { ids: [b.id, a.id] } });
  await c.put(`/api/admin/notes/${b.id}`, { json: { active: false } });
  hub = await (await fetch(base + "/api/hub")).json();
  assert.deepEqual(hub.notes.map((n) => n.id), [a.id]);
  assert.equal((await c.del(`/api/admin/notes/${b.id}`)).status, 200);
  assert.equal((await c.put(`/api/admin/notes/${b.id}`, { json: { title: "x" } })).status, 404);
  await c.del(`/api/admin/notes/${a.id}`);
});

test("appearance is saved and shown to the kiosk", async () => {
  const c = await signIn();
  let r = await c.put("/api/admin/appearance", { json: { theme: "dark", accent: "#ff8800", tileColumns: "3", showCodes: false } });
  assert.equal(r.status, 200);
  r = await c.put("/api/admin/appearance", { json: { accent: "orange" } });
  assert.equal(r.status, 400);
  const hub = await (await fetch(base + "/api/hub")).json();
  assert.equal(hub.appearance.theme, "dark");
  assert.equal(hub.appearance.accent, "#ff8800");
  assert.equal(hub.appearance.tileColumns, "3");
  assert.equal(hub.appearance.showCodes, false);
  assert.equal(hub.appearance.cardStyle, "frosted"); // untouched fields keep their defaults
  assert.equal(hub.appearance.clock, "12h");
  r = await c.put("/api/admin/appearance", { json: { hubNamePosition: "headline", greetingStyle: "hidden", introPosition: "bottom", headerAlign: "center", clock: "24h" } });
  assert.equal(r.status, 200);
  const hub2 = await (await fetch(base + "/api/hub")).json();
  assert.equal(hub2.appearance.hubNamePosition, "headline");
  assert.equal(hub2.appearance.clock, "24h");
  assert.equal((await c.put("/api/admin/appearance", { json: { introPosition: "nowhere" } })).status, 400);
  await c.put("/api/admin/appearance", { json: { hubNamePosition: "topbar", greetingStyle: "after", introPosition: "below", headerAlign: "left", clock: "12h" } });
});

test("groups: tiles can be grouped, groups reordered and deleted", async () => {
  const c = await signIn();
  const safety = await (await c.post("/api/admin/groups", { json: { title: { en: "Safety", es: "Seguridad" } } })).json();
  const hr = await (await c.post("/api/admin/groups", { json: { title: "Time off" } })).json();
  assert.equal((await c.post("/api/admin/groups", { json: { title: "" } })).status, 400);
  let r = await c.put("/api/admin/tiles/checklist", { json: { groupId: safety.id } });
  assert.equal((await r.json()).groupId, safety.id);
  assert.equal((await c.put("/api/admin/tiles/pto", { json: { groupId: "missing" } })).status, 400);
  await c.put("/api/admin/groups/order", { json: { ids: [hr.id, safety.id] } });
  let hub = await (await fetch(base + "/api/hub")).json();
  assert.deepEqual(hub.groups.map((g) => g.id), [hr.id, safety.id]);
  assert.equal(hub.tiles.find((t) => t.id === "checklist").groupId, safety.id);
  assert.equal((await c.del(`/api/admin/groups/${safety.id}`)).status, 200);
  hub = await (await fetch(base + "/api/hub")).json();
  assert.equal(hub.tiles.find((t) => t.id === "checklist").groupId, "", "tiles of a deleted group move to no group");
  await c.del(`/api/admin/groups/${hr.id}`);
});

test("schedules are passed to the kiosk", async () => {
  const c = await signIn();
  let r = await c.put("/api/admin/tiles/checklist", { json: { schedule: { days: [1, 2, 3, 4, 5], start: "05:00", end: "08:00" } } });
  assert.deepEqual((await r.json()).schedule, { days: [1, 2, 3, 4, 5], start: "05:00", end: "08:00" });
  assert.equal((await c.put("/api/admin/tiles/checklist", { json: { schedule: { days: [], start: "05:00", end: "08:00" } } })).status, 400);
  const hub = await (await fetch(base + "/api/hub")).json();
  assert.deepEqual(hub.tiles.find((t) => t.id === "checklist").schedule.days, [1, 2, 3, 4, 5]);
  r = await c.put("/api/admin/tiles/checklist", { json: { schedule: null } });
  assert.equal((await r.json()).schedule, null);
});

test("lead-only tiles hide their link until the right PIN is entered", async () => {
  const c = await signIn();
  let r = await c.put("/api/admin/tiles/gear", { json: { url: "https://forms.monday.com/forms/secret123?r=use1", pin: "2468" } });
  const saved = await r.json();
  assert.equal(saved.hasPin, true);
  assert.equal(saved.pinHash, undefined, "the admin API never returns the PIN hash");
  const content = await (await c.get("/api/admin/content")).json();
  assert.equal(content.tiles.find((t) => t.id === "gear").hasPin, true);
  assert.ok(!JSON.stringify(content).includes("pinHash"));

  const hub = await (await fetch(base + "/api/hub")).json();
  const pub = hub.tiles.find((t) => t.id === "gear");
  assert.equal(pub.locked, true);
  assert.equal(pub.hasLink, true);
  assert.equal(pub.url, "");
  assert.ok(!JSON.stringify(hub).includes("secret123"), "the kiosk never sees a locked tile's link");

  assert.equal((await fetch(base + "/api/tiles/gear/link")).status, 403);
  const unlock = (pin) => fetch(base + "/api/tiles/gear/unlock", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin }) });
  r = await unlock("1111");
  assert.equal(r.status, 403);
  assert.equal((await r.json()).code, "wrong");
  r = await unlock("2468");
  assert.equal(r.status, 200);
  const { token } = await r.json();
  r = await fetch(base + "/api/tiles/gear/link?k=" + encodeURIComponent(token));
  assert.equal(r.status, 200);
  const link = await r.json();
  assert.equal(link.embedUrl, "https://forms.monday.com/forms/embed/secret123?r=use1");
  assert.equal((await fetch(base + "/api/tiles/pto/link?k=" + encodeURIComponent(token))).status, 200, "unlocked tiles don't need a token");
  assert.equal((await fetch(base + "/api/tiles/gear/link?k=" + encodeURIComponent(token.replace(/.$/, "x")))).status, 403);

  // Changing other fields keeps the PIN; clearing it unlocks the tile.
  await c.put("/api/admin/tiles/gear", { json: { description: { en: "Leads only" } } });
  assert.equal((await unlock("2468")).status, 200);
  r = await c.put("/api/admin/tiles/gear", { json: { clearPin: true } });
  assert.equal((await r.json()).hasPin, false);
  assert.equal((await (await fetch(base + "/api/hub")).json()).tiles.find((t) => t.id === "gear").locked, false);
  await c.put("/api/admin/tiles/gear", { json: { url: "" } });
});

test("taps are counted and kiosks report in", async () => {
  const c = await signIn();
  for (let i = 0; i < 3; i++) assert.equal((await fetch(base + "/api/tap/pto", { method: "POST" })).status, 204);
  await fetch(base + "/api/tap/does-not-exist", { method: "POST" });
  const beat = (body) => fetch(base + "/api/heartbeat", { method: "POST", headers: { "Content-Type": "text/plain", "User-Agent": "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)" }, body: JSON.stringify(body) });
  assert.equal((await beat({ deviceId: "0123456789abcdef0123", screen: "1180x820", path: "/kiosk" })).status, 204);
  await beat({ deviceId: "not-valid", screen: "1x1" });
  let s = await (await c.get("/api/admin/stats")).json();
  assert.equal(s.usage.pto.last30, 3);
  assert.equal(s.usage.pto.last7, 3);
  assert.equal(s.usage.pto.total, 3);
  assert.equal(s.usage["does-not-exist"], undefined);
  assert.equal(s.devices.length, 1);
  assert.equal(s.devices[0].screen, "1180x820");
  assert.match(s.devices[0].ua, /iPad/);
  assert.equal((await c.put("/api/admin/devices/0123456789abcdef0123", { json: { name: "Break room iPad" } })).status, 200);
  assert.equal((await c.put("/api/admin/devices/nope", { json: { name: "x" } })).status, 404);
  s = await (await c.get("/api/admin/stats")).json();
  assert.equal(s.devices[0].name, "Break room iPad");
  await ctx.stats.flush();
  await ctx.devices.flush();
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, "stats.json"), "utf8")).taps.pto.total, 3);
  assert.equal((await fetch(base + "/api/admin/stats")).status, 401);
});

test("backup and restore round-trip everything", async () => {
  const c = await signIn();
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  const fd = new FormData();
  fd.append("logo", new Blob([png], { type: "image/png" }), "logo.png");
  await c.post("/api/admin/logo", { body: fd });
  await c.post("/api/admin/notes", { json: { title: "In the backup" } });
  const r = await c.get("/api/admin/backup");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-disposition"), /employee-hub-backup-\d{4}-\d{2}-\d{2}\.zip/);
  const zipBuf = Buffer.from(await r.arrayBuffer());
  const names = new AdmZip(zipBuf).getEntries().map((e) => e.entryName).sort();
  assert.ok(names.includes("content.json") && names.includes("stats.json") && names.includes("devices.json"));
  assert.ok(names.some((n) => /^uploads\/logo-\d+\.png$/.test(n)));

  // Change things, then restore
  const hubBefore = await (await fetch(base + "/api/hub")).json();
  await c.del("/api/admin/tiles/pto");
  await c.del("/api/admin/logo");
  const restore = (buf, name) => { const f = new FormData(); f.append("backup", new Blob([buf], { type: "application/zip" }), name); return c.post("/api/admin/restore", { body: f }); };
  assert.equal((await restore(zipBuf, "backup.zip")).status, 200);
  const hubAfter = await (await fetch(base + "/api/hub")).json();
  assert.deepEqual(hubAfter.tiles.map((t) => t.id), hubBefore.tiles.map((t) => t.id));
  assert.ok(hubAfter.notes.some((n) => n.title.en === "In the backup"));
  assert.equal((await fetch(base + "/logo")).status, 200);
  assert.equal((await (await c.get("/api/admin/stats")).json()).usage.pto.total, 3);
  assert.ok(fs.readdirSync(dataDir).some((f) => f.startsWith("before-restore-")));

  // Bad uploads are refused and change nothing
  assert.equal((await restore(Buffer.from("not a zip"), "x.zip")).status, 400);
  const bad = new AdmZip();
  bad.addFile("readme.txt", Buffer.from("hi"));
  const res = await restore(bad.toBuffer(), "x.zip");
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /content\.json/);
  const evil = new AdmZip();
  evil.addFile("content.json", Buffer.from(JSON.stringify({ tiles: [] })));
  evil.addFile("uploads/../../escape.png", png);
  evil.addFile("uploads/script.html", Buffer.from("<script>"));
  assert.equal((await restore(evil.toBuffer(), "x.zip")).status, 200);
  assert.ok(!fs.existsSync(path.join(dataDir, "..", "escape.png")));
  assert.deepEqual(fs.readdirSync(path.join(dataDir, "uploads")), [], "only the referenced logo is ever extracted");
  assert.equal((await (await fetch(base + "/api/hub")).json()).logo, "");
  // Put the good backup back for the remaining tests
  assert.equal((await restore(zipBuf, "backup.zip")).status, 200);
  await c.del("/api/admin/logo");
});

test("form links are checked: short links resolve, blocked forms open full screen", async () => {
  const c = await signIn();
  const add = async (title, url, open = "embed") => (await c.post("/api/admin/tiles", { json: { title, url, open } })).json();

  const short = await add("Short", "https://wkf.ms/abc");
  assert.equal(short.resolvedUrl, "https://forms.monday.com/forms/abc123?r=use1");
  assert.equal(short.embedCheck.status, "ok");
  const blocked = await add("Blocked", "https://wkf.ms/blk");
  assert.equal(blocked.embedCheck.status, "blocked");
  assert.match(blocked.embedCheck.detail, /X-Frame-Options: SAMEORIGIN/);
  const login = await add("Login", "https://forms.monday.com/forms/login1?r=use1");
  assert.equal(login.embedCheck.status, "login");
  const gone = await add("Gone", "https://forms.monday.com/forms/gone1?r=use1");
  assert.equal(gone.embedCheck.status, "notfound");
  const slow = await add("Slow", "https://forms.monday.com/forms/slow1?r=use1");
  assert.equal(slow.embedCheck.status, "unknown");
  const board = await add("Board", "https://acme.monday.com/boards/123/views/4");
  assert.equal(board.embedCheck.status, "login");
  const site = await add("Site", "https://example.com/page");
  assert.equal(site.embedCheck.status, "blocked");
  const ok = await add("OK site", "https://docs.example.org/form");
  assert.equal(ok.embedCheck.status, "ok");

  const hub = await (await fetch(base + "/api/hub")).json();
  const pub = (id) => hub.tiles.find((t) => t.id === id);
  assert.equal(pub(short.id).embedUrl, "https://forms.monday.com/forms/embed/abc123?r=use1", "short links embed the real form");
  assert.equal(pub(short.id).fullPage, false);
  assert.equal(pub(blocked.id).fullPage, true);
  assert.equal(pub(blocked.id).url, "https://forms.monday.com/forms/blocked1?r=use1");
  assert.equal(pub(login.id).fullPage, true);
  assert.equal(pub(board.id).fullPage, true);
  assert.equal(pub(site.id).fullPage, true);
  assert.equal(pub(slow.id).fullPage, false, "unknown results still try the iframe");
  assert.equal(pub(gone.id).fullPage, false);

  // Changing the link clears the old check and checks the new one
  let r = await c.put(`/api/admin/tiles/${blocked.id}`, { json: { url: "https://wkf.ms/abc" } });
  const fixed = await r.json();
  assert.equal(fixed.embedCheck.status, "ok");
  // Editing something else keeps the result without asking monday again
  r = await c.put(`/api/admin/tiles/${fixed.id}`, { json: { description: { en: "x" } } });
  assert.equal((await r.json()).embedCheck.checkedAt, fixed.embedCheck.checkedAt);

  // Check all, and the link-info endpoint used while typing
  r = await c.post("/api/admin/tiles/check", { json: {} });
  const all = await r.json();
  assert.equal(all.find((t) => t.id === gone.id).embedCheck.status, "notfound");
  assert.ok(!JSON.stringify(all).includes("pinHash"));
  const info = await (await c.get("/api/admin/link-info?check=1&url=" + encodeURIComponent("wkf.ms/abc"))).json();
  assert.equal(info.kind, "form-short");
  assert.equal(info.check.status, "ok");
  assert.equal(info.check.resolvedUrl, "https://forms.monday.com/forms/abc123?r=use1");

  // A locked tile reports fullPage through the PIN-protected link endpoint, never through /api/hub
  await c.put(`/api/admin/tiles/${login.id}`, { json: { pin: "1357" } });
  const unlocked = await (await fetch(base + `/api/tiles/${login.id}/unlock`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin: "1357" }) })).json();
  const link = await (await fetch(base + `/api/tiles/${login.id}/link?k=` + encodeURIComponent(unlocked.token))).json();
  assert.equal(link.fullPage, true);

  // Pasting monday's embed code saves the form address inside it
  const embedded = await add("Embedded", '<iframe src="https://forms.monday.com/forms/embed/abc123?r=use1" width="650" height="500" style="border: 0;"></iframe>');
  assert.equal(embedded.url, "https://forms.monday.com/forms/embed/abc123?r=use1");
  assert.equal(embedded.embedCheck.status, "ok");
  const hub2 = await (await fetch(base + "/api/hub")).json();
  assert.equal(hub2.tiles.find((t) => t.id === embedded.id).embedUrl, "https://forms.monday.com/forms/embed/abc123?r=use1");
  const codeInfo = await (await c.get("/api/admin/link-info?check=1&url=" + encodeURIComponent('<iframe src="https://forms.monday.com/forms/embed/abc123?r=use1"></iframe>'))).json();
  assert.equal(codeInfo.url, "https://forms.monday.com/forms/embed/abc123?r=use1");
  const badCode = await c.post("/api/admin/tiles", { json: { title: "Bad", url: "<div>oops</div>" } });
  assert.equal(badCode.status, 400);
  assert.match((await badCode.json()).error, /embed code/);

  for (const t of [short, blocked, login, gone, slow, board, site, ok, embedded]) await c.del(`/api/admin/tiles/${t.id}`);
});

test("logo upload, serving and removal", async () => {
  const c = await signIn();
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  const upload = async (blob, name) => {
    const fd = new FormData();
    fd.append("logo", blob, name);
    return c.post("/api/admin/logo", { body: fd });
  };
  let r = await upload(new Blob([png], { type: "image/png" }), "logo.png");
  assert.equal(r.status, 200);
  const { logo } = await r.json();
  assert.match(logo, /^logo-\d+\.png$/);
  const served = await fetch(base + "/logo");
  assert.equal(served.status, 200);
  assert.match(served.headers.get("content-type"), /image\/png/);
  assert.equal(served.headers.get("content-security-policy"), "sandbox");
  assert.equal(Buffer.from(await served.arrayBuffer()).length, png.length);
  assert.equal((await (await fetch(base + "/api/hub")).json()).logo, logo);

  r = await upload(new Blob(["not an image"], { type: "text/plain" }), "x.txt");
  assert.equal(r.status, 400);
  r = await upload(new Blob([Buffer.alloc(3 * 1024 * 1024)], { type: "image/png" }), "big.png");
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /too big/);

  // Replacing the logo removes the old file
  await new Promise((resolve) => setTimeout(resolve, 2));
  r = await upload(new Blob([png], { type: "image/png" }), "logo2.png");
  const { logo: logo2 } = await r.json();
  assert.notEqual(logo2, logo);
  assert.deepEqual(fs.readdirSync(path.join(dataDir, "uploads")), [logo2]);

  assert.equal((await c.del("/api/admin/logo")).status, 200);
  assert.equal((await fetch(base + "/logo")).status, 404);
  assert.deepEqual(fs.readdirSync(path.join(dataDir, "uploads")), []);
});

test("settings save and drive the QR address", async () => {
  const c = await signIn();
  let r = await c.put("/api/admin/settings", { json: { hubName: { en: "NT Hub", es: "Portal NT" }, languages: ["en"], idleReturnSeconds: 120, publicUrl: "hub.example.com" } });
  assert.equal(r.status, 200);
  const s = await r.json();
  assert.deepEqual(s.languages, ["en"]);
  assert.equal(s.publicUrl, "https://hub.example.com/");
  assert.match(await (await fetch(base + "/qr.svg")).text(), /hub\.example\.com/);
  const hub = await (await fetch(base + "/api/hub")).json();
  assert.equal(hub.settings.hubName.en, "NT Hub");
  await c.put("/api/admin/settings", { json: { languages: ["en", "es"], publicUrl: "" } });
});

test("the admin cookie works inside a monday.com frame over HTTPS", async () => {
  const login = (proto) => fetch(base + "/admin/login", {
    method: "POST", redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Forwarded-Proto": proto },
    body: new URLSearchParams({ password: ADMIN_PASSWORD }).toString(),
  });
  const httpsRes = await login("https");
  const https = httpsRes.headers.getSetCookie().find((c) => /^hub_admin=[^;]+/.test(c));
  assert.match(https, /hub_admin=/);
  // Before the new cookie, any older unpartitioned copy is deleted so a stale one can't shadow it.
  assert.match(httpsRes.headers.getSetCookie()[0], /^hub_admin=;.*Expires=Thu, 01 Jan 1970/);
  assert.match(https, /SameSite=None/);
  assert.match(https, /Secure/);
  assert.match(https, /Partitioned/);
  assert.match(https, /HttpOnly/);
  const http = (await login("http")).headers.getSetCookie().find((c) => /^hub_admin=[^;]+/.test(c));
  assert.match(http, /SameSite=Lax/);
  assert.doesNotMatch(http, /Partitioned|Secure/);
  // Cross-site writes are still refused without the custom header, even with the cookie
  const cookie = /hub_admin=[^;]*/.exec(https)[0];
  const r = await fetch(base + "/api/admin/tiles", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: "{}" });
  assert.equal(r.status, 403);
});

test("signing in works with leftover cookies from the previous version", async () => {
  const crypto = require("crypto");
  const secret = fs.readFileSync(path.join(dataDir, "session.key"), "utf8").trim();
  const key = crypto.createHash("sha256").update("hub-session:" + secret).digest();
  const sign = (obj) => { const p = Buffer.from(JSON.stringify(obj)).toString("base64url"); return "hub_admin=" + p + "." + crypto.createHmac("sha256", key).update(p).digest("base64url"); };
  const fingerprint = crypto.createHmac("sha256", key).update("pw:" + ADMIN_PASSWORD).digest("base64url").slice(0, 16);
  const me = (cookie) => fetch(base + "/api/admin/me", { headers: { Cookie: cookie } }).then((r) => r.status);
  const oldOwner = sign({ f: fingerprint, e: Date.now() + 3600e3 });   // a session from before named admins
  const stale = sign({ f: "from-an-old-pass", e: Date.now() + 3600e3 }); // e.g. ADMIN_PASSWORD was changed since
  const expired = sign({ u: "owner", f: fingerprint, e: Date.now() - 1000 });
  const fresh = sign({ u: "owner", f: fingerprint, e: Date.now() + 3600e3 });
  assert.equal(await me(oldOwner), 200, "the previous version's owner session still works");
  assert.equal(await me(stale), 401);
  assert.equal(await me(`${stale}; ${fresh}`), 200, "a stale cookie sent first doesn't hide a good one");
  assert.equal(await me(`${expired}; ${stale}; ${fresh}`), 200);
  assert.equal(await me("hub_admin=%E0%A4%A; " + fresh), 200, "a garbled cookie is ignored");
  // When the browser didn't keep the sign-in, /admin says so instead of silently showing the login page again
  const r = await fetch(base + "/admin?signedin=1", { redirect: "manual", headers: { Cookie: stale } });
  assert.equal(r.headers.get("location"), "/admin/login?error=cookie");
  assert.equal((await fetch(base + "/admin", { redirect: "manual" })).headers.get("location"), "/admin/login");
});

test("FRAME_ANCESTORS can change or turn off framing", async () => {
  const start = async (frameAncestors) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-test-fa-"));
    const origWarn = console.warn; console.warn = () => {};
    const { app } = await createApp({ dataDir: dir, adminPassword: "x", sessionSecret: "", publicUrl: "", frameAncestors, fetchImpl: fakeWeb().fetchImpl, backgroundChecks: false });
    console.warn = origWarn;
    const srv = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/kiosk`);
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
    return r.headers;
  };
  let h = await start("https://intranet.example.org, https://*.monday.com http://insecure.example");
  assert.match(h.get("content-security-policy"), /frame-ancestors 'self' https:\/\/intranet\.example\.org https:\/\/\*\.monday\.com;/);
  assert.equal(h.get("x-frame-options"), null);
  h = await start("none");
  assert.match(h.get("content-security-policy"), /frame-ancestors 'self';/);
  assert.equal(h.get("x-frame-options"), "SAMEORIGIN");
});

test("bad JSON and a server without ADMIN_PASSWORD are handled", async () => {
  const c = await signIn();
  const r = await c.post("/api/admin/tiles", { headers: { "Content-Type": "application/json" }, body: "{oops" });
  assert.equal(r.status, 400);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-test2-"));
  const { app } = await createApp({ dataDir: dir, adminPassword: "", sessionSecret: "", publicUrl: "https://hub.example", fetchImpl: fakeWeb().fetchImpl, backgroundChecks: false });
  const srv = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const b = `http://127.0.0.1:${srv.address().port}`;
  assert.equal((await (await fetch(b + "/api/hub")).json()).publicUrl, "https://hub.example");
  const login = await fetch(b + "/admin/login", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "password=anything", redirect: "manual" });
  assert.equal(login.headers.get("location"), "/admin/login?error=disabled");
  srv.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
