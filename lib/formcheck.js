"use strict";

const { describeLink } = require("./links");

/**
 * Checks, from the server, whether a tile's link can be shown inside the hub.
 *
 *  1. Short links (wkf.ms/…) are followed to the real form address.
 *  2. The address that will go in the iframe (monday's /forms/embed/ address for forms)
 *     is requested, following redirects, and its answer is read:
 *       ok        the page allows being shown inside another site
 *       blocked   X-Frame-Options or CSP frame-ancestors forbid it → the kiosk opens it full screen
 *       login     it redirects to a monday.com sign-in page → the form isn't public
 *       notfound  404 / 410 → deleted form or a broken link
 *       unknown   the server couldn't tell (network error, bot protection…) → the kiosk tries the iframe
 */

const MAX_HOPS = 6;
const TIMEOUT_MS = 8000;
const CACHE_MS = 10 * 60 * 1000;
const UA = "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

function isLoginUrl(u) {
  try {
    const x = new URL(u);
    const host = x.hostname.toLowerCase();
    return host === "auth.monday.com" || /(^|\/)(login|signin|sign_in|auth)(\/|$)/i.test(x.pathname) && host.endsWith("monday.com");
  } catch (e) {
    return false;
  }
}

/** Does a host-source from frame-ancestors (e.g. "https://*.example.com", "hub.example.com") match `origin`? */
function sourceMatches(src, origin) {
  if (!origin) return false;
  let o;
  try { o = new URL(origin); } catch (e) { return false; }
  const s = src.replace(/^'|'$/g, "").toLowerCase();
  if (s === "*") return true;
  if (s === o.protocol) return true; // "https:"
  const m = /^(?:([a-z][a-z0-9+.-]*):\/\/)?([^/:]+)(?::(\d+|\*))?/.exec(s);
  if (!m) return false;
  if (m[1] && `${m[1]}:` !== o.protocol) return false;
  const host = m[2], oh = o.hostname.toLowerCase();
  if (host.startsWith("*.")) return oh.endsWith(host.slice(1));
  return host === oh;
}

/** Read X-Frame-Options and CSP frame-ancestors. CSP wins when both are present, as in browsers. */
function framingAllowed(headers, origin) {
  const csp = headers.get("content-security-policy") || "";
  const directive = csp.split(/[;,]/).map((d) => d.trim()).find((d) => /^frame-ancestors(\s|$)/i.test(d));
  if (directive) {
    const sources = directive.split(/\s+/).slice(1).filter(Boolean);
    if (sources.some((s) => sourceMatches(s, origin) || s === "*")) return { allowed: true };
    return { allowed: false, detail: `the site only allows "${directive}"` };
  }
  const xfo = (headers.get("x-frame-options") || "").trim();
  if (/deny|sameorigin|allow-from/i.test(xfo)) return { allowed: false, detail: `the site sends X-Frame-Options: ${xfo}` };
  return { allowed: true };
}

function createChecker({ fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  const cache = new Map();

  async function request(url) {
    const res = await fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml", "Sec-Fetch-Dest": "iframe" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.body && typeof res.body.cancel === "function") res.body.cancel().catch(() => {});
    return res;
  }

  /** Follow redirects ourselves so we can see each hop. */
  async function follow(url) {
    let current = url;
    for (let i = 0; i < MAX_HOPS; i++) {
      const res = await request(current);
      const loc = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && loc) {
        current = new URL(loc, current).href;
        if (isLoginUrl(current)) return { finalUrl: current, res, login: true };
        continue;
      }
      return { finalUrl: current, res, login: isLoginUrl(current) };
    }
    throw new Error("too many redirects");
  }

  /** The full address behind a short link, or the link itself. */
  async function resolve(url) {
    if (describeLink(url).kind !== "form-short") return url;
    const { finalUrl } = await follow(url);
    return finalUrl;
  }

  async function check(url, { origin = "", fresh = false } = {}) {
    const key = `${url} ${origin}`;
    const hit = cache.get(key);
    if (hit && !fresh && now() - hit.at < CACHE_MS) return hit.result;
    let result;
    try {
      const resolvedUrl = await resolve(url);
      const d = describeLink(resolvedUrl);
      const target = d.embedUrl;
      const { finalUrl, res, login } = await follow(target);
      const base = { resolvedUrl: resolvedUrl !== url ? resolvedUrl : "", embedUrl: target, finalUrl, kind: d.kind, httpStatus: res.status };
      if (login) result = { ...base, status: "login", detail: "it redirects to a monday.com sign-in page" };
      else if (res.status === 404 || res.status === 410) result = { ...base, status: "notfound", detail: `the server answered ${res.status}` };
      else if (res.status >= 200 && res.status < 300) {
        const f = framingAllowed(res.headers, origin);
        result = f.allowed ? { ...base, status: "ok", detail: "" } : { ...base, status: "blocked", detail: f.detail };
      } else result = { ...base, status: "unknown", detail: `the server answered ${res.status}` };
    } catch (e) {
      result = { resolvedUrl: "", embedUrl: "", status: "unknown", detail: e.name === "TimeoutError" ? "it took too long to answer" : `it couldn't be reached (${e.message})` };
    }
    result.checkedAt = new Date(now()).toISOString();
    cache.set(key, { at: now(), result });
    if (cache.size > 500) cache.clear();
    return result;
  }

  return { check, resolve, follow };
}

module.exports = { createChecker, framingAllowed, sourceMatches, isLoginUrl };
