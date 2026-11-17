"use strict";

// End-to-end tests against a real server on a random port with a throwaway data folder.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createApp } = require("../lib/app");

const ADMIN_PASSWORD = "hub-test-pass";
let server, base, dataDir;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-test-"));
  const origLog = console.log;
  console.log = () => {};
  const { app } = await createApp({ dataDir, adminPassword: ADMIN_PASSWORD, sessionSecret: "", publicUrl: "" });
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
    const set = res.headers.get("set-cookie");
    if (set && set.includes("hub_admin=")) {
      const m = /hub_admin=([^;]*)/.exec(set);
      cookie = m[1] ? "hub_admin=" + m[1] : "";
    }
    return res;
  }
  return { request, get: (u, o) => request("GET", u, o), post: (u, o) => request("POST", u, o), put: (u, o) => request("PUT", u, o), del: (u, o) => request("DELETE", u, o) };
}

async function signIn() {
  const c = client();
  const res = await c.post("/admin/login", { form: { password: ADMIN_PASSWORD } });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/admin");
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
    assert.equal(r.headers.get("x-frame-options"), "SAMEORIGIN");
  }
  const svg = await fetch(base + "/qr.svg");
  assert.equal(svg.status, 200);
  assert.match(svg.headers.get("content-type"), /image\/svg\+xml/);
  assert.equal((await fetch(base + "/logo")).status, 404);
  assert.equal((await fetch(base + "/nope")).status, 404);
  assert.equal((await fetch(base + "/api/nope")).status, 404);
});

test("the public hub view has the seeded tiles, note and appearance", async () => {
  const hub = await (await fetch(base + "/api/hub")).json();
  assert.equal(hub.tiles.length, 4);
  assert.equal(hub.tiles[0].id, "checklist");
  assert.equal(hub.tiles[0].kind, "none");
  assert.equal(hub.note.active, false);
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

test("note and appearance are saved and shown to the kiosk", async () => {
  const c = await signIn();
  let r = await c.put("/api/admin/note", { json: { active: true, style: "important", title: { en: "Safety meeting" }, body: { en: "Friday 2pm in the break room", es: "Viernes 2pm" }, until: "2099-01-01" } });
  assert.equal(r.status, 200);
  r = await c.put("/api/admin/note", { json: { style: "loud" } });
  assert.equal(r.status, 400);
  r = await c.put("/api/admin/appearance", { json: { theme: "dark", accent: "#ff8800", tileColumns: "3", showCodes: false } });
  assert.equal(r.status, 200);
  r = await c.put("/api/admin/appearance", { json: { accent: "orange" } });
  assert.equal(r.status, 400);
  const hub = await (await fetch(base + "/api/hub")).json();
  assert.equal(hub.note.active, true);
  assert.equal(hub.note.title.en, "Safety meeting");
  assert.equal(hub.appearance.theme, "dark");
  assert.equal(hub.appearance.accent, "#ff8800");
  assert.equal(hub.appearance.tileColumns, "3");
  assert.equal(hub.appearance.showCodes, false);
  assert.equal(hub.appearance.cardStyle, "frosted"); // untouched fields keep their defaults
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

test("bad JSON and a server without ADMIN_PASSWORD are handled", async () => {
  const c = await signIn();
  const r = await c.post("/api/admin/tiles", { headers: { "Content-Type": "application/json" }, body: "{oops" });
  assert.equal(r.status, 400);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-test2-"));
  const { app } = await createApp({ dataDir: dir, adminPassword: "", sessionSecret: "", publicUrl: "https://hub.example" });
  const srv = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const b = `http://127.0.0.1:${srv.address().port}`;
  assert.equal((await (await fetch(b + "/api/hub")).json()).publicUrl, "https://hub.example");
  const login = await fetch(b + "/admin/login", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "password=anything", redirect: "manual" });
  assert.equal(login.headers.get("location"), "/admin/login?error=disabled");
  srv.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
