/* =====================================================================
   FSDO Notification Generator — CONFIG
   ---------------------------------------------------------------------
   Fill these in once, then commit. See README.md for step-by-step setup.
   ===================================================================== */
window.FSDO_CONFIG = {

  /* The Cloudflare Worker URL that actually sends the email (it holds the
     orders@ Gmail credential, pulls the waiver zip from Drive, and sends).
     Deployed from cloudflare-worker/. See README.md.                       */
  BACKEND_URL: "https://fsdo-mailer.illuminatedrones.workers.dev",

  /* SHA-256 hash of the team PIN that unlocks the site.
     Generate it by opening pin-hash.html in a browser and typing your PIN.
     (Storing the hash — not the PIN — keeps the PIN out of the page source.)
     The PIN itself is ALSO checked server-side by the Apps Script.          */
  PIN_SHA256: "3d80025e7a475d44dde1e42dff074c1b20338642e295bbd9160cfb03918223c0",

  /* Who gets CC'd on every notification. */
  CC: ["jacob@illuminatedrones.com"],

  /* Shown in the "From" line of the review screen (cosmetic — the real
     send identity is whatever the Apps Script is configured to send as). */
  FROM_LABEL: "Illuminate Drones Orders <orders@illuminatedrones.com>",

  /* Default max altitude that pre-fills the form (ft AGL). */
  DEFAULT_ALT_FT: 400,

  /* Filename shown for the standard waiver packet (the 16 MB zip the
     Apps Script attaches from Google Drive). Cosmetic label only.        */
  WAIVER_ZIP_LABEL: "Illuminate Drones — Waiver, CoW & Flight Plan.zip",

  /* Map default view (used before a location is chosen). */
  MAP_DEFAULT: { lat: 39.5, lon: -98.35, zoom: 4 }
};
