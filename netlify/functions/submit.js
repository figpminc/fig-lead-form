// Owner quote form → Blanket Owner Leads (New). Leads go only to Blanket; Aptly receives
// owners once they sign (see onboarding.js). Field names per Blanket's website form guide.
exports.handler = async function (event) {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };

  let payload;
  try { payload = JSON.parse(event.body || "{}"); }
  catch (e) { return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON" }) }; }

  const firstName = (payload.firstName || "").trim();
  const lastName  = (payload.lastName  || "").trim();
  const email     = (payload.email     || "").trim();
  const phone     = (payload.phone     || "").trim();
  const address   = (payload.address   || "").trim();
  const units     = (payload.units     || "").trim();
  const smsConsent = payload.smsConsent === true;

  if (!firstName || !lastName || !email || !phone || !address || !units) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing required fields" }) };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid email" }) };
  }

  const blanketUrl = process.env.BLANKET_LEAD_URL;
  if (!blanketUrl) {
    console.error("Missing BLANKET_LEAD_URL env var");
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Server misconfigured" }) };
  }

  // Normalize phone to E.164
  const digits = phone.replace(/\D/g, "");
  const normalizedPhone = digits.length === 10 ? "+1" + digits
    : digits.length === 11 && digits[0] === "1" ? "+" + digits
    : null;

  const lead = {
    firstName,
    lastName,
    email,
    phone: normalizedPhone || phone,
    smsConsent,
    units: parseInt(units, 10) || undefined, // "2-5" -> 2, "21+" -> 21
    address,
    message: `Property address: ${address}\nNumber of units: ${units}`,
    source: "Free Management Quote form",
    pageUrl: "https://spectacular-jalebi-8c3bc3.netlify.app/",
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
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Internal error" }) };
  }
};
