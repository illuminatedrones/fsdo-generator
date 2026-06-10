/* =====================================================================
   FSDO Notification relay — Cloudflare Worker
   ---------------------------------------------------------------------
   The public GitHub Pages page can't hold credentials, so it POSTs the
   form here. This Worker holds the secret, sends the email from
   orders@illuminatedrones.com via the Gmail API, and attaches:
     • the standard waiver zip (pulled from orders@ Google Drive), and
     • the uploaded exclusion-zone image (sent in the POST).

   Secrets (set with `wrangler secret put <NAME>`):
     TEAM_PIN, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
   Plain vars (wrangler.toml [vars]):
     SENDER, SENDER_NAME, WAIVER_FILE_ID, FORCE_CC
   Binding:
     RATE_KV  (KV namespace, for PIN tarpit + hourly send cap)
   ===================================================================== */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400"
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (request.method === "GET") return json({ ok: true, service: "FSDO Notification relay", status: "running" });
    if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

    try {
      const req = await request.json();

      // --- auth + rate limiting ---
      const pinOk = String(req.pin || "") === String(env.TEAM_PIN);
      const gate = await rateGate(env, pinOk);
      if (!gate.ok) return json({ ok: false, error: gate.error });

      // --- validate ---
      const to = String(req.to || "").trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return json({ ok: false, error: "Invalid recipient email." });
      if (!req.subject || !req.body) return json({ ok: false, error: "Missing subject or body." });
      if (!req.image || !req.image.dataBase64) return json({ ok: false, error: "Missing exclusion-zone image." });

      // --- google access token (from the orders@ refresh token) ---
      const accessToken = await getAccessToken(env);

      // --- pull the standard waiver zip from Drive ---
      const attachments = [];
      if (env.WAIVER_FILE_ID) {
        const dr = await fetch(
          `https://www.googleapis.com/drive/v3/files/${env.WAIVER_FILE_ID}?alt=media&supportsAllDrives=true`,
          { headers: { Authorization: "Bearer " + accessToken } }
        );
        if (!dr.ok) return json({ ok: false, error: "Could not fetch waiver zip from Drive (" + dr.status + ")." });
        const bytes = new Uint8Array(await dr.arrayBuffer());
        attachments.push({
          filename: env.WAIVER_NAME || "Illuminate Drones - Waiver, CoW & Flight Plan.zip",
          mime: "application/zip",
          b64: base64FromBytes(bytes)
        });
      }

      // --- uploaded exclusion-zone image ---
      attachments.push({
        filename: req.image.name || "exclusion-zone.png",
        mime: req.image.mimeType || "image/png",
        b64: req.image.dataBase64
      });

      // --- recipients: merge page CC with enforced CC, dedupe ---
      const forceCc = String(env.FORCE_CC || "").split(",").map((s) => s.trim()).filter(Boolean);
      const ccSet = {};
      [].concat(req.cc || [], forceCc).forEach((a) => {
        a = String(a || "").trim().toLowerCase();
        if (a && a !== to.toLowerCase()) ccSet[a] = true;
      });
      const cc = Object.keys(ccSet).join(", ");

      // --- build the raw RFC-822 message ---
      const mime = buildMime({
        fromName: env.SENDER_NAME || "Illuminate Drones",
        from: env.SENDER || "orders@illuminatedrones.com",
        to, cc, subject: req.subject, body: req.body, attachments
      });

      // --- send via Gmail API (media upload supports large messages) ---
      const send = await fetch(
        "https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media",
        { method: "POST", headers: { Authorization: "Bearer " + accessToken, "Content-Type": "message/rfc822" }, body: mime }
      );
      if (!send.ok) {
        const t = await send.text();
        return json({ ok: false, error: "Gmail send failed (" + send.status + "): " + t.slice(0, 300) });
      }

      await recordSend(env);
      return json({ ok: true, to, cc });
    } catch (err) {
      return json({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  }
};

/* ---------- helpers ---------- */
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...CORS } });
}

async function getAccessToken(env) {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token"
    })
  });
  const j = await r.json();
  if (!j.access_token) throw new Error("token refresh failed: " + JSON.stringify(j).slice(0, 200));
  return j.access_token;
}

function base64FromBytes(bytes) {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}
function b64utf8(str) { return base64FromBytes(new TextEncoder().encode(str)); }
function wrap76(b64) { return b64.replace(/.{76}/g, "$&\r\n"); }
function rfc2047(str) { return /[^\x00-\x7F]/.test(str) ? "=?UTF-8?B?" + b64utf8(str) + "?=" : str; }

function buildMime({ fromName, from, to, cc, subject, body, attachments }) {
  const boundary = "fsdo_" + Math.random().toString(36).slice(2) + "_b";
  const NL = "\r\n";
  let m = "";
  m += `From: ${fromName} <${from}>` + NL;
  m += `To: ${to}` + NL;
  if (cc) m += `Cc: ${cc}` + NL;
  m += `Subject: ${rfc2047(subject)}` + NL;
  m += `MIME-Version: 1.0` + NL;
  m += `Content-Type: multipart/mixed; boundary="${boundary}"` + NL + NL;

  m += `--${boundary}` + NL;
  m += `Content-Type: text/plain; charset="UTF-8"` + NL;
  m += `Content-Transfer-Encoding: base64` + NL + NL;
  m += wrap76(b64utf8(body)) + NL + NL;

  for (const a of attachments) {
    m += `--${boundary}` + NL;
    m += `Content-Type: ${a.mime}; name="${a.filename}"` + NL;
    m += `Content-Disposition: attachment; filename="${a.filename}"` + NL;
    m += `Content-Transfer-Encoding: base64` + NL + NL;
    m += wrap76(a.b64) + NL + NL;
  }
  m += `--${boundary}--` + NL;
  return m;
}

/* ---------- abuse protection (PIN tarpit + hourly send cap), state in KV ---------- */
async function rateGate(env, pinOk) {
  if (!env.RATE_KV) { // no KV bound: still enforce PIN, just no throttle state
    if (pinOk) return { ok: true };
    await sleep(1500);
    return { ok: false, error: "Unauthorized (bad PIN)." };
  }
  const now = Date.now();
  if (!pinOk) {
    const bad = JSON.parse((await env.RATE_KV.get("badPin")) || "[]").filter((t) => now - t < 15 * 60 * 1000);
    bad.push(now);
    await env.RATE_KV.put("badPin", JSON.stringify(bad), { expirationTtl: 3600 });
    await sleep(bad.length > 8 ? 5000 : 1500);
    return { ok: false, error: "Unauthorized (bad PIN)." };
  }
  const sends = JSON.parse((await env.RATE_KV.get("sendTimes")) || "[]").filter((t) => now - t < 3600 * 1000);
  if (sends.length >= 20) return { ok: false, error: "Hourly send limit reached (20). Try again later." };
  return { ok: true };
}
async function recordSend(env) {
  if (!env.RATE_KV) return;
  const now = Date.now();
  const sends = JSON.parse((await env.RATE_KV.get("sendTimes")) || "[]").filter((t) => now - t < 3600 * 1000);
  sends.push(now);
  await env.RATE_KV.put("sendTimes", JSON.stringify(sends), { expirationTtl: 3600 });
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
