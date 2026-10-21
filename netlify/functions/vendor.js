// Receives Netlify form webhooks from the vendor sign-up form on freedominvestmentgroupinc.com
// and creates a card on Aptly's Vendor Library board (stage Onboarding, assigned to Julia),
// with the vendor saved as a Vendor contact and their W9 / workers' comp files attached.
// Julia's onboarding checklist comes from Aptly's "Card creation" automation (Onboarding task template).
//
// Env vars (Netlify → Site configuration → Environment variables):
//   APTLY_VENDOR_KEY    API key from Aptly's Vendor Library board
//   VENDOR_WEBHOOK_KEY  shared secret; the Netlify form webhook URL must include ?key=<this value>

const API = "https://core-api.getaptly.com";
const BOARD_ID = "boihFiooyvNKAD8nz";             // Vendor Library
const VENDOR_TYPE_ID = "JobfaJcmYfKzbtLMT";       // Aptly contact type: Vendor
const JULIA = "udA4AurEsheRDJm8C";                // Julia Sibley, maintenance & construction admin
const FIELDS = {
  status: "nv6FqaS7mQAMN3HfQ",                    // Status (single select)
  contacts: "ndxbsrpdbRF8GJDaR",                  // Contacts (persons)
  areas: "pDsENhKWm878poi9K"                      // Areas Served (multi select)
};
// Options on the Areas Served field; the form's checkboxes use these exact labels.
const AREA_OPTIONS = ["Knoxville", "Tri-Cities", "Roane County", "Blount County"];
const STATUS_ONBOARDING = "Onboarding";          // select fields take the option label, not its id
const FILE_FIELDS = [["w9", "W9"], ["workers_comp", "Workers comp or state waiver"]];

const esc = (s) => String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

exports.handler = async function (event) {
  const json = (statusCode, body) => ({ statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  const secret = process.env.VENDOR_WEBHOOK_KEY;
  if (!secret || (event.queryStringParameters || {}).key !== secret) return json(401, { error: "Unauthorized" });

  const apiKey = process.env.APTLY_VENDOR_KEY;
  if (!apiKey) {
    console.error("Missing APTLY_VENDOR_KEY env var");
    return json(500, { error: "Server misconfigured" });
  }

  let payload;
  try { payload = JSON.parse(event.body || "{}"); }
  catch (e) { return json(400, { error: "Invalid JSON" }); }
  if (payload.form_name && payload.form_name !== "vendor") return json(200, { skipped: "not the vendor form" });

  const d = payload.data || {};
  const name = String(d.name || "").trim();
  const company = String(d.company || "").trim();
  const email = String(d.email || "").trim();
  const phone = String(d.phone || "").trim();
  const trades = String(d.trades || "").trim();
  // Netlify sends a checkbox group as an array or a comma-separated string.
  const pickedAreas = (Array.isArray(d.areas) ? d.areas : String(d.areas || "").split(","))
    .map((a) => String(a).trim()).filter(Boolean);
  const areas = AREA_OPTIONS.filter((opt) => pickedAreas.some((a) => a.toLowerCase() === opt.toLowerCase()));
  const otherAreas = String(d.areas_other || "").trim();
  const areasText = [...areas, otherAreas].filter(Boolean).join(", ");
  if (!email && !phone) return json(400, { error: "Need an email or phone to create the contact" });

  const headers = { "Content-Type": "application/json", "x-token": apiKey };

  try {
    // 1. Create or update the vendor contact (Aptly matches by email).
    const [firstname, ...rest] = name.split(/\s+/);
    const digits = phone.replace(/\D/g, "");
    const e164 = digits.length === 10 ? "+1" + digits : digits.length === 11 && digits[0] === "1" ? "+" + digits : null;
    const contactBody = { firstname: firstname || company || email, lastname: rest.join(" "), typeId: VENDOR_TYPE_ID };
    if (company) contactBody.company = company;
    if (email) contactBody.email = email;
    if (e164) contactBody.phone = [{ number: e164, type: "mobile" }];

    const contactRes = await fetch(`${API}/api/contacts`, { method: "POST", headers, body: JSON.stringify(contactBody) });
    const contact = await contactRes.json().catch(() => ({}));
    if (!contactRes.ok) {
      console.error("Aptly contact error", contactRes.status, JSON.stringify(contact));
      return json(502, { error: "Aptly rejected the contact" });
    }
    const contactId = contact._id || (contact.data && contact.data._id);

    // 2. Create the card in Onboarding, assigned to Julia.
    const card = {
      name: company || name || email,
      stage: "Onboarding",
      assignee: JULIA,
      [FIELDS.status]: STATUS_ONBOARDING,
      description: `<p><strong>Source</strong><br>Vendor sign-up form, freedominvestmentgroupinc.com</p>
<p><strong>Contact</strong><br>${esc(name) || "—"}</p>
<p><strong>Company</strong><br>${esc(company) || "—"}</p>
<p><strong>Email</strong><br>${esc(email) || "—"}</p>
<p><strong>Phone</strong><br>${esc(phone) || "—"}</p>
<p><strong>Trade(s)</strong><br>${esc(trades) || "—"}</p>
<p><strong>Areas served</strong><br>${esc(areasText) || "—"}</p>`
    };
    if (areas.length) card[FIELDS.areas] = areas;   // select fields take option labels
    if (contactId) {
      card[FIELDS.contacts] = [{ _id: contactId }];
      card.relatedContacts = [{ _id: contactId }];
    }

    let cardRes = await fetch(`${API}/api/board/${BOARD_ID}`, { method: "POST", headers, body: JSON.stringify(card) });
    let cardOut = await cardRes.json().catch(() => ({}));
    if (!cardRes.ok) {
      // Retry with just the essentials in case Aptly rejects a field's format.
      console.error("Aptly card error, retrying with fewer fields", cardRes.status, JSON.stringify(cardOut));
      for (const k of ["assignee", FIELDS.status, FIELDS.areas]) delete card[k];
      cardRes = await fetch(`${API}/api/board/${BOARD_ID}`, { method: "POST", headers, body: JSON.stringify(card) });
      cardOut = await cardRes.json().catch(() => ({}));
    }
    if (!cardRes.ok) {
      console.error("Aptly card error", cardRes.status, JSON.stringify(cardOut));
      return json(502, { error: "Aptly rejected the card" });
    }
    const cardId = (cardOut.data && cardOut.data._id) || cardOut._id;
    console.log("Vendor card created:", cardId);

    // 3. Copy the uploaded documents from Netlify onto the card.
    const attached = [];
    for (const [field, label] of FILE_FIELDS) {
      const f = d[field];
      const url = typeof f === "string" ? f : f && f.url;
      if (!url || !cardId) continue;
      try {
        const fileRes = await fetch(url);
        if (!fileRes.ok) throw new Error(`download ${fileRes.status}`);
        const type = (f && f.type) || fileRes.headers.get("content-type") || "application/pdf";
        const original = (f && f.filename) || "document";
        const form = new FormData();
        form.append("file", new Blob([await fileRes.arrayBuffer()], { type }), `${label} - ${original}`);
        const up = await fetch(`${API}/api/board/${BOARD_ID}/${cardId}/file`, { method: "POST", headers: { "x-token": apiKey }, body: form });
        if (!up.ok) throw new Error(`upload ${up.status} ${await up.text().catch(() => "")}`);
        attached.push(label);
      } catch (err) {
        console.error(`Could not attach ${label}:`, err.message);
      }
    }
    return json(200, { success: true, cardId, attached });

  } catch (err) {
    console.error("Vendor webhook error:", err.message);
    return json(500, { error: "Internal error" });
  }
};
