"use strict";

/**
 * Link helpers. Tiles and quick links point at monday.com forms, monday boards,
 * or any other website. We normalise what admins paste and work out whether a
 * link can be shown inside the hub (in an iframe) or must open in a new tab.
 */

const MAX_URL = 2000;

/**
 * Pull the address out of pasted embed code, e.g. monday's
 * <iframe src="https://forms.monday.com/forms/embed/abc?r=use1" width="650" …></iframe>.
 * Anything that isn't embed code is returned unchanged.
 */
function extractFromEmbedCode(input) {
  const s = String(input == null ? "" : input).trim();
  if (!/^</.test(s) && !/\bsrc\s*=/i.test(s)) return s;
  const m = /<iframe\b[^>]*?\bsrc\s*=\s*(["'])(.*?)\1/is.exec(s) || /\bsrc\s*=\s*(["'])(.*?)\1/is.exec(s);
  if (!m) return s;
  return m[2].trim().replace(/&amp;/g, "&").replace(/^\/\//, "https://");
}

/** Clean up a pasted address or embed code. Adds https:// when missing. Throws on anything that isn't a web address. */
function normalizeUrl(input, { allowEmpty = false } = {}) {
  let s = extractFromEmbedCode(input);
  if (/^</.test(s)) throw new Error("That embed code doesn't contain a form address. Copy it again from monday.com (Share form → Embed).");
  if (!s) {
    if (allowEmpty) return "";
    throw new Error("Please enter a link.");
  }
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = "https://" + s;
  let u;
  try { u = new URL(s); } catch (e) { throw new Error("That link doesn't look like a web address."); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("Links must start with http:// or https://");
  if (!u.hostname.includes(".") && u.hostname !== "localhost") throw new Error("That link doesn't look like a web address.");
  if (u.href.length > MAX_URL) throw new Error(`Links can be at most ${MAX_URL} characters.`);
  return u.href;
}

const FORM_RE = /^\/forms\/(embed\/)?([A-Za-z0-9_-]+)\/?$/;
const SHORT_HOSTS = ["wkf.ms"];
const VIEW_RE = /^\/(embed\/)?(\d+-[A-Za-z0-9_-]+)\/?$/;

/**
 * What kind of link is this, and which address should go in an iframe?
 *   form          monday.com WorkForm share link  → embeddable (we switch to the /forms/embed/ address)
 *   public-board  monday.com "share board publicly" link (view.monday.com) → embeddable
 *   form-short    monday.com WorkForm short link (wkf.ms) → resolved on the server to the full form link
 *   monday        a board/dashboard/doc inside a monday account → needs a monday login, open in a new tab
 *   web           anything else → may or may not allow embedding; the server checks
 */
function describeLink(url) {
  let u;
  try { u = new URL(url); } catch (e) { return { kind: "web", embedUrl: url, host: "" }; }
  const host = u.hostname.toLowerCase();
  if (host === "forms.monday.com") {
    const m = FORM_RE.exec(u.pathname);
    if (m) {
      const embed = new URL(u.href);
      embed.pathname = `/forms/embed/${m[2]}`;
      return { kind: "form", embedUrl: embed.href, host, formId: m[2] };
    }
  }
  if (SHORT_HOSTS.includes(host)) {
    return { kind: "form-short", embedUrl: u.href, host };
  }
  if (host === "view.monday.com") {
    const m = VIEW_RE.exec(u.pathname);
    if (m) {
      const embed = new URL(u.href);
      embed.pathname = `/embed/${m[2]}`;
      return { kind: "public-board", embedUrl: embed.href, host };
    }
  }
  if (host === "monday.com" || host.endsWith(".monday.com")) {
    return { kind: "monday", embedUrl: u.href, host, boardId: boardIdFromUrl(u.href) };
  }
  return { kind: "web", embedUrl: u.href, host };
}

/** "https://acme.monday.com/boards/1234567890/views/55" → "1234567890". Also accepts a bare number. */
function boardIdFromUrl(input) {
  const s = String(input || "").trim();
  if (/^\d{3,20}$/.test(s)) return s;
  const m = /\/boards\/(\d+)/.exec(s);
  return m ? m[1] : "";
}

module.exports = { normalizeUrl, describeLink, boardIdFromUrl, extractFromEmbedCode, MAX_URL, SHORT_HOSTS };
