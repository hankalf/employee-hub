"use strict";

// Admin logins, activity log, undo, image icons, hourly usage, kiosk tile sets/layouts, alerts,
// daily link checks, automatic backups, form QR codes and the kiosk build id.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createApp } = require("../lib/app");
const { fakeWeb } = require("./fake-web");

const OWNER_PASSWORD = "owner-test-pass";
let server, base, dataDir, ctx;
const sent = { webhook: [], monday: [] };
const web = fakeWeb();
let embedStatus = "ok"; // what the fake forms.monday.com says about form "flaky1"

async function fetchImpl(url, init = {}) {
  const u = new URL(url);
  if (u.hostname === "hooks.example.com") { sent.webhook.push(JSON.parse(init.body)); return new Response("ok", { status: 200 }); }
  if (u.hostname === "api.monday.com") {
    const body = JSON.parse(init.body);
    sent.monday.push({ ...body, auth: init.headers.Authorization });
    const data = /create_item/.test(body.query) ? { create_item: { id: "555" } } : { create_update: { id: "777" } };
    return new Response(JSON.stringify({ data }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (u.hostname === "forms.monday.com" && /flaky1/.test(u.pathname)) {
    return embedStatus === "ok" ? new Response("<html>", { status: 200 }) : new Response("<html>", { status: 200, headers: { "x-frame-options": "DENY" } });
  }
  return web.fetchImpl(url, init);
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-features-"));
  const origLog = console.log, origWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  const created = await createApp({ dataDir, adminPassword: OWNER_PASSWORD, sessionSecret: "", publicUrl: "", mondayToken: "tok-123", fetchImpl, backgroundJobs: false });
  console.log = origLog;
  console.warn = origWarn;
  ctx = created.ctx;
  await new Promise((resolve) => { server = created.app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

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
    const set = res.headers.get("set-cookie");
    if (set && set.includes("hub_admin=")) { const m = /hub_admin=([^;]*)/.exec(set); cookie = m[1] ? "hub_admin=" + m[1] : ""; }
    return res;
  }
  return { get: (u, o) => request("GET", u, o), post: (u, o) => request("POST", u, o), put: (u, o) => request("PUT", u, o), del: (u, o) => request("DELETE", u, o) };
}
async function signIn(username, password) {
  const c = client();
  const r = await c.post("/admin/login", { form: { username, password } });
  return { c, location: r.headers.get("location") };
}
const owner = async () => (await signIn("", OWNER_PASSWORD)).c;
const json = async (r) => ({ status: r.status, body: await r.json() });

test("the owner adds admins; admins sign in, must choose a password, and can't manage admins", async () => {
  const o = await owner();
  assert.equal((await signIn("admin", OWNER_PASSWORD)).location, "/admin", "the owner can also type the username admin");
  let r = await json(await o.post("/api/admin/admins", { json: { name: "Jordan Lee", username: "JLee" } }));
  assert.equal(r.status, 201);
  assert.equal(r.body.admin.username, "jlee");
  assert.match(r.body.tempPassword, /^[a-z]+-[a-z]+-\d{4}$/);
  const temp = r.body.tempPassword, id = r.body.admin.id;
  assert.equal((await o.post("/api/admin/admins", { json: { name: "x", username: "jlee" } })).status, 400, "usernames are unique");
  assert.equal((await o.post("/api/admin/admins", { json: { name: "x", username: "admin" } })).status, 400, "admin is the owner's");
  const list = await json(await o.get("/api/admin/admins"));
  assert.ok(!JSON.stringify(list.body).includes("passwordHash"), "password hashes never leave the server");

  assert.equal((await signIn("jlee", "wrong-password")).location, "/admin/login?error=wrong&u=jlee");
  const { c: j, location } = await signIn("jlee", temp);
  assert.equal(location, "/admin");
  r = await json(await j.get("/api/admin/content"));
  assert.equal(r.status, 403);
  assert.equal(r.body.code, "mustChangePassword");
  const meResp = await json(await j.get("/api/admin/me"));
  assert.equal(meResp.body.mustChangePassword, true);
  assert.equal((await j.put("/api/admin/me/password", { json: { current: "nope", next: "a-good-password" } })).status, 403);
  assert.equal((await j.put("/api/admin/me/password", { json: { current: temp, next: "short" } })).status, 400);
  assert.equal((await j.put("/api/admin/me/password", { json: { current: temp, next: "jordans-own-password" } })).status, 200);
  r = await json(await j.get("/api/admin/content"));
  assert.equal(r.status, 200, "after choosing a password the admin can work");
  assert.equal(r.body.me.role, "editor");
  assert.equal((await j.get("/api/admin/admins")).status, 403, "only the owner manages admins");
  assert.equal((await j.post("/api/admin/admins", { json: { name: "y", username: "yy" } })).status, 403);
  assert.equal((await j.put("/api/admin/me/password", { json: { current: "x", next: "yyyyyyyy" } })).status, 403);
  assert.equal((await o.put("/api/admin/me/password", { json: { current: "x", next: "yyyyyyyy" } })).status, 400, "the owner's password lives on Railway");

  // Switching an admin off signs them out; a reset gives a new temporary password and ends old sessions.
  await o.put(`/api/admin/admins/${id}`, { json: { active: false } });
  assert.equal((await j.get("/api/admin/content")).status, 401);
  assert.equal((await signIn("jlee", "jordans-own-password")).location, "/admin/login?error=wrong&u=jlee");
  await o.put(`/api/admin/admins/${id}`, { json: { active: true } });
  const { c: j2 } = await signIn("jlee", "jordans-own-password");
  assert.equal((await j2.get("/api/admin/me")).status, 200);
  r = await json(await o.post(`/api/admin/admins/${id}/reset`, {}));
  assert.equal((await j2.get("/api/admin/me")).status, 401, "a reset signs them out everywhere");
  assert.equal((await signIn("jlee", r.body.tempPassword)).location, "/admin");

  // Everything above is in the activity log, with names
  const log = (await json(await o.get("/api/admin/activity"))).body;
  const actions = log.map((e) => `${e.user}:${e.action}`);
  for (const a of ["admin:Added admin", "system:Failed sign-in", "jlee:Signed in", "jlee:Changed password", "admin:Changed admin", "admin:Reset password"]) assert.ok(actions.includes(a), a);
  const csv = await (await o.get("/api/admin/activity.csv")).text();
  assert.match(csv, /"When \(UTC\)","Name","Username","Action","Details"/);
  assert.match(csv, /"Jordan Lee","jlee","Signed in"/);
  assert.equal((await o.del(`/api/admin/admins/${id}`)).status, 200);
});

test("deleted tiles, notes and groups can be undone", async () => {
  const o = await owner();
  const before = (await json(await o.get("/api/admin/content"))).body.tiles.map((t) => t.id);
  let r = await json(await o.del("/api/admin/tiles/tagout"));
  assert.ok(r.body.undo);
  assert.ok(!(await json(await o.get("/api/admin/content"))).body.tiles.some((t) => t.id === "tagout"));
  assert.equal((await o.post(`/api/admin/undo/${r.body.undo}`, {})).status, 200);
  assert.deepEqual((await json(await o.get("/api/admin/content"))).body.tiles.map((t) => t.id), before, "back in the same place");
  assert.equal((await o.post(`/api/admin/undo/${r.body.undo}`, {})).status, 404, "an undo works once");

  const g = (await json(await o.post("/api/admin/groups", { json: { title: "Safety" } }))).body;
  await o.put("/api/admin/tiles/checklist", { json: { groupId: g.id } });
  r = await json(await o.del(`/api/admin/groups/${g.id}`));
  assert.equal((await json(await o.get("/api/admin/content"))).body.tiles.find((t) => t.id === "checklist").groupId, "");
  await o.post(`/api/admin/undo/${r.body.undo}`, {});
  const c = (await json(await o.get("/api/admin/content"))).body;
  assert.ok(c.groups.some((x) => x.id === g.id));
  assert.equal(c.tiles.find((t) => t.id === "checklist").groupId, g.id, "its tiles go back into it");
  assert.equal(c.trash, undefined, "the trash isn't sent to the admin page");

  const n = (await json(await o.post("/api/admin/notes", { json: { title: "Hello" } }))).body;
  r = await json(await o.del(`/api/admin/notes/${n.id}`));
  await o.post(`/api/admin/undo/${r.body.undo}`, {});
  assert.ok((await json(await o.get("/api/admin/content"))).body.notes.some((x) => x.id === n.id));
  await o.del(`/api/admin/notes/${n.id}`);
  await o.del(`/api/admin/groups/${g.id}`);
});

test("tiles can use an uploaded image as their icon", async () => {
  const o = await owner();
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  const fd = new FormData();
  fd.append("image", new Blob([png], { type: "image/png" }), "forklift.png");
  const r = await json(await o.post("/api/admin/images", { body: fd }));
  assert.equal(r.status, 201);
  assert.match(r.body.icon, /^img:icon-[a-f0-9]+\.png$/);
  const saved = (await json(await o.put("/api/admin/tiles/pto", { json: { icon: r.body.icon } }))).body;
  assert.equal(saved.icon, r.body.icon);
  const img = await fetch(base + r.body.url);
  assert.equal(img.status, 200);
  assert.match(img.headers.get("content-type"), /image\/png/);
  assert.equal(img.headers.get("content-security-policy"), "sandbox");
  assert.equal((await fetch(base + "/img/..%2Fcontent.json")).status, 404);
  assert.equal((await fetch(base + "/img/logo-1.png")).status, 404, "only icon images are served here");
  assert.equal((await o.put("/api/admin/tiles/pto", { json: { icon: "img:../../etc/passwd" } })).status, 400);
  const hub = await (await fetch(base + "/api/hub")).json();
  assert.equal(hub.tiles.find((t) => t.id === "pto").icon, r.body.icon);

  // An unused upload is tidied up once it's an hour old; icons in use are kept
  const fd2 = new FormData();
  fd2.append("image", new Blob([png], { type: "image/png" }), "unused.png");
  const unused = (await json(await o.post("/api/admin/images", { body: fd2 }))).body.icon.slice(4);
  const old = (Date.now() - 2 * 3600 * 1000) / 1000;
  fs.utimesSync(path.join(dataDir, "uploads", unused), old, old);
  fs.utimesSync(path.join(dataDir, "uploads", r.body.icon.slice(4)), old, old);
  await ctx.jobs.pruneImages();
  assert.ok(!fs.existsSync(path.join(dataDir, "uploads", unused)));
  assert.ok(fs.existsSync(path.join(dataDir, "uploads", r.body.icon.slice(4))));
  await o.put("/api/admin/tiles/pto", { json: { icon: "🏖️" } });
});

test("taps are counted by hour and exported as a spreadsheet", async () => {
  const o = await owner();
  for (const h of [7, 7, 7, 14]) await fetch(base + `/api/tap/pto?h=${h}`, { method: "POST" });
  await fetch(base + "/api/tap/pto?h=99", { method: "POST" }); // out of range: counted, hour from the server
  const s = (await json(await o.get("/api/admin/stats"))).body;
  assert.equal(s.usage.pto.last30, 5);
  assert.equal(s.usage.pto.hours30[7], 3);
  assert.equal(s.usage.pto.hours30[14], 1);
  assert.equal(s.usage.pto.hours30.reduce((a, b) => a + b, 0), 5);
  const r = await o.get("/api/admin/stats.csv");
  assert.match(r.headers.get("content-disposition"), /employee-hub-taps-\d{4}-\d{2}-\d{2}\.csv/);
  const csv = await r.text();
  assert.match(csv, /"Date","Tile","Taps","00:00"/);
  assert.match(csv, /"Request time off","5"/);
});

test("each kiosk can show its own groups and layout, and reports its model", async () => {
  const o = await owner();
  const dock = (await json(await o.post("/api/admin/groups", { json: { title: "Dock" } }))).body;
  await o.put("/api/admin/tiles/tagout", { json: { groupId: dock.id } });
  const id = "a1b2c3d4e5f60718293a";
  await fetch(base + "/api/heartbeat", { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ deviceId: id, screen: "360x640", path: "/kiosk", model: "TC52<script>", scanner: true }) });
  let hub = await (await fetch(base + `/api/hub?device=${id}`)).json();
  assert.equal(hub.tiles.length, 4, "a new kiosk shows everything");
  assert.equal(hub.device.named, false);
  assert.equal(hub.device.layout, "auto");
  assert.match(hub.build, /^[a-f0-9]{12}$/);
  assert.equal((await o.put(`/api/admin/devices/${id}`, { json: { groups: [dock.id, "nonsense"], layout: "scanner", name: "Dock scanner", watch: true } })).status, 200);
  assert.equal((await o.put(`/api/admin/devices/${id}`, { json: { layout: "giant" } })).status, 400);
  hub = await (await fetch(base + `/api/hub?device=${id}`)).json();
  assert.deepEqual(hub.tiles.map((t) => t.id), ["tagout"]);
  assert.equal(hub.device.layout, "scanner");
  assert.equal(hub.device.named, true);
  assert.equal((await (await fetch(base + "/api/hub")).json()).tiles.length, 4, "other devices still see everything");
  await o.put(`/api/admin/devices/${id}`, { json: { groups: [""] } });
  hub = await (await fetch(base + `/api/hub?device=${id}`)).json();
  assert.ok(!hub.tiles.some((t) => t.id === "tagout"), "\"\" means tiles without a group");
  const dev = (await json(await o.get("/api/admin/stats"))).body.devices.find((d) => d.id === id);
  assert.equal(dev.model, "TC52script", "the model is cleaned");
  assert.equal(dev.scanner, true);
  assert.equal(dev.watch, true);
  await o.put(`/api/admin/devices/${id}`, { json: { groups: null, watch: false } });
  await o.del(`/api/admin/groups/${dock.id}`);
});

test("settings: list layout, scanner mode, lockdown and form QR", async () => {
  const o = await owner();
  assert.equal((await o.put("/api/admin/appearance", { json: { tileLayout: "list" } })).status, 200);
  assert.equal((await o.put("/api/admin/appearance", { json: { tileLayout: "grid" } })).status, 400);
  assert.equal((await o.put("/api/admin/settings", { json: { scannerMode: "off", lockdown: "named", formQr: false } })).status, 200);
  assert.equal((await o.put("/api/admin/settings", { json: { lockdown: "always" } })).status, 400);
  let hub = await (await fetch(base + "/api/hub")).json();
  assert.equal(hub.appearance.tileLayout, "list");
  assert.equal(hub.settings.scannerMode, "off");
  assert.equal(hub.settings.lockdown, "named");
  assert.equal(hub.tiles[0].phoneQr, false);
  await o.put("/api/admin/appearance", { json: { tileLayout: "tiles" } });
  await o.put("/api/admin/settings", { json: { scannerMode: "auto", lockdown: "tablets", formQr: true } });

  // The form page's QR code: the normal form address, never for a PIN-protected tile
  await o.put("/api/admin/tiles/pto", { json: { url: '<iframe src="https://forms.monday.com/forms/embed/abc123?r=use1"></iframe>' } });
  hub = await (await fetch(base + "/api/hub")).json();
  assert.equal(hub.tiles.find((t) => t.id === "pto").phoneQr, true);
  let r = await fetch(base + "/qr.svg?tile=pto");
  assert.equal(r.status, 200);
  assert.match(await r.text(), /aria-label="QR code linking to https:\/\/forms\.monday\.com\/forms\/abc123\?r=use1"/);
  await o.put("/api/admin/tiles/pto", { json: { pin: "1234" } });
  assert.equal((await fetch(base + "/qr.svg?tile=pto")).status, 404);
  assert.equal((await (await fetch(base + "/api/hub")).json()).tiles.find((t) => t.id === "pto").phoneQr, false);
  assert.equal((await fetch(base + "/qr.svg?tile=nope")).status, 404);
  await o.put("/api/admin/tiles/pto", { json: { clearPin: true, url: "" } });
});

test("alerts: settings stay private, offline kiosks and recoveries are reported", async () => {
  const o = await owner();
  assert.equal((await o.put("/api/admin/settings", { json: { alerts: { webhookUrl: "http://insecure.example.com/x" } } })).status, 400);
  assert.equal((await o.put("/api/admin/settings", { json: { alerts: { mondayBoardId: "not a board" } } })).status, 400);
  const r = await json(await o.put("/api/admin/settings", { json: { alerts: { enabled: true, offlineMinutes: 5, webhookUrl: "https://hooks.example.com/T1/B2", mondayBoardId: "https://acme.monday.com/boards/1234567890/views/9" } } }));
  assert.equal(r.body.alerts.mondayBoardId, "1234567890");
  const hubText = await (await fetch(base + "/api/hub")).text();
  assert.ok(!hubText.includes("hooks.example.com") && !hubText.includes("1234567890"), "alert settings never reach the kiosk");

  // Test alert goes to both channels
  sent.webhook.length = 0; sent.monday.length = 0;
  const t = await json(await o.post("/api/admin/alerts/test", {}));
  assert.deepEqual(t.body.results.map((x) => `${x.channel}:${x.ok}`), ["webhook:true", "monday:true"]);
  assert.match(sent.webhook[0].text, /Test alert/);
  assert.equal(sent.monday[0].auth, "tok-123");
  assert.equal(sent.monday[0].variables.board, "1234567890");
  assert.match(sent.monday[1].query, /create_update/);

  // A watched kiosk goes quiet, then comes back
  const id = "ffeeddccbbaa99887766";
  await fetch(base + "/api/heartbeat", { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ deviceId: id }) });
  await o.put(`/api/admin/devices/${id}`, { json: { name: "Break room iPad", watch: true } });
  sent.webhook.length = 0;
  ctx.devices.get()[id].lastSeen = new Date(Date.now() - 20 * 60000).toISOString();
  let out = await ctx.jobs.checkDevices();
  assert.deepEqual(out, [{ id, state: "offline" }]);
  assert.match(sent.webhook[0].subject, /Kiosk offline: Break room iPad/);
  out = await ctx.jobs.checkDevices();
  assert.deepEqual(out, [], "only one alert per outage");
  await fetch(base + "/api/heartbeat", { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ deviceId: id }) });
  out = await ctx.jobs.checkDevices();
  assert.deepEqual(out, [{ id, state: "online" }]);
  assert.match(sent.webhook[1].subject, /back online/);
  // Unwatched kiosks never alert
  await o.put(`/api/admin/devices/${id}`, { json: { watch: false } });
  ctx.devices.get()[id].lastSeen = new Date(Date.now() - 60 * 60000).toISOString();
  assert.deepEqual(await ctx.jobs.checkDevices(), []);
  await o.del(`/api/admin/devices/${id}`);
});

test("the daily link check alerts when a form stops working", async () => {
  const o = await owner();
  embedStatus = "ok";
  const tile = (await json(await o.post("/api/admin/tiles", { json: { title: "Flaky form", url: "https://forms.monday.com/forms/flaky1?r=use1" } }))).body;
  assert.equal(tile.embedCheck.status, "ok");
  sent.webhook.length = 0;
  assert.deepEqual(await ctx.jobs.runLinkCheck(), []);
  embedStatus = "blocked";
  const problems = await ctx.jobs.runLinkCheck();
  assert.equal(problems.length, 1);
  assert.equal(problems[0].tile, "Flaky form");
  assert.match(sent.webhook[0].subject, /1 form link stopped working/);
  assert.match(sent.webhook[0].detail, /Flaky form/);
  assert.deepEqual(await ctx.jobs.runLinkCheck(), [], "a known problem isn't reported again");
  assert.ok(ctx.store.get().meta.lastLinkCheck);
  await o.del(`/api/admin/tiles/${tile.id}`);
  await o.put("/api/admin/settings", { json: { alerts: { enabled: false } } });
});

test("automatic backups: kept on the server, downloadable, restorable by the owner only", async () => {
  const o = await owner();
  const name = await ctx.jobs.runAutoBackup();
  assert.match(name, /^auto-\d{4}-\d{2}-\d{2}\.zip$/);
  for (const d of ["2020-01-01", "2020-01-02", "2020-01-03", "2020-01-04", "2020-01-05", "2020-01-06", "2020-01-07", "2020-01-08"]) {
    fs.writeFileSync(path.join(dataDir, "backups", `auto-${d}.zip`), "x");
  }
  await ctx.jobs.runAutoBackup();
  const list = (await json(await o.get("/api/admin/backups"))).body;
  assert.equal(list.length, 7, "the last 7 are kept");
  assert.equal(list[0].name, name);
  const dl = await o.get(`/api/admin/backups/${name}`);
  assert.equal(dl.status, 200);
  assert.equal((await o.get("/api/admin/backups/..%2Fcontent.json")).status, 404);

  // An editor can make and download backups but not restore
  const added = (await json(await o.post("/api/admin/admins", { json: { name: "Sam", username: "sam" } }))).body;
  const { c: sam } = await signIn("sam", added.tempPassword);
  await sam.put("/api/admin/me/password", { json: { current: added.tempPassword, next: "sams-password-1" } });
  assert.equal((await sam.post("/api/admin/backups/run", {})).status, 200);
  assert.equal((await sam.post(`/api/admin/backups/${name}/restore`, {})).status, 403);
  assert.equal((await sam.post("/api/admin/restore", {})).status, 403);

  // The owner restores today's backup (the one Sam just made, which replaced today's automatic one):
  // a tile added afterwards disappears, and admin logins come back with their own passwords.
  await o.post("/api/admin/tiles", { json: { title: "After the backup" } });
  assert.equal((await o.post(`/api/admin/backups/${name}/restore`, {})).status, 200);
  const c = (await json(await o.get("/api/admin/content"))).body;
  assert.ok(!c.tiles.some((t) => t.title.en === "After the backup"));
  assert.ok((await json(await o.get("/api/admin/admins"))).body.some((a) => a.username === "sam"));
  assert.equal((await signIn("sam", "sams-password-1")).location, "/admin", "restored logins keep their passwords");
  const log = (await json(await o.get("/api/admin/activity"))).body;
  assert.ok(log.some((e) => e.action === "Restored backup" && e.detail === name));
});
