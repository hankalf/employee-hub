# Employee Hub

A kiosk for warehouse employees, shown on an iPad or a computer screen, or opened on a phone by scanning a QR code. The kiosk page is a grid of big, glove-friendly tiles that open your **monday.com forms** (daily forklift check, tag-outs, PTO, gear requests…) inside the page. Notes beside the greeting carry announcements. An admin area sets up the tiles, notes, your logo and how the kiosk looks, in English and Spanish.

What's included:

- **Tiles** that open monday.com forms inside the page, optionally under **group headings** (Safety, Time off…).
- **Scheduled tiles** that only appear on certain days and times, such as the pre-shift check from 5 to 8 am.
- **Lead-only tiles** that ask for a PIN on a keypad before opening; the link stays hidden until the PIN is right.
- **Notes** beside the greeting, several at once, each with optional start and end dates so you can schedule them ahead.
- A **screensaver** after a few idle minutes: logo, clock, notes and a big QR code.
- **Tap counts** per tile for the last 7 and 30 days, a **chart by hour of day**, and a spreadsheet export.
- **Kiosk status**: every tablet checks in once a minute; the admin shows which are online, and can **alert you** (monday.com item or webhook) when one goes quiet.
- **Different tiles on different kiosks**: pick which groups each kiosk shows.
- **List and Zebra scanner layouts**: tools as a list instead of tiles, and a compact numbered list chosen automatically on Zebra handheld scanners.
- **Kiosk mode** on tablets and computers: the screen stays awake, and pinch-zoom, text selection and long-press menus are blocked. Kiosks **reload themselves** after an update.
- **"On your phone"**: a QR code on each form page so someone can finish a long form on their own phone.
- **Daily link checks** that warn you when a form stops working, and **nightly backups** (last 7 kept), plus backup and restore as a single zip.
- **Admin logins for each person**, with an **activity log** of who changed what; drag-and-drop ordering, **undo** after deleting, and uploaded images as tile icons.
- Your **logo** and **appearance** choices (theme, colours, card style, corners, font, tile size and columns), where the **hub name, greeting and intro line** sit, and a **clock** in the middle of the top bar.

- **Kiosk** (`/kiosk`): greeting, notes, and the tiles across the full width. Picks up admin changes within a minute, so it never needs reloading. The root address `/` redirects here, so the short address on the QR code works.
- **Form page** (`/open/t/…`): a tile's form inside the hub with a "Back to hub" button. After a period with no taps it returns home.
- **QR code** (`/qr`): a printable code that opens the hub on a phone. A small one is also in the top bar.
- **Admin** (`/admin`): *Tiles*, *Notes*, *Activity* and *Settings*. The owner signs in as `admin` with the `ADMIN_PASSWORD` service variable and can add a login for each person. Reached from the small *Admin* link at the bottom of the kiosk page.

Built with Node.js and Express. No database: settings and the logo live on a Railway Volume. No build step.

---

## Deploying on Railway

1. **Create the service.** In Railway, go to *New Project → Deploy from GitHub repo* and pick this repository. Railway detects Node and runs `npm start`; `railway.json` adds the health check and restart policy.
2. **Add a Volume.** Right-click the service → *Attach Volume* → mount path **`/data`**. Without it, your tiles, notes, settings, logo and tap counts are wiped on every redeploy.
3. **Set variables.** Service → *Variables*:

   | Variable | Required | What it does |
   |---|---|---|
   | `ADMIN_PASSWORD` | ✅ | The owner's password for the admin area at `/admin` (username `admin`, or leave the username blank). Changing it signs the owner out everywhere. |
   | `SESSION_SECRET` | optional | Random string used to sign the admin login cookie. Generated and kept on the Volume if empty. |
   | `PUBLIC_URL` | optional | The hub's public address, used for the QR code. Defaults to the address the page is opened on; you can also set it in *Settings*. |
   | `MONDAY_API_TOKEN` | optional | Only for alerts sent as items on a monday.com board (monday.com → your avatar → Developers → My access tokens). |
   | `FRAME_ANCESTORS` | optional | Sites allowed to show the hub inside a frame. Default: `https://monday.com https://*.monday.com https://*.monday.app`. Space- or comma-separated https addresses; `none` means only the hub itself. |

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
4. Give the tile an icon (pick an emoji, or **Upload image…** for your own picture, PNG/SVG/JPG/GIF/WebP up to 2 MB), a short description and, optionally, a corner label. Drag the ⠿ handle to order the tiles, or focus it and use the arrow keys.
5. Tiles without a link show as **Coming soon**. Switch a tile off to hide it entirely.

If a form shows a blank box on the kiosk, tap **Open full screen** at the top of the form page, then use **Check links** in the admin to see what monday.com reports for it.

Any web address works too: a Google Form, a SharePoint page, a monday board or dashboard (those need a monday login, so choose *Open in a new tab*).

Each tile row shows how many times it was tapped in the last 30 days; hover for the all-time total. Deleting a tile, note or group shows an **Undo** button for a few seconds.

Every night the server checks each form link again. If one stops working (deleted, sign-in required, or can't be shown inside the hub), the Tiles tab shows a warning and, with alerts on, you get an alert.

### Groups

*Admin → Tiles → Add group* creates a heading such as *Safety* or *Time off*. Choose a tile's group in the tile editor. Tiles without a group are shown first; drag a group's ⠿ handle to order the groups. Deleting a group keeps its tiles (and Undo puts them back in it).

### Schedules

In the tile editor, tick *Only show this tile at certain times*, pick the days and the time window. An end time earlier than the start runs overnight (22:00 to 06:00). The kiosk uses its own clock, so set the tablet's time zone correctly.

### Lead-only tiles

In the tile editor, tick *Ask for a PIN before opening* and enter 4 to 8 digits. The tile shows a lock and opens a keypad. The form link is never sent to the kiosk until the right PIN is entered, and then only for 15 minutes on that device. After 15 wrong PINs from one place, the keypad is locked for 15 minutes. Leave the PIN box blank when editing to keep the current PIN; untick the box to remove it.

### Notes

*Admin → Notes*: a title and text in English and Spanish, a style (info, important or good news) and optional *Show from* and *Show until* dates. Several notes can show at once, stacked in the order you set. Each row says whether it is showing now, scheduled or finished.

### Screensaver

*Settings → Kiosk → Screensaver after* (default 3 minutes; 0 turns it off). With no taps on the home screen for that long, the kiosk shows the logo, a large clock, the current notes and the QR code. The first tap only closes the screensaver, so nobody opens a form by accident.

### Kiosks

Every device showing the kiosk checks in once a minute. The admin header shows how many are online, and *Settings → Kiosks* lists each one with when it was last seen and what it is (iPad, Zebra TC52…). For each kiosk you can:

- give it a **name** (for example *Break room iPad*),
- choose which **tiles it shows**: *All tiles*, or only some groups (e.g. the dock iPad shows only Dock and Safety),
- choose its **layout**: *Automatic*, *Tiles*, *List* or *Scanner*,
- tick **Alert** to be told when it stops checking in.

Phones that scanned the QR code once drop off the list after 30 days. Changes reach the kiosk within a minute. The settings belong to the browser on that device: if its website data is cleared, it shows up as a new kiosk.

### Alerts

*Settings → Alerts*: tick *Send alerts*, choose how many quiet minutes count as offline (default 10), and where alerts go:

- **monday.com board**: paste the board's link. Each alert becomes a new item, with the details as an update. Needs `MONDAY_API_TOKEN` on Railway.
- **Webhook**: an https address that receives `{ "text", "subject", "detail", "hub", "at" }` as JSON. Slack and Microsoft Teams incoming webhooks show the `text`; Zapier or Make can turn it into an email or anything else. (The hub can't send email itself: Railway blocks outgoing mail on most plans.)

Alerts are sent once when a kiosk goes quiet, optionally again when it's back, and when the daily link check finds a form that stopped working. **Send a test alert** checks the setup. The webhook address and board are never sent to the kiosk.

### List and Zebra scanner layouts

*Appearance → Tools shown as* switches every kiosk between **tiles** and a **list** of rows (icon, title, description). In the list, each tool has a number and pressing keys 1–9 opens it.

**Zebra handheld scanners** (TC2x, TC5x, TC7x, MC33, MC93, EC5x, ET4x and others) are detected automatically and get the **scanner layout**: a compact numbered list sized for a 4–6" screen, with a slim top bar, no screensaver and no "On your phone" button. Number keys 1–9 open a tool on keypad models. Detection reads the device model from the browser; if it misses on your setup (some browsers hide the model), set that kiosk's layout to *Scanner* under *Kiosks*, or open `https://<your-domain>/kiosk?layout=scanner` once on the device (`?layout=auto` undoes it). To turn detection off: *Settings → Kiosk → Zebra scanners*.

### Kiosk mode, updates and "On your phone"

- **Lockdown** (*Settings → Kiosk → Kiosk lockdown*): on tablets and computers, the kiosk keeps the screen awake and blocks pinch-zoom, double-tap zoom, text selection and long-press menus. Phones are left alone so people can zoom forms. You can limit it to kiosks you've named, or turn it off. iPads still need *Auto-Lock: Never* and Guided Access for a true kiosk.
- **Updates**: after a new version is deployed, kiosks reload themselves within a minute; nobody needs to touch them.
- **On your phone** (*Settings → Kiosk*): form pages show a button with a QR code of that form, so someone can finish it on their own phone. Never shown for PIN-protected tiles.

### Activity

*Admin → Activity* shows taps by hour of day for the last 30 days (all tiles or one), a table of taps per tile, and the **admin activity log**: every sign-in, failed sign-in and change, with who did it. Both download as spreadsheets (CSV).

### Admins

The **owner** signs in with username `admin` and `ADMIN_PASSWORD`. Under *Settings → Admins*, the owner adds a login for each person: they get a temporary password, shown once, and choose their own at first sign-in. Admins can change everything except other admins and restoring backups. The owner can switch an admin off (signs them out at once), give them a new temporary password, or remove them; their past activity stays in the log.

### Logo and appearance

*Admin → Settings → Logo*: upload a PNG, SVG, JPG, GIF or WebP (max 2 MB). It replaces the accent pill in the top bar of the kiosk, on the screensaver, on the QR page and in the admin area.

*Admin → Settings → Appearance*: theme (follow the device, always light or always dark), spectrum or solid accent colour, optional background colour, card style (frosted, solid or outline), corner roundness, font, tile size, tiles per row, and whether to show the corner labels and the date. A live preview of the kiosk sits under the form and updates when you save.

**Layout** (same section) decides where the header pieces go:

| Setting | Choices |
|---|---|
| Hub name | In the top bar next to the logo · Large, above the greeting · Hidden |
| Greeting and greeting word | "Good morning, team." · "Team, good morning." · "Good morning." · No greeting |
| Intro line | Below the greeting · Above the greeting · Under the tiles · Hidden |
| Alignment | Left, with notes on the right · Centred, with notes underneath |

With *No greeting* and the hub name *Large, above the greeting*, the hub name becomes the main heading.

**Top bar clock**: a digital clock in the middle of the top bar, 12-hour (`07:44`) or 24-hour (`19:44`), with AM/PM optional, or off. It uses each kiosk's own clock, and the screensaver clock follows the same 12/24-hour choice. On phones the clock moves next to the logo and the "Open on your phone" QR is hidden.

### Backup and restore

A backup is a zip with every tile, group, note and setting, the logo and tile images, tap counts, the kiosk list and admin logins (passwords stored scrambled, never in plain text). **One is made automatically every night and the last 7 are kept** on the server, listed under *Settings → Backup and restore* with Download and (for the owner) Restore. *Make a backup now* replaces today's. *Download a backup* gives you a fresh zip to keep elsewhere, and the owner can restore from a file. Restoring replaces everything; the content from just before is kept on the server as `before-restore-<date>.json` (the last two). Railway's own Volume backups are worth turning on too.

### Spanish

Every title and description has an English and a Spanish box; Spanish falls back to English when empty. The kiosk shows an EN / ES switch, which you can turn off in *Settings* for English only.

### Showing the hub inside monday.com

The hub can be shown inside monday.com, for example as an embedded website view on a board, a dashboard widget, or inside a monday app hosted on `*.monday.app`. Use the kiosk address, `https://<your-domain>/kiosk`. By default, framing is allowed from `monday.com`, any `*.monday.com` address and any `*.monday.app` address; change the list with the `FRAME_ANCESTORS` variable.

Inside a monday frame, forms still open inside the hub. A form that refuses to be framed opens in a new browser tab instead. The admin area also works inside the frame, but browsers that block third-party cookies (Safari, or Chrome with that setting on) won't keep you signed in there: open `https://<your-domain>/admin` in its own tab instead.

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
/data/content.json    tiles, groups, notes, appearance, settings (and recently deleted items, for Undo)
/data/stats.json      tap counts per tile, by day and hour (last 90 days)
/data/devices.json    kiosks that have checked in, their names, tile sets, layouts and alerts
/data/admins.json     admin logins (passwords hashed with scrypt)
/data/activity.log    admin activity log (rotates at 5 MB)
/data/backups/        automatic nightly backups (last 7)
/data/uploads/        the logo and tile images
/data/session.key     cookie signing key (if SESSION_SECRET isn't set)
```

All small; Railway's Volume backups cover them.

## Project layout

```
server.js                 Reads config from environment variables and starts the app
lib/app.js                Express app: kiosk pages, public API, admin login and admin API, logo upload
lib/store.js              content.json: validation for tiles, groups, notes, schedules, PINs, appearance and settings
lib/stats.js              Tap counts and kiosk check-ins
lib/admins.js             Admin logins (owner from ADMIN_PASSWORD, named admins in admins.json)
lib/audit.js              Activity log and CSV export
lib/alerts.js             Alerts to a monday.com board and/or a webhook
lib/backup.js             Backup zip, restore, and the nightly automatic backups
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

- The kiosk pages are public. The admin area needs a login: the owner's `ADMIN_PASSWORD`, or a named admin's own password (hashed with scrypt). After 10 wrong tries from one address or for one username, sign-in is locked for 15 minutes. Changing a password or switching an admin off signs that account out everywhere.
- The activity log records sign-ins, failed sign-ins and every change, with who made it.
- The admin cookie is HttpOnly and signed. Every change made through the API requires a custom header, which blocks cross-site request forgery.
- Alert settings (webhook address, board) and PIN-protected tiles' links never reach the kiosk.
- Tile PINs are stored hashed (scrypt). A locked tile's link is only sent after the right PIN, as a 15-minute signed token. This keeps casual users out; it is not a substitute for monday.com's own permissions on sensitive forms.
- The logo is served with a sandboxing Content-Security-Policy, and only image types are accepted. A restore only extracts the logo its content refers to.
- Pages send a Content-Security-Policy that allows only https pages to be embedded in the hub, and lets only the hub itself and the sites in `FRAME_ANCESTORS` (monday.com and monday.app by default) show the hub in a frame.
- Over HTTPS the admin cookie is `SameSite=None; Secure; Partitioned` so signing in works inside a monday.com frame; a frame's cookie is kept separate from the hub's own tab. Every change still needs the custom request header, so other sites can't make changes on an admin's behalf.
