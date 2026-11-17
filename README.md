# Employee Hub

A kiosk for warehouse employees, shown on an iPad or a computer screen, or opened on a phone by scanning a QR code. The kiosk page is a grid of big, glove-friendly tiles that open your **monday.com forms** (daily forklift check, tag-outs, PTO, gear requests…) inside the page. A note beside the greeting carries announcements. An admin area sets up the tiles, the note, your logo and how the kiosk looks, in English and Spanish.

- **Kiosk** (`/kiosk`): greeting, note, and the tiles across the full width. Picks up admin changes within a minute, so it never needs reloading. The root address `/` redirects here, so the short address on the QR code works.
- **Form page** (`/open/t/…`): a tile's form inside the hub with a "Back to hub" button. After a period with no taps it returns home.
- **QR code** (`/qr`): a printable code that opens the hub on a phone. A small one is also in the top bar.
- **Admin** (`/admin`): tiles and settings, protected by the `ADMIN_PASSWORD` service variable. Reached from the small *Admin* link at the bottom of the kiosk page.

Built with Node.js and Express. No database: settings and the logo live on a Railway Volume. No build step.

---

## Deploying on Railway

1. **Create the service.** In Railway, go to *New Project → Deploy from GitHub repo* and pick this repository. Railway detects Node and runs `npm start`; `railway.json` adds the health check and restart policy.
2. **Add a Volume.** Right-click the service → *Attach Volume* → mount path **`/data`**. Without it, your tiles, settings and logo are wiped on every redeploy.
3. **Set variables.** Service → *Variables*:

   | Variable | Required | What it does |
   |---|---|---|
   | `ADMIN_PASSWORD` | ✅ | Password for the admin area at `/admin`. Changing it signs every admin out. |
   | `SESSION_SECRET` | optional | Random string used to sign the admin login cookie. Generated and kept on the Volume if empty. |
   | `PUBLIC_URL` | optional | The hub's public address, used for the QR code. Defaults to the address the page is opened on; you can also set it in *Settings*. |

4. **Get a web address.** Service → *Settings → Networking → Generate Domain*, or add your own domain.
5. Open `https://<your-domain>/admin`, sign in, and paste your form links into the tiles. The kiosk itself is at `https://<your-domain>/kiosk`.

---

## Setting up the hub

### Tiles (monday.com forms)

1. In monday.com, open the board's form (or create one with *WorkForms*). Click **Share** and copy the link, which looks like `https://forms.monday.com/forms/…?r=use1`. The form's sharing must be set to anyone with the link.
2. In *Admin → Tiles*, add or edit a tile and paste the link. The admin area recognises form links and opens them inside the hub, switching to monday's embed address automatically.
3. Give the tile an icon (pick an emoji), a short description and, optionally, a corner label. Use the arrows to order the tiles.
4. Tiles without a link show as **Coming soon**. Switch a tile off to hide it entirely.

Any web address works too: a Google Form, a SharePoint page, a monday board or dashboard (those need a monday login, so choose *Open in a new tab*).

### Note

*Admin → Settings → Note on the kiosk*: a title and text in English and Spanish, a style (info, important or good news) and an optional "show until" date. It appears beside the greeting on the kiosk and hides itself after that date.

### Logo and appearance

*Admin → Settings → Logo*: upload a PNG, SVG, JPG, GIF or WebP (max 2 MB). It replaces the accent pill in the top bar of the kiosk, on the QR page and in the admin area.

*Admin → Settings → Appearance*: theme (follow the device, always light or always dark), spectrum or solid accent colour, optional background colour, card style (frosted, solid or outline), corner roundness, font, tile size, tiles per row, and whether to show the corner labels, the date and the intro line. A live preview of the kiosk sits under the form and updates when you save.

### Spanish

Every title and description has an English and a Spanish box; Spanish falls back to English when empty. The kiosk shows an EN / ES switch, which you can turn off in *Settings* for English only.

### iPad kiosk tips

- Open `https://<your-domain>/kiosk` in Safari and *Add to Home Screen*; launching it from there hides the browser bars.
- Turn on **Guided Access** (Settings → Accessibility) so people can't leave the hub.
- *Settings → Return to home after* controls how long a form stays open with no taps before the kiosk goes back to the home screen (default 5 minutes; the last 30 seconds show a warning that any tap cancels).

---

## Running locally

```bash
npm install
ADMIN_PASSWORD=secret123 npm start
# → kiosk at http://localhost:3000/kiosk   admin at http://localhost:3000/admin
npm test                    # automated tests
```

Local data is stored in `./storage` (git-ignored). GitHub Actions runs `npm test` on every push.

## What's on the Volume

```
/data/content.json    tiles, note, appearance, settings
/data/uploads/        the logo
/data/session.key     cookie signing key (if SESSION_SECRET isn't set)
```

All small; Railway's Volume backups cover them.

## Project layout

```
server.js                 Reads config from environment variables and starts the app
lib/app.js                Express app: kiosk pages, public API, admin login and admin API, logo upload
lib/store.js              content.json: validation for tiles, note, appearance and settings
lib/links.js              Link clean-up; turns form share links into embed links
lib/auth.js               Admin session cookie, CSRF check, sign-in rate limiting
lib/qr.js                 QR code encoder (no dependencies)
public/                   Kiosk pages (index, open, qr) and shared CSS/JS; admin CSS/JS
views/                    Admin sign-in and admin pages
seed/content.json         Starter tiles, copied in on the very first start
test/                     Automated tests (node --test)
```

## Security notes

- The kiosk pages are public. The admin area needs `ADMIN_PASSWORD`; after 10 wrong tries from one address, sign-in is locked for 15 minutes.
- The admin cookie is HttpOnly and signed. Every change made through the API requires a custom header, which blocks cross-site request forgery.
- The logo is served with a sandboxing Content-Security-Policy, and only image types are accepted.
- Pages send a Content-Security-Policy that allows only https pages to be embedded, and the hub can only be framed by itself (for the admin preview).
