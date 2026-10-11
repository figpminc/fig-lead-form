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
  const units     = (payload.units     || "").trim();
  const smsConsent = payload.smsConsent === true;

  if (!firstName || !lastName || !email || !phone || !units) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing required fields" }) };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid email" }) };
  }

  const apiKey = process.env.APTLY_API_KEY;
  const boardId = process.env.APTLY_BOARD_ID;
  if (!apiKey || !boardId) {
    console.error("Missing APTLY_API_KEY or APTLY_BOARD_ID env vars");
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Server misconfigured" }) };
  }

  // Normalize phone to E.164
  const digits = phone.replace(/\D/g, "");
  const normalizedPhone = digits.length === 10 ? "+1" + digits
    : digits.length === 11 && digits[0] === "1" ? "+" + digits
    : null;

  const fullName = `${firstName} ${lastName}`;

  const description = `<p><strong>Source</strong><br>Google Ads — Owner Inquiry Form</p>
<p><strong>Name</strong><br>${fullName}</p>
<p><strong>Email</strong><br>${email}</p>
<p><strong>Phone</strong><br>${phone}</p>
<p><strong>Number of units</strong><br>${units}</p>
<p><strong>SMS consent</strong><br>${smsConsent ? "Yes (checked the text-message box)" : "No"}</p>
<p><strong>Submitted</strong><br>${new Date().toLocaleString("en-US", { timeZone: "America/New_York" })} ET</p>`;

  const cardPayload = {
    name: fullName,
    trackingEmail: email,
    stage: "Prospect",
    description
  };

  if (normalizedPhone) {
    cardPayload.trackingPhone = normalizedPhone;
  }

  // Also send the lead to Blanket (Owner Leads → New). Field names per Blanket's website form guide.
  // A failure here is logged but never blocks the Aptly card or the owner's confirmation.
  async function sendToBlanket() {
    const blanketUrl = process.env.BLANKET_LEAD_URL;
    if (!blanketUrl) {
      console.error("BLANKET_LEAD_URL not set; lead not sent to Blanket");
      return;
    }
    const lead = {
      firstName,
      lastName,
      email,
      phone: normalizedPhone || phone,
      smsConsent,
      units: parseInt(units, 10) || undefined, // "2-5" -> 2, "21+" -> 21
      message: `Number of units: ${units}`,
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
      if (res.status !== 202 && res.status !== 200) console.error("Blanket rejected lead", res.status, text);
      else console.log("Blanket lead accepted:", text);
    } catch (err) {
      console.error("Blanket fetch error:", err.message);
    }
  }

  try {
    const [aptlyRes] = await Promise.all([
      fetch(`https://core-api.getaptly.com/api/board/${boardId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-token": apiKey },
        body: JSON.stringify(cardPayload)
      }),
      sendToBlanket()
    ]);

    if (!aptlyRes.ok) {
      const errText = await aptlyRes.text().catch(() => "");
      console.error("Aptly error", aptlyRes.status, errText);
      return { statusCode: 502, headers, body: JSON.stringify({ error: "Aptly rejected the card" }) };
    }

    const result = await aptlyRes.json().catch(() => ({}));
    console.log("Card created:", result);
    return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };

  } catch (err) {
    console.error("Fetch error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Internal error" }) };
  }
};
