// Called by the Aptly automation when Documents Approved is checked on a Vendor Library card.
// Creates the vendor in Rent Manager from the card's sign-up details, then leaves a comment on the card.
// It only ever creates new vendors. If the vendor looks like one Rent Manager already has, it creates
// nothing and says so on the card for Julia. The overnight sync brings new vendors into Aptly's Vendors board.
// Tax ID and 1099 details stay with Julia: the form only collects the W9 as a file.
//
//   POST /.netlify/functions/vendor-to-rm?key=<VENDOR_WEBHOOK_KEY>                 the Aptly webhook (sends the card)
//   GET  /.netlify/functions/vendor-to-rm?key=<VENDOR_WEBHOOK_KEY>&card=<id>&dry=1 shows what would happen; changes nothing
//
// Env vars: VENDOR_WEBHOOK_KEY, APTLY_VENDOR_KEY, RM_USERNAME, RM_AUTOMATION_PASSWORD

const { rmLogin } = require("../lib/leasing-fees-core");

const API = "https://core-api.getaptly.com";
const RM_BASE = process.env.RM_BASE_URL || "https://figpm.rmx.rentmanager.com";
const BOARD_ID = "boihFiooyvNKAD8nz";             // Vendor Library
const DOCS_APPROVED = "C8yMTbHjKynwZAms6";        // Documents Approved (checkbox)
const COMMENT_AUTHOR = "cDdtciekpJx5GvTCv";       // Katie
const PHONE_TYPE = 13;                            // the type Julia's vendors use for their primary phone
const ADDED_NOTE = "Added to Rent Manager as vendor #";
const MATCH_NOTE = "Not added to Rent Manager";

const json = (statusCode, body) => ({ statusCode, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(body) });

const unescape = (s) => String(s || "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const normName = (s) => unescape(s).toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\b(llc|inc|incorporated|corp|corporation|co|company|ltd|the)\b/g, " ").replace(/\s+/g, " ").trim();
const normEmail = (s) => String(s || "").trim().toLowerCase();
const normPhone = (s) => { const d = String(s || "").replace(/\D/g, ""); return d.length === 11 && d[0] === "1" ? d.slice(1) : d; };
const usable = (s) => s && s !== "—";

// The sign-up form writes these into the card description; see vendor.js.
function fromDescription(html, label) {
  const m = String(html || "").match(new RegExp(`<strong>${label}</strong><br>([^<]*)</p>`));
  const value = m ? unescape(m[1]).trim() : "";
  return usable(value) ? value : "";
}

function cardIdFrom(event) {
  const q = event.queryStringParameters || {};
  if (q.card) return q.card;
  const raw = event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString() : event.body;
  let b = {};
  try { b = JSON.parse(raw || "{}"); } catch (e) { return null; }
  const id = b.cardId || b._id || b.id || b.instanceId || (b.card && (b.card.cardId || b.card._id)) || (b.data && (b.data.cardId || b.data._id));
  if (!id) console.error("vendor-to-rm: no card id in webhook, keys:", Object.keys(b).join(","));
  return id || null;
}

async function aptly(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json", "x-token": process.env.APTLY_VENDOR_KEY },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Aptly ${path.split("/").pop()} returned ${res.status}: ${text.slice(0, 200)}`);
  const parsed = text ? JSON.parse(text) : {};
  return parsed.data !== undefined ? parsed.data : parsed;
}

const comment = (cardId, content) => aptly(`/api/board/${BOARD_ID}/${cardId}/comment`, { userId: COMMENT_AUTHOR, content });

function buildVendor(card) {
  const name = String(card.name || card.Title || card.title || "").trim();
  const contactName = fromDescription(card.description, "Contact");
  const email = fromDescription(card.description, "Email");
  const phone = normPhone(fromDescription(card.description, "Phone"));
  const [first, ...rest] = contactName.split(/\s+/);
  return {
    summary: { name, contactName, email, phone },
    vendor: {
      Name: name.slice(0, 100),
      Payee: name.slice(0, 100),
      IsActive: true,
      Is1099: true, // Julia confirms from the W9
      Contacts: [{ FirstName: rest.length ? first : "", LastName: (rest.length ? rest.join(" ") : first) || name, Email: email, IsPrimary: true, IsActive: true, ContactTypeID: -1 }],
      PhoneNumbers: phone ? [{ PhoneNumberTypeID: PHONE_TYPE, PhoneNumber: phone, IsPrimary: true }] : []
    }
  };
}

async function rmVendors(session) {
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const res = await fetch(`${RM_BASE}/api/Vendors?embeds=Contacts,PhoneNumbers&pagesize=500&pagenumber=${page}`, { headers: session.headers });
    const text = await res.text();
    if (!res.ok) throw new Error(`Rent Manager vendor list returned ${res.status}: ${text.slice(0, 200)}`);
    const rows = text ? JSON.parse(text) : [];
    out.push(...rows);
    if (rows.length < 500) break;
  }
  return out;
}

// Any match on name, email or phone counts, active or inactive.
function findMatches(summary, vendors) {
  const name = normName(summary.name), email = normEmail(summary.email), phone = normPhone(summary.phone);
  const matches = [];
  for (const v of vendors) {
    const why = [];
    if (name && normName(v.Name) === name) why.push("name");
    if (email && (v.Contacts || []).some(c => normEmail(c.Email) === email)) why.push("email");
    if (phone && (v.PhoneNumbers || []).some(p => normPhone(p.PhoneNumber) === phone)) why.push("phone");
    if (why.length) matches.push({ id: v.VendorID, name: v.Name, active: v.IsActive, why });
  }
  return matches;
}

async function createVendor(session, vendor) {
  const res = await fetch(`${RM_BASE}/api/Vendors?embeds=Contacts,PhoneNumbers`, {
    method: "POST",
    headers: { ...session.headers, "Content-Type": "application/json" },
    body: JSON.stringify([vendor])
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Rent Manager returned ${res.status}: ${text.slice(0, 300)}`);
  const parsed = JSON.parse(text);
  const created = Array.isArray(parsed) ? parsed[0] : parsed;

  // Read it back: only report what really saved.
  const check = await fetch(`${RM_BASE}/api/Vendors/${created.VendorID}?embeds=Contacts,PhoneNumbers`, { headers: session.headers });
  const saved = await check.json();
  const missing = [];
  const wantEmail = normEmail(vendor.Contacts[0].Email), wantPhone = normPhone(vendor.PhoneNumbers[0] && vendor.PhoneNumbers[0].PhoneNumber);
  if (wantEmail && !(saved.Contacts || []).some(c => normEmail(c.Email) === wantEmail)) missing.push("email");
  if (wantPhone && !(saved.PhoneNumbers || []).some(p => normPhone(p.PhoneNumber) === wantPhone)) missing.push("phone");
  return { id: created.VendorID, missing };
}

exports.handler = async function (event) {
  const q = event.queryStringParameters || {};
  const secret = process.env.VENDOR_WEBHOOK_KEY;
  if (!secret || q.key !== secret) return json(401, { error: "Unauthorized" });
  const dry = q.dry === "1";
  if (!dry && event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  const cardId = cardIdFrom(event);
  if (!cardId) return json(400, { error: "No card id" });

  try {
    const card = await aptly(`/api/board/${BOARD_ID}/${cardId}`);
    if (card[DOCS_APPROVED] !== true) return json(200, { skipped: "Documents Approved is not checked" });

    const comments = await aptly(`/api/board/${BOARD_ID}/${cardId}/comments`);
    const list = Array.isArray(comments) ? comments : comments.comments || [];
    if (list.some(c => String(c.content || "").includes(ADDED_NOTE) || String(c.content || "").includes(MATCH_NOTE))) {
      return json(200, { skipped: "Already handled on this card" });
    }

    const { summary, vendor } = buildVendor(card);
    if (!summary.name) throw new Error("The card has no title to use as the vendor name");

    const session = await rmLogin();
    const matches = findMatches(summary, await rmVendors(session));
    if (dry) return json(200, { dry: true, summary, vendor, matches });

    if (matches.length) {
      const list = matches.map(m => `${m.name} (#${m.id}${m.active ? "" : ", inactive"}, same ${m.why.join(" and ")})`).join("; ");
      await comment(cardId, `${MATCH_NOTE}: it may already be there as ${list}. If this is a different vendor, please add it by hand.`);
      return json(200, { created: false, matches });
    }

    const { id, missing } = await createVendor(session, vendor);
    const gaps = missing.length ? ` The ${missing.join(" and ")} did not save, so please add ${missing.length > 1 ? "them" : "it"} in Rent Manager.` : "";
    await comment(cardId, `${ADDED_NOTE}${id}.${gaps} Please add the tax ID from the W9 and confirm the 1099 setting there.`);
    return json(200, { created: true, vendorId: id, missing });

  } catch (err) {
    console.error("vendor-to-rm error:", err.message);
    if (!dry) await comment(cardId, `Could not add this vendor to Rent Manager automatically, so please add it by hand. (${err.message.slice(0, 200)})`).catch(e => console.error("comment failed:", e.message));
    return json(500, { error: String(err.message || err) });
  }
};
