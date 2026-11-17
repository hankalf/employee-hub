# Employee Hub

A kiosk for warehouse employees, shown on an iPad or a computer screen, or opened on a phone by scanning a QR code. The kiosk page is a grid of big, glove-friendly tiles that open your **monday.com forms** (daily forklift check, tag-outs, PTO, gear requests…) inside the page. Notes beside the greeting carry announcements. An admin area sets up the tiles, notes, your logo and how the kiosk looks, in English and Spanish.

What's included:

- **Tiles** that open monday.com forms inside the page, optionally under **group headings** (Safety, Time off…).
- **Scheduled tiles** that only appear on certain days and times, such as the pre-shift check from 5 to 8 am.
- **Lead-only tiles** that ask for a PIN on a keypad before opening; the link stays hidden until the PIN is right.
- **Notes** beside the greeting, several at once, each with optional start and end dates so you can schedule them ahead.
- A **screensaver** after a few idle minutes: logo, clock, notes and a big QR code.
- **Tap counts** per tile for the last 7 and 30 days.
- **Kiosk status**: every tablet checks in once a minute and the admin shows which are online.
- **Backup and restore** of everything as a single zip.
- Your **logo** and **appearance** choices (theme, colours, card style, corners, font, tile size and columns).

- **Kiosk** (`/kiosk`): greeting, notes, and the tiles across the full width. Picks up admin changes within a minute, so it never needs reloading. The root address `/` redirects here, so the short address on the QR code works.
- **Form page** (`/open/t/…`): a tile's form inside the hub with a "Back to hub" button. After a period with no taps it returns home.
- **QR code** (`/qr`): a printable code that opens the hub on a phone. A small one is also in the top bar.
- **Admin** (`/admin`): *Tiles*, *Notes* and *Settings*, protected by the `ADMIN_PASSWORD` service variable. Reached from the small *Admin* link at the bottom of the kiosk page.

Built with Node.js and Express. No database: settings and the logo live on a Railway Volume. No build step.

---

## Deploying on Railway

1. **Create the service.** In Railway, go to *New Project → Deploy from GitHub repo* and pick this repository. Railway detects Node and runs `npm start`; `railway.json` adds the health check and restart policy.
2. **Add a Volume.** Right-click the service → *Attach Volume* → mount path **`/data`**. Without it, your tiles, notes, settings, logo and tap counts are wiped on every redeploy.
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

1. In monday.com, open the board's form (or create one with *WorkForms*) and click **Share form**. Either:
   - **Share link**: copy the link (`https://forms.monday.com/forms/…?r=use1`, or the short `https://wkf.ms/…`), or
   - **Embed code**: choose *Embed* and copy the whole `<iframe …>` code.

   The form must accept submissions from anyone with the link, not only people signed in to monday.com.
2. In *Admin → Tiles*, add or edit a tile, choose *Share link* or *Embed code* above the link box, and paste. Embed code is replaced by the form address inside it. Short links are followed to the real form, and every form is shown inside the hub through monday's embed address.
3. When you save, the server asks monday.com whether the form can be shown inside the hub, and the tile gets a label: *shows inside the hub*, *opens full screen* (the site refuses to be embedded, so the kiosk opens it on its own page), *needs a monday login* or *form not found*. **Check links** asks again for every tile, for example after you change a form's sharing settings.
4. Give the tile an icon (pick an emoji), a short description and, optionally, a corner label. Use the arrows to order the tiles.
5. Tiles without a link show as **Coming soon**. Switch a tile off to hide it entirely.

If a form shows a blank box on the kiosk, tap **Open full screen** at the top of the form page, then use **Check links** in the admin to see what monday.com reports for it.

Any web address works too: a Google Form, a SharePoint page, a monday board or dashboard (those need a monday login, so choose *Open in a new tab*).

Each tile row shows how many times it was tapped in the last 30 days; hover for the all-time total.

### Groups

*Admin → Tiles → Add group* creates a heading such as *Safety* or *Time off*. Choose a tile's group in the tile editor. Tiles without a group are shown first; groups follow in the order you set with the arrows. Deleting a group keeps its tiles.

### Schedules

In the tile editor, tick *Only show this tile at certain times*, pick the days and the time window. An end time earlier than the start runs overnight (22:00 to 06:00). The kiosk uses its own clock, so set the tablet's time zone correctly.

### Lead-only tiles

In the tile editor, tick *Ask for a PIN before opening* and enter 4 to 8 digits. The tile shows a lock and opens a keypad. The form link is never sent to the kiosk until the right PIN is entered, and then only for 15 minutes on that device. After 15 wrong PINs from one place, the keypad is locked for 15 minutes. Leave the PIN box blank when editing to keep the current PIN; untick the box to remove it.

### Notes

*Admin → Notes*: a title and text in English and Spanish, a style (info, important or good news) and optional *Show from* and *Show until* dates. Several notes can show at once, stacked in the order you set. Each row says whether it is showing now, scheduled or finished.

### Screensaver

*Settings → Kiosk → Screensaver after* (default 3 minutes; 0 turns it off). With no taps on the home screen for that long, the kiosk shows the logo, a large clock, the current notes and the QR code. The first tap only closes the screensaver, so nobody opens a form by accident.

### Kiosks

Every device showing the kiosk checks in once a minute. The admin header shows how many are online, and *Settings → Kiosks* lists each one with when it was last seen. Give each a name (for example *Break room iPad*) so you can tell them apart. A kiosk that goes quiet has usually lost power or Wi-Fi.

### Logo and appearance

*Admin → Settings → Logo*: upload a PNG, SVG, JPG, GIF or WebP (max 2 MB). It replaces the accent pill in the top bar of the kiosk, on the screensaver, on the QR page and in the admin area.

*Admin → Settings → Appearance*: theme (follow the device, always light or always dark), spectrum or solid accent colour, optional background colour, card style (frosted, solid or outline), corner roundness, font, tile size, tiles per row, and whether to show the corner labels, the date and the intro line. A live preview of the kiosk sits under the form and updates when you save.

### Backup and restore

*Settings → Backup and restore → Download backup* gives you a zip with every tile, group, note and setting, the logo, tap counts and the kiosk list. *Restore from backup* replaces everything with a zip's contents; the content from just before is kept on the server as `before-restore-<date>.json` (the last two are kept). Railway's own Volume backups are worth turning on too.

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
/data/content.json    tiles, groups, notes, appearance, settings
/data/stats.json      tap counts per tile (last 90 days)
/data/devices.json    kiosks that have checked in
/data/uploads/        the logo
/data/session.key     cookie signing key (if SESSION_SECRET isn't set)
```

All small; Railway's Volume backups cover them.

## Project layout

```
server.js                 Reads config from environment variables and starts the app
lib/app.js                Express app: kiosk pages, public API, admin login and admin API, logo upload
lib/store.js              content.json: validation for tiles, groups, notes, schedules, PINs, appearance and settings
lib/stats.js              Tap counts and kiosk check-ins
lib/backup.js             Backup zip and restore
lib/links.js              Link clean-up; reads embed code; turns form share links into embed links
lib/formcheck.js          Asks the form's site whether it can be shown inside the hub (follows short links)
lib/auth.js               Admin session cookie, PIN unlock tokens, CSRF check, sign-in and PIN rate limiting
lib/qr.js                 QR code encoder (no dependencies)
public/                   Kiosk pages (index, open, qr) and shared CSS/JS; admin CSS/JS
views/                    Admin sign-in and admin pages
seed/content.json         Starter tiles, copied in on the very first start
test/                     Automated tests (node --test)
```

## Security notes

- The kiosk pages are public. The admin area needs `ADMIN_PASSWORD`; after 10 wrong tries from one address, sign-in is locked for 15 minutes.
- The admin cookie is HttpOnly and signed. Every change made through the API requires a custom header, which blocks cross-site request forgery.
- Tile PINs are stored hashed (scrypt). A locked tile's link is only sent after the right PIN, as a 15-minute signed token. This keeps casual users out; it is not a substitute for monday.com's own permissions on sensitive forms.
- The logo is served with a sandboxing Content-Security-Policy, and only image types are accepted. A restore only extracts the logo its content refers to.
- Pages send a Content-Security-Policy that allows only https pages to be embedded, and the hub can only be framed by itself (for the admin preview).
