// Owner Tools report form (/tools/) → Blanket Owner Leads (New). Replaces the old
// client-side Aptly call, so no API key is exposed in the page.
// Uses the same BLANKET_LEAD_URL env var as submit.js.
exports.handler = async function (event) {
  const headers = { "Content-Type": "application/json" };

  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };

  let payload;
  try { payload = JSON.parse(event.body || "{}"); }
  catch (e) { return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON" }) }; }

  const name    = String(payload.name    || "").trim().slice(0, 120);
  const email   = String(payload.email   || "").trim().slice(0, 200);
  const summary = String(payload.summary || "").trim().slice(0, 2000);

  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Name and a valid email are required" }) };
  }

  const blanketUrl = process.env.BLANKET_LEAD_URL;
  if (!blanketUrl) {
    console.error("Missing BLANKET_LEAD_URL env var");
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Server misconfigured" }) };
  }

  const parts = name.split(/\s+/);
  const lead = {
    firstName: parts.shift(),
    lastName: parts.join(" ") || undefined,
    email,
    smsConsent: false, // tools form collects no phone or SMS consent
    message: summary || "Requested an Owner Tools report.",
    source: "Owner Tools report",
    pageUrl: "https://spectacular-jalebi-8c3bc3.netlify.app/tools/",
    leadTemperature: "warm_inbound"
  };

  try {
    const res = await fetch(blanketUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(lead)
    });
    const text = await res.text().catch(() => "");
    if (res.status !== 202 && res.status !== 200) {
      console.error("Blanket rejected lead", res.status, text);
      return { statusCode: 502, headers, body: JSON.stringify({ error: "Lead not accepted" }) };
    }
    console.log("Blanket lead accepted:", text);
    return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
  } catch (err) {
    console.error("Blanket fetch error:", err.message);
    return { statusCode: 502, headers, body: JSON.stringify({ error: "Could not reach Blanket" }) };
  }
};
