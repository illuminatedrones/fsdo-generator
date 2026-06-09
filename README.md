# FSDO Notification Generator

An internal web app for Illuminate Drones employees to send drone-light-show
notifications to the correct FAA Flight Standards District Office (FSDO).

The employee picks the show location on a map (or types coordinates / searches
an address), sets the dates & times, uploads the exclusion-zone screenshot, and
the app:

- figures out the **nearest FSDO** and pre-fills its email,
- builds the notification email,
- shows a **review screen** so they can confirm everything,
- and on **Send** mails it from **orders@illuminatedrones.com** with the
  standard **waiver / CoW / flight-plan zip** *and* the uploaded exclusion-zone
  image attached, **CC**ing josh@ and jacob@.

The page is locked behind a **team PIN**.

---

## How it's built (and why)

GitHub Pages is **static** — it can't send email or attach files on its own,
and the waiver zip (~16 MB) is far too big for client-only email widgets. So:

```
  Employee's browser                     Google Apps Script              FAA
  (GitHub Pages, static)                 (runs as orders@)
 ┌────────────────────┐   POST (JSON)   ┌────────────────────┐  email   ┌──────────┐
 │ index.html / app.js│ ───────────────▶│ Code.gs (doPost)   │ ───────▶ │  FSDO    │
 │  map, form, PIN,   │   show + image  │  • checks PIN       │  + CC    │  inbox   │
 │  review screen     │◀─────────────── │  • attaches zip     │          └──────────┘
 └────────────────────┘   {ok:true}     │    (from Drive)     │
                                         │  • attaches image   │
                                         │  • sends from       │
                                         │    orders@          │
                                         └────────────────────┘
```

- **Frontend** = this folder, served by GitHub Pages.
- **Backend** = `apps-script/Code.gs`, a tiny Google Apps Script web app that
  sends the mail. The big waiver zip lives in **Google Drive** (not the repo),
  so it isn't re-uploaded on every send.

---

## One-time setup

### 1. Put the waiver zip in Google Drive
1. Sign in to Drive as **orders@illuminatedrones.com** (or whoever will run the
   script).
2. Upload the waiver zip (the `Mid 2026 Merged Waiver …zip` in this folder).
3. Right-click it → **Share** → make sure the running account can read it.
4. Open it and copy the file ID from the URL:
   `https://drive.google.com/file/d/`**`THIS_LONG_ID`**`/view`

### 2. Make sure orders@ is a "Send mail as" address
The script sends *from* `orders@illuminatedrones.com`. The Google account that
runs the script must be allowed to send as that address:
- If you run the script **as orders@ itself**, you're done.
- Otherwise, in that account's Gmail → **Settings → Accounts → "Send mail as"**,
  add and verify `orders@illuminatedrones.com`.

### 3. Deploy the Apps Script backend
1. Go to <https://script.google.com> → **New project**.
2. Delete the placeholder code, paste in everything from
   [`apps-script/Code.gs`](apps-script/Code.gs).
3. Edit the **CONFIG** block at the top:
   - `TEAM_PIN` — the PIN your team will type (e.g. `drone2026`).
   - `WAIVER_FILE_ID` — the Drive file ID from step 1.
   - `SENDER` — leave as `orders@illuminatedrones.com`.
   - `LOG_SHEET_ID` — optional; a Google Sheet ID to log every send.
4. **Deploy → New deployment** → gear icon → **Web app**:
   - **Execute as:** the account that can send as orders@.
   - **Who has access:** **Anyone**.  *(Required — the public page must be able
     to reach it. The PIN is what actually protects sending.)*
5. Click **Deploy**, approve the permissions prompt (it needs Gmail + Drive).
6. Copy the **Web app URL** (ends in `/exec`).

> Test it: paste the `/exec` URL in a browser. You should see
> `{"ok":true,"service":"FSDO Notification Generator","status":"running"}`.

### 4. Set the PIN hash
1. Open [`pin-hash.html`](pin-hash.html) in any browser (double-click works).
2. Type the **same PIN** you put in `TEAM_PIN`.
3. Copy the SHA-256 hash it shows.

### 5. Fill in `config.js`
Open [`config.js`](config.js) and set:
- `APPS_SCRIPT_URL` — the `/exec` URL from step 3.
- `PIN_SHA256` — the hash from step 4.
- `CC`, `FROM_LABEL` — already set; change if needed.

### 6. Publish to GitHub Pages
1. Create a repo (e.g. `illuminatedrones/fsdo-generator`) and push this folder.
   You do **not** need to commit the 16 MB zip — it lives in Drive now.
2. Repo **Settings → Pages → Build from branch → `main` / root**.
3. Your app is live at
   `https://illuminatedrones.github.io/fsdo-generator/`.

Done. Share the URL + PIN with employees.

---

## Using it (employees)

1. Open the URL, enter the PIN.
2. Type your name (so we can see who sent it).
3. Set the show location — click the map, paste coordinates, or search an address.
4. Set start/end dates, start/end times, and max altitude.
5. Upload the exclusion-zone / geofence screenshot.
6. Confirm the **Nearest FSDO** (its email is editable if needed).
7. Click **Review email →**, check everything, then **Send to FSDO**.

---

## Local testing

Double-click **`Open FSDO Generator (local test).command`**. It serves this
folder at `http://localhost:8765` and opens it. (A real server is required —
the app `fetch`es `fsdo_offices.json`, which browsers block on `file://`.)

While testing, you can unlock with any PIN until you set `PIN_SHA256`, and
**Send** will report that the backend isn't configured until you set
`APPS_SCRIPT_URL`.

---

## Maintaining the data

- **Update the waiver packet:** replace the file in Drive (keep the same file
  ID) or upload a new one and update `WAIVER_FILE_ID` in `Code.gs`.
- **Fix / add an FSDO email:** edit `fsdo_offices.json`. Each office has
  `email` and `email_status` (`verified` / `unverified`). Offices marked
  unverified show a warning on the page so the sender double-checks before
  sending.
- **Change the PIN:** regenerate the hash (step 4), update `PIN_SHA256` in
  `config.js` **and** `TEAM_PIN` in `Code.gs`.

---

## Security notes — please read

This is an **internal-team deterrent**, not bank-grade security:

- The site is publicly reachable (GitHub Pages always is). The **PIN** keeps
  casual visitors out, and the Apps Script **re-checks the PIN** so the send
  endpoint can't be used without it. Only the PIN's *hash* is in the page
  source — pick a non-trivial PIN (8+ characters) and the hash can't be
  reversed.
- Anyone with the PIN can send. Rotate it if it leaks (one-line change above).
- "Nearest FSDO" is **nearest office by distance** — a good proxy for FAA
  jurisdiction, but boundaries aren't strictly circular. The review screen lets
  the sender correct the recipient before anything goes out. **The sender is
  responsible for confirming the right office.**
- Gmail caps total attachments at **25 MB**. The waiver zip is ~16 MB, so keep
  exclusion-zone screenshots reasonably sized (under ~8 MB).
