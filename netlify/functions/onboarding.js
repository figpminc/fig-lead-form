// Receives Blanket's signed-owner webhooks (sent once, when an item is created in a hand-off
// pipeline, i.e. when an owner lead hits Close Won) and creates the matching Aptly card:
//   full management (default)  → Owner Leads card, moved to Agreement Signed. Aptly's copy rules
//                                then create the Owner Onboarding and New Property Onboarding cards,
//                                the same way as for an owner signed in Aptly.
//   ?route=leasing             → Property Marketing board (leasing-only owners)
//
// Env vars (Netlify → Site configuration → Environment variables):
//   APTLY_ONBOARDING_KEY   Aptly API token "Blanket"; must include the Owner Leads board
//   APTLY_MARKETING_KEY    API key from Aptly's Property Marketing board
//   ONBOARDING_WEBHOOK_KEY shared secret; Blanket's webhook URL must include ?key=<this value>

const OWNER_TYPE_ID = "QQD9gimh4A4yCGZFw";     // Aptly contact type: Owner
const API = "https://core-api.getaptly.com";
const SIGNED = "Agreement Signed";
const SIGNED_DATE = "9rdyimyNKku5uRcFf";           // Owner Leads "Agreement Signed Date"
const START_ONBOARDING = "Pr6bQFkMKNZipQWPf";      // Owner Leads "Start Onboarding" checkbox; the copy rules key on it

const ROUTES = {
  onboarding: {
    label: "Owner Leads",
    boardId: "emGXMwnLubrAvhKt6",
    contactField: "contact",                    // Contact (person)
    stage: "Agreement Sent",                    // created here, then moved to Agreement Signed
    moveTo: SIGNED,                             // with Start Onboarding checked, the copy rules pick it up
    keyEnv: "APTLY_ONBOARDING_KEY",
    dedupe: true,
    source: "Blanket: signed owner (Owner Leads → Close Won)",
    extra: { tDPZGmAhTyapSxvqm: "Full Management" }  // Service Type (select fields take the label)
  },
  leasing: {
    label: "Property Marketing",
    boardId: "QK2DGqNjiEczLJbLt",
    contactField: "97rvLmpvJQrTeYNRJ",          // Contact (person)
    stage: "Create Listing",
    keyEnv: "APTLY_MARKETING_KEY",
    dedupe: false,                              // repeat leasing clients get a new card per listing
    source: "Blanket: signed leasing-only owner (Owner Leads → Close Won)",
    extra: { prhgFXap5DNHvn8XT: "W5wQNdBYG5oezGtsW" }  // Service Type = Leasing Only
  }
};

exports.handler = async function (event) {
  const json = (statusCode, body) => ({ statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  const secret = process.env.ONBOARDING_WEBHOOK_KEY;
  const key = (event.queryStringParameters || {}).key;
  if (!secret || key !== secret) return json(401, { error: "Unauthorized" });

  const route = ROUTES[(event.queryStringParameters || {}).route] || ROUTES.onboarding;
  const BOARD_ID = route.boardId;
  const apiKey = process.env[route.keyEnv];
  if (!apiKey) {
    console.error(`Missing ${route.keyEnv} env var`);
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

  // Moves a card to a new stage (and sets any extra fields) through the board's create-or-update endpoint.
  const moveCard = async (cardId) => {
    const res = await fetch(`${API}/api/board/${BOARD_ID}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ _id: cardId, stage: route.moveTo, [SIGNED_DATE]: new Date().toISOString(), [START_ONBOARDING]: true, ...route.extra })
    });
    if (!res.ok) throw new Error(`Aptly stage move failed: ${res.status} ${(await res.text().catch(() => "")).slice(0, 300)}`);
  };

  try {
    // 1. If this owner already has a card on the board, don't make a second one (protects against retries).
    //    An existing Owner Leads card that isn't signed yet is moved to Agreement Signed instead.
    if (route.dedupe && email) {
      const listRes = await fetch(`${API}/api/board/${BOARD_ID}/list`, {
        method: "POST",
        headers,
        body: JSON.stringify({ page: 0, pageSize: 5, contactEmail: email })
      });
      if (listRes.ok) {
        const list = await listRes.json().catch(() => ({}));
        const existing = (list.data || [])[0];
        if (existing || list.count > 0) {
          const stage = existing && (existing.stage || existing.Stage);
          const existingId = existing && (existing._id || existing.id);
          if (route.moveTo && existingId && (stage !== route.moveTo || existing[START_ONBOARDING] !== true)) {
            await moveCard(existingId);
            console.log(`${route.label} card ${existingId} moved to ${route.moveTo} for`, email);
            return json(200, { success: true, moved: existingId });
          }
          console.log(`${route.label} card already exists for`, email);
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

    // 3. Create the card.
    const card = {
      name: fullName,
      stage: route.stage,
      ...route.extra,
      description: `<p><strong>Source</strong><br>${route.source}</p>
<p><strong>Email</strong><br>${email || "—"}</p>
<p><strong>Phone</strong><br>${phone || "—"}</p>
<p><strong>Blanket item</strong><br>${payload.itemId || "—"}</p>
<p>Property address, # of doors and service type: see the owner's record in Blanket.</p>`
    };
    if (contactId) card[route.contactField] = { _id: contactId };

    let cardRes = await fetch(`${API}/api/board/${BOARD_ID}`, { method: "POST", headers, body: JSON.stringify(card) });
    let cardOut = await cardRes.json().catch(() => ({}));
    if (!cardRes.ok && Object.keys(route.extra).length) {
      // Retry without the extra select fields in case Aptly rejects their format.
      console.error("Aptly card error with extra fields, retrying", cardRes.status, JSON.stringify(cardOut));
      for (const k of Object.keys(route.extra)) delete card[k];
      cardRes = await fetch(`${API}/api/board/${BOARD_ID}`, { method: "POST", headers, body: JSON.stringify(card) });
      cardOut = await cardRes.json().catch(() => ({}));
    }
    if (!cardRes.ok) {
      console.error("Aptly card error", cardRes.status, JSON.stringify(cardOut));
      return json(502, { error: "Aptly rejected the card" });
    }
    console.log(`${route.label} card created:`, JSON.stringify(cardOut));

    // 4. Move it to Agreement Signed, which starts Owner Onboarding and New Property Onboarding.
    if (route.moveTo) {
      const newId = cardOut._id || (cardOut.data && cardOut.data._id) || cardOut.id;
      if (!newId) {
        console.error("Card created but no id returned; move it to", route.moveTo, "by hand");
        return json(502, { error: "Card created without an id" });
      }
      await moveCard(newId);
      console.log(`${route.label} card ${newId} moved to ${route.moveTo}`);
    }
    return json(200, { success: true });

  } catch (err) {
    console.error("Onboarding webhook error:", err.message);
    return json(500, { error: "Internal error" });
  }
};
