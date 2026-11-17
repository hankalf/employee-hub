"use strict";

/**
 * Alerts for things an admin should know about without opening the admin page:
 * a watched kiosk going offline (and coming back), and form links that stop working.
 *
 * Channels (any or both):
 *   - monday.com: a new item on the chosen board, with the details as an update.
 *     Needs MONDAY_API_TOKEN on the service.
 *   - Webhook: a JSON POST ({ text, subject, detail, hub, at }); Slack and Microsoft Teams
 *     incoming webhooks read `text`, and Zapier / Make can turn it into an email or anything else.
 */

const MONDAY_API = "https://api.monday.com/v2";
const TIMEOUT_MS = 10000;

function createAlerts({ store, devices, fetchImpl = globalThis.fetch, mondayToken = "", now = () => Date.now(), log = console } = {}) {
  const settings = () => store.get().settings.alerts || {};
  const hubName = () => (store.get().settings.hubName && store.get().settings.hubName.en) || "Employee Hub";

  async function toWebhook(url, subject, detail) {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: `*${subject}*\n${detail}`, subject, detail, hub: hubName(), at: new Date(now()).toISOString() }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`the webhook answered ${res.status}`);
  }

  async function mondayQuery(query, variables) {
    const res = await fetchImpl(MONDAY_API, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: mondayToken },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json) throw new Error(`monday.com answered ${res.status}`);
    if (json.errors && json.errors.length) throw new Error(json.errors.map((e) => e.message).join("; "));
    if (json.error_message) throw new Error(json.error_message);
    return json.data;
  }

  async function toMonday(boardId, subject, detail) {
    const data = await mondayQuery("mutation ($board: ID!, $name: String!) { create_item (board_id: $board, item_name: $name) { id } }",
      { board: String(boardId), name: `${subject}`.slice(0, 250) });
    const itemId = data && data.create_item && data.create_item.id;
    if (itemId && detail) {
      await mondayQuery("mutation ($item: ID!, $body: String!) { create_update (item_id: $item, body: $body) { id } }",
        { item: String(itemId), body: `${detail}\n\n— ${hubName()}` }).catch((e) => log.warn("monday.com update failed:", e.message));
    }
    return itemId;
  }

  /** Send to every configured channel. Returns [{ channel, ok, error }]. */
  async function send(subject, detail) {
    const a = settings();
    const results = [];
    if (a.webhookUrl) {
      try { await toWebhook(a.webhookUrl, subject, detail); results.push({ channel: "webhook", ok: true }); } catch (e) { results.push({ channel: "webhook", ok: false, error: e.message }); }
    }
    if (a.mondayBoardId) {
      if (!mondayToken) results.push({ channel: "monday", ok: false, error: "MONDAY_API_TOKEN isn't set on the service" });
      else {
        try { await toMonday(a.mondayBoardId, subject, detail); results.push({ channel: "monday", ok: true }); } catch (e) { results.push({ channel: "monday", ok: false, error: e.message }); }
      }
    }
    for (const r of results) if (!r.ok) log.warn(`Alert via ${r.channel} failed: ${r.error}`);
    return results;
  }

  const fmt = (iso) => new Date(iso).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const label = (d) => d.name || d.id.slice(0, 6);

  /** Run every minute: alert once when a watched kiosk goes quiet, and (optionally) when it's back. */
  async function checkDevices() {
    const a = settings();
    if (!a.enabled) return [];
    const minutes = Number(a.offlineMinutes) || 10;
    const sent = [];
    for (const d of devices.list()) {
      if (!d.watch) continue;
      const quietFor = now() - new Date(d.lastSeen).getTime();
      const offline = quietFor > minutes * 60000;
      if (offline && !d.alertedAt) {
        devices.markAlerted(d.id, new Date(now()).toISOString());
        await send(`Kiosk offline: ${label(d)}`, `${label(d)} hasn't checked in since ${fmt(d.lastSeen)} (${Math.round(quietFor / 60000)} minutes). Check its power and Wi-Fi.`);
        sent.push({ id: d.id, state: "offline" });
      } else if (!offline && d.alertedAt) {
        devices.markAlerted(d.id, null);
        if (a.notifyRecovery !== false) await send(`Kiosk back online: ${label(d)}`, `${label(d)} checked in again at ${fmt(d.lastSeen)}.`);
        sent.push({ id: d.id, state: "online" });
      }
    }
    return sent;
  }

  return { send, checkDevices, configured: () => Boolean(settings().webhookUrl || settings().mondayBoardId) };
}

module.exports = { createAlerts, MONDAY_API };
