// Receives Blanket's "Signed Owners" webhook (sent once, when an item is created there,
// i.e. when an owner lead hits Close Won) and creates a card on Aptly's Owner Onboarding board.
//
// Env vars (Netlify → Site configuration → Environment variables):
//   APTLY_ONBOARDING_KEY   API key from Aptly's Owner Onboarding board
//   ONBOARDING_WEBHOOK_KEY shared secret; Blanket's webhook URL must end in ?key=<this value>

const BOARD_ID = "vwTdY5uXCDzDsjGj4";          // Aptly: Owner Onboarding
const CONTACT_FIELD = "QWh8sNhgsqEd7H5J8";     // Owner Onboarding → Contact (person)
const OWNER_TYPE_ID = "QQD9gimh4A4yCGZFw";     // Aptly contact type: Owner
const API = "https://core-api.getaptly.com";

exports.handler = async function (event) {
  const json = (statusCode, body) => ({ statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  const secret = process.env.ONBOARDING_WEBHOOK_KEY;
  const key = (event.queryStringParameters || {}).key;
  if (!secret || key !== secret) return json(401, { error: "Unauthorized" });

  const apiKey = process.env.APTLY_ONBOARDING_KEY;
  if (!apiKey) {
    console.error("Missing APTLY_ONBOARDING_KEY env var");
    return json(500, { error: "Server misconfigured" });
  }

  let payload;
  try { payload = JSON.parse(event.body || "{}"); }
  catch (e) { return json(400, { error: "Invalid JSON" }); }

  const d = payload.data || {};
  const firstName = (d.firstName || "").trim();
  const lastName  = (d.lastName  || "").trim();
  const email     = (d.email     || "").trim();
  const phone     = (d.phone     || "").trim();
  const fullName  = `${firstName} ${lastName}`.trim() || email || "New owner";

  if (!email && !phone) return json(400, { error: "Need an email or phone to create the contact" });

  const headers = { "Content-Type": "application/json", "x-token": apiKey };

  try {
    // 1. Skip if this owner already has an open Owner Onboarding card (protects against retries).
    if (email) {
      const listRes = await fetch(`${API}/api/board/${BOARD_ID}/list`, {
        method: "POST",
        headers,
        body: JSON.stringify({ page: 0, pageSize: 5, contactEmail: email })
      });
      if (listRes.ok) {
        const list = await listRes.json().catch(() => ({}));
        if ((list.count || (list.data || []).length) > 0) {
          console.log("Onboarding card already exists for", email);
          return json(200, { skipped: "card already exists" });
        }
      } else {
        console.error("Aptly list check failed", listRes.status, await listRes.text().catch(() => ""));
      }
    }

    // 2. Create or update the Aptly contact (matched by email) and mark them as an Owner.
    const digits = phone.replace(/\D/g, "");
    const e164 = digits.length === 10 ? "+1" + digits : digits.length === 11 && digits[0] === "1" ? "+" + digits : null;
    const contactBody = { firstname: firstName, lastname: lastName, typeId: OWNER_TYPE_ID };
    if (email) contactBody.email = email;
    if (e164) contactBody.phone = [{ number: e164, type: "mobile" }];

    const contactRes = await fetch(`${API}/api/contacts`, { method: "POST", headers, body: JSON.stringify(contactBody) });
    const contact = await contactRes.json().catch(() => ({}));
    if (!contactRes.ok) {
      console.error("Aptly contact error", contactRes.status, JSON.stringify(contact));
      return json(502, { error: "Aptly rejected the contact" });
    }
    const contactId = contact._id || (contact.data && contact.data._id);

    // 3. Create the Owner Onboarding card.
    const card = {
      name: fullName,
      stage: "Property Type Check",
      description: `<p><strong>Source</strong><br>Blanket: signed owner (Owner Leads → Close Won)</p>
<p><strong>Email</strong><br>${email || "—"}</p>
<p><strong>Phone</strong><br>${phone || "—"}</p>
<p><strong>Blanket item</strong><br>${payload.itemId || "—"}</p>
<p>Property address, # of doors and service type: see the owner's record in Blanket.</p>`
    };
    if (contactId) card[CONTACT_FIELD] = { _id: contactId };

    const cardRes = await fetch(`${API}/api/board/${BOARD_ID}`, { method: "POST", headers, body: JSON.stringify(card) });
    const cardOut = await cardRes.json().catch(() => ({}));
    if (!cardRes.ok) {
      console.error("Aptly card error", cardRes.status, JSON.stringify(cardOut));
      return json(502, { error: "Aptly rejected the card" });
    }
    console.log("Onboarding card created:", JSON.stringify(cardOut));
    return json(200, { success: true });

  } catch (err) {
    console.error("Onboarding webhook error:", err.message);
    return json(500, { error: "Internal error" });
  }
};
