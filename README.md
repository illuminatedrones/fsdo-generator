# FSDO Notification Generator

An internal web app for Illuminate Drones employees to send drone-light-show
notifications to the correct FAA Flight Standards District Office (FSDO) —
**no login required for the person using it.**

The employee picks the show location on a map (or types coordinates / searches
an address), sets the dates & times, uploads the exclusion-zone screenshot, and
the app:

- figures out the **nearest FSDO** and pre-fills its email,
- builds the notification email,
- shows a **review screen** so they can confirm everything,
- and on **Send** mails it from **orders@illuminatedrones.com** with the
  standard **waiver / CoW / flight-plan zip** *and* the uploaded exclusion-zone
  image attached, **CC**ing josh@ and jacob@.

The page is gated by a **team PIN**.

**Live site:** https://illuminatedrones.github.io/fsdo-generator/

---

## How it's built (and why)

GitHub Pages is **static** — it can't send email or hold a credential. And we
need the page to work for anyone with no Google login. So a tiny always-on
**Cloudflare Worker** sits between the public page and Gmail, holding the secret:

```
  Employee's browser              Cloudflare Worker                 Gmail API        FAA
  (GitHub Pages, static)          (fsdo-mailer, holds creds)
 ┌────────────────────┐  POST    ┌──────────────────────┐  send as  ┌─────────┐    ┌──────┐
 │ index.html / app.js│ ───────▶ │ worker.js            │ ────────▶ │ orders@ │ ─▶ │ FSDO │
 │  map, form, PIN,   │  show +  │  • checks PIN + rate │  + CC     └─────────┘    └──────┘
 │  review screen     │◀──────── │  • pulls waiver zip  │
 └────────────────────┘ {ok:true}│    from orders@ Drive│
                                 │  • builds + sends    │
                                 └──────────────────────┘
```

- **Frontend** = this folder (minus `cloudflare-worker/`), served by GitHub Pages.
- **Backend** = [`cloudflare-worker/worker.js`](cloudflare-worker/worker.js), a
  Cloudflare Worker. It sends through the **Gmail API as orders@** using a
  long-lived OAuth refresh token, and attaches the **waiver zip straight from
  orders@'s Google Drive** (so the big file is never re-uploaded or made public).

### What's already set up

Everything below is **already deployed and working** — this section is reference
for maintenance, not steps you need to run again.

- **Google Cloud project** `fsdo-mailer` (under orders@) with the Gmail API +
  Drive API enabled, an internal OAuth client ("Desktop client 1"), and a
  refresh token for **orders@** scoped to `gmail.send` + `drive.readonly`.
- **Cloudflare Worker** `fsdo-mailer` at
  `https://fsdo-mailer.illuminatedrones.workers.dev`, with:
  - **Vars** (in `wrangler.toml`): `SENDER`, `SENDER_NAME`, `WAIVER_FILE_ID`,
    `FORCE_CC`.
  - **Secrets** (set with `wrangler secret put`, stored in Cloudflare — never in
    the repo): `TEAM_PIN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
    `GOOGLE_REFRESH_TOKEN`.
  - **KV namespace** `RATE_KV` for the PIN tarpit + hourly send cap.
- **The waiver zip** lives in **orders@'s Google Drive** (file id in
  `wrangler.toml` → `WAIVER_FILE_ID`).

---

## Using it (employees)

1. Open https://illuminatedrones.github.io/fsdo-generator/ and enter the PIN.
2. Type your name (so we can see who sent it).
3. Set the show location — pick a **saved spot**, click the map, paste
   coordinates, or search a US address. **Saved spots** are shared across the
   whole team (stored in the Worker's KV): set a location and click **★ Save** to
   name it; anyone on the team can then find it in the "Saved spots" box.
4. Set start/end dates, start/end times, and max altitude.
5. Upload the exclusion-zone / geofence screenshot.
6. Confirm the **Nearest FSDO** (its email is editable if needed).
7. Click **Review email →**, check everything, then **Send to FSDO**.

---

## Maintenance

All Worker commands run from the `cloudflare-worker/` folder. You must be logged
in once: `npx wrangler login`.

**Change the PIN** (two places — they must match):
1. `npx wrangler secret put TEAM_PIN` → type the new PIN.
2. Open [`pin-hash.html`](pin-hash.html), type the same PIN, copy the SHA-256,
   and paste it into [`config.js`](config.js) → `PIN_SHA256`. Commit & push.

**Update the waiver packet:** replace the file in orders@'s Drive (keep the same
file id), or upload a new one and set `WAIVER_FILE_ID` in `wrangler.toml`, then
`npx wrangler deploy`.

**Change who's CC'd:** edit `FORCE_CC` in `wrangler.toml`, then
`npx wrangler deploy`. (Also update `CC` in `config.js` so the review screen
shows it.)

**Fix / add an FSDO email:** edit [`fsdo_offices.json`](fsdo_offices.json). Each
office has `email` and `email_status` (`verified` / `unverified`). Offices
marked unverified show a warning on the page so the sender double-checks.

**Redeploy the Worker after code changes:** `npx wrangler deploy`.

**Rotate the Google refresh token** (if it's ever revoked): re-run the OAuth
consent for orders@ on the `fsdo-mailer` OAuth client to mint a new refresh
token, then `npx wrangler secret put GOOGLE_REFRESH_TOKEN`.

---

## Local testing

Double-click **`Open FSDO Generator (local test).command`**. It serves this
folder at `http://localhost:8765` and opens it. (A real server is required —
the app `fetch`es `fsdo_offices.json`, which browsers block on `file://`.)
The live Worker backend is used either way, so **Send** really sends.

---

## Security notes — please read

This is an **internal-team tool**, secured to a deterrent level appropriate for
that:

- The site is publicly reachable (GitHub Pages always is) and the backend Worker
  accepts anonymous requests (that's what makes "no login" possible). The
  **PIN** is the gate. Because the PIN is short (`1711`), the Worker also
  **rate-limits**: it tarpits wrong-PIN attempts and caps sends to **20/hour** to
  bound abuse if someone guesses it. The PIN only appears in the repo as a SHA-256
  hash, and the real PIN is checked server-side in the Worker.
- **Anyone with the PIN can send** as orders@. If it leaks, rotate it (above).
- "Nearest FSDO" is **nearest office by distance** — a good proxy for FAA
  jurisdiction, but the review screen lets the sender correct the recipient.
  **The sender is responsible for confirming the right office.**
- Gmail caps total attachments at **25 MB**. The waiver zip is ~16 MB, so keep
  exclusion-zone screenshots under ~8 MB.
- **Possible hardening** (not enabled): restrict the Worker to the GitHub Pages
  `Origin`, or move to a longer PIN, for stronger protection against abuse.
