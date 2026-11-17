"use strict";

/** Stands in for monday.com (and a couple of other sites) so link checks are tested without the internet. */
function fakeWeb() {
  const calls = [];
  const res = (status, headers = {}) => new Response(status >= 300 && status < 400 ? null : "<html></html>", { status, headers });
  async function fetchImpl(url) {
    calls.push(url);
    const u = new URL(url);
    if (u.hostname === "wkf.ms") {
      const to = { "/abc": "abc123", "/blk": "blocked1", "/old": "gone1" }[u.pathname];
      return to ? res(301, { location: `https://forms.monday.com/forms/${to}?r=use1` }) : res(404);
    }
    if (u.hostname === "forms.monday.com") {
      const id = u.pathname.replace(/^\/forms\/(embed\/)?/, "");
      if (id === "blocked1") return res(200, { "x-frame-options": "SAMEORIGIN" });
      if (id === "login1") return res(302, { location: "https://auth.monday.com/login?return_to=x" });
      if (id === "gone1") return res(404);
      if (id === "slow1") throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
      return res(200, { "content-security-policy": "frame-ancestors *" });
    }
    if (u.hostname === "auth.monday.com") return res(200);
    if (u.hostname.endsWith(".monday.com")) return res(302, { location: "https://auth.monday.com/login" });
    if (u.hostname === "example.com") return res(200, { "content-security-policy": "default-src 'self'; frame-ancestors 'self'" });
    if (u.hostname === "docs.example.org") return res(200);
    throw new TypeError("fetch failed");
  }
  return { fetchImpl, calls };
}

module.exports = { fakeWeb };
