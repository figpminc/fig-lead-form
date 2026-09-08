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

  if (!firstName || !lastName || !email || !phone || !units) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing required fields" }) };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid email" }) };
  }

  const apiKey  = process.env.APTLY_API_KEY;
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

  try {
    const aptlyRes = await fetch(`https://core-api.getaptly.com/api/board/${boardId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-token": apiKey },
      body: JSON.stringify(cardPayload)
    });

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
