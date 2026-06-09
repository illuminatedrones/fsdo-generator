/* =====================================================================
   FSDO Notification Generator — Google Apps Script backend
   ---------------------------------------------------------------------
   This is the ONLY part that can actually send email. GitHub Pages is
   static and cannot. The web page POSTs the form data here; this script
   sends the email from orders@illuminatedrones.com with the standard
   waiver zip + the uploaded exclusion-zone image attached.

   ONE-TIME SETUP (see README.md for the full walkthrough):
     1. Create a new Apps Script project at https://script.google.com
     2. Paste this file in as Code.gs
     3. Fill in the CONFIG block below
     4. Deploy → New deployment → type "Web app"
          - Execute as:  the account that can send as orders@ (usually orders@ itself)
          - Who has access:  Anyone
     5. Copy the /exec URL into config.js (APPS_SCRIPT_URL)
   ===================================================================== */

/* ============================ CONFIG ============================ */
const CONFIG = {
  // The PIN your team types to unlock the site. Checked here too, so the
  // send endpoint can't be used without it. MUST match the PIN whose
  // SHA-256 you put in config.js (PIN_SHA256).
  TEAM_PIN: "CHANGE_ME",

  // The address the email is sent FROM. Must be a verified "Send mail as"
  // alias on the account running this script (or this account itself).
  SENDER: "orders@illuminatedrones.com",
  SENDER_NAME: "Illuminate Drones",

  // Google Drive file ID of the standard waiver/CoW/flight-plan ZIP that
  // gets attached to every email. Upload the zip to Drive, then copy the
  // ID from its share link:  drive.google.com/file/d/<THIS_PART>/view
  WAIVER_FILE_ID: "PASTE_DRIVE_FILE_ID_OF_THE_WAIVER_ZIP",

  // Always-CC these (the page also sends them, but we enforce here too).
  FORCE_CC: ["josh@illuminatedrones.com", "jacob@illuminatedrones.com"],

  // Optional: a Google Sheet ID to log every send (audit trail of who sent
  // what, when, and to which FSDO). Leave "" to disable.
  LOG_SHEET_ID: ""
};

// Abuse protection (the team PIN is short, and the web-app URL is public).
const RATE = {
  MAX_SENDS_PER_HOUR: 20,           // hard cap on emails per hour — limits spam blast radius
  MAX_BAD_PIN: 8,                   // failed PINs in the window before the slowdown escalates
  BAD_WINDOW_MS: 15 * 60 * 1000     // 15-minute rolling window for failed attempts
};
/* ================================================================ */


function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return json({ ok: false, error: "No data received." });
    }
    const req = JSON.parse(e.postData.contents);

    // --- auth + rate limiting ---
    const pinOk = String(req.pin || "") === String(CONFIG.TEAM_PIN);
    const gate = rateGate_(pinOk);
    if (!gate.ok) return json({ ok: false, error: gate.error });

    // --- validate ---
    const to = String(req.to || "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      return json({ ok: false, error: "Invalid recipient email." });
    }
    if (!req.subject || !req.body) {
      return json({ ok: false, error: "Missing subject or body." });
    }
    if (!req.image || !req.image.dataBase64) {
      return json({ ok: false, error: "Missing exclusion-zone image." });
    }

    // --- build attachments ---
    const attachments = [];

    // 1) standard waiver zip from Drive
    if (CONFIG.WAIVER_FILE_ID && CONFIG.WAIVER_FILE_ID.indexOf("PASTE") !== 0) {
      attachments.push(DriveApp.getFileById(CONFIG.WAIVER_FILE_ID).getBlob());
    }

    // 2) uploaded exclusion-zone image
    const img = req.image;
    attachments.push(
      Utilities.newBlob(Utilities.base64Decode(img.dataBase64),
        img.mimeType || "image/png",
        img.name || "exclusion-zone.png")
    );

    // --- recipients: merge page CC with enforced CC, dedupe ---
    const ccSet = {};
    [].concat(req.cc || [], CONFIG.FORCE_CC).forEach(function (a) {
      a = String(a || "").trim().toLowerCase();
      if (a && a !== to.toLowerCase()) ccSet[a] = true;
    });
    const cc = Object.keys(ccSet).join(",");

    // --- send ---
    GmailApp.sendEmail(to, req.subject, req.body, {
      from: CONFIG.SENDER,
      name: CONFIG.SENDER_NAME,
      cc: cc,
      attachments: attachments,
      replyTo: CONFIG.SENDER
    });

    recordSend_();
    logSend_(req, to, cc);
    return json({ ok: true, to: to, cc: cc });

  } catch (err) {
    return json({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

// Simple health check in a browser.
function doGet() {
  return json({ ok: true, service: "FSDO Notification Generator", status: "running" });
}

function logSend_(req, to, cc) {
  if (!CONFIG.LOG_SHEET_ID) return;
  try {
    const sh = SpreadsheetApp.openById(CONFIG.LOG_SHEET_ID).getSheets()[0];
    const m = req.meta || {};
    sh.appendRow([new Date(), req.senderName || "", to, cc,
      m.lat || "", m.lon || "", m.address || "", req.subject || ""]);
  } catch (err) {
    // logging is best-effort; never block a send
    console.warn("log failed: " + err);
  }
}

/* ---- abuse protection ----------------------------------------------
   The web-app URL is public and the PIN is short, so we (a) tarpit wrong
   PINs to slow brute-forcing and (b) cap total sends per hour to limit the
   damage if someone does guess it. State lives in Script Properties; a
   script lock serializes attempts so they can't be parallelized.        */
function rateGate_(pinOk) {
  const lock = LockService.getScriptLock();
  try { lock.waitLock(15000); } catch (e) { return { ok: false, error: "Server busy — try again." }; }
  try {
    const now = new Date().getTime();
    const props = PropertiesService.getScriptProperties();

    if (!pinOk) {
      const bad = JSON.parse(props.getProperty("badPin") || "[]")
        .filter(function (t) { return now - t < RATE.BAD_WINDOW_MS; });
      bad.push(now);
      props.setProperty("badPin", JSON.stringify(bad));
      // escalating delay: every failed attempt waits, longer once over the threshold
      Utilities.sleep(bad.length > RATE.MAX_BAD_PIN ? 6000 : 1500);
      return { ok: false, error: "Unauthorized (bad PIN)." };
    }

    const sends = JSON.parse(props.getProperty("sendTimes") || "[]")
      .filter(function (t) { return now - t < 3600000; });
    if (sends.length >= RATE.MAX_SENDS_PER_HOUR) {
      return { ok: false, error: "Hourly send limit reached (" + RATE.MAX_SENDS_PER_HOUR + "). Try again later." };
    }
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

function recordSend_() {
  const lock = LockService.getScriptLock();
  try { lock.waitLock(15000); } catch (e) { return; }
  try {
    const now = new Date().getTime();
    const props = PropertiesService.getScriptProperties();
    const sends = JSON.parse(props.getProperty("sendTimes") || "[]")
      .filter(function (t) { return now - t < 3600000; });
    sends.push(now);
    props.setProperty("sendTimes", JSON.stringify(sends));
  } finally {
    lock.releaseLock();
  }
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
