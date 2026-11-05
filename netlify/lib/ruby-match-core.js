// Ruby answering service files a Ruby Call Report form on every call, which makes a card on the
// Ruby Calls board. Charlie makes the Maintenance card first. This job sets Ruby's vendor on that
// Maintenance card, which starts the normal vendor messages (Katie, 11/4/2026).
//
// A call matches when exactly one open Maintenance card has the same Unit and was created in the
// last 3 days. It never guesses: no unit, no card after the wait, several cards, or a different
// vendor already on the card all go to Needs Review with an email to Julia (cc Katie).
// Calls with no vendor stay in New Call as the record of the call.
//
// Env vars: APTLY_RUBY_KEY (falls back to APTLY_OWNER_BILLING_KEY) needs Ruby Calls + Maintenance.
//           RUBY_MATCH_KEY (falls back to OWNER_BILLING_KEY, then LEASING_FEES_KEY) is the secret for the manual URL.

const APTLY_API = "https://core-api.getaptly.com";
const KATIE_USER_ID = "cDdtciekpJx5GvTCv";
const KATIE_FIG_INBOX = process.env.APTLY_EMAIL_CHANNEL || "9be03003-b087-5ca4-8113-7ae86b89dfb7";
const JULIA = "julial@freedominvestmentgroupinc.com";
const KATIE = "katie@freedominvestmentgroupinc.com";

const RUBY = "6nwB6skqM7mFiHrSd";
const MX = "naaJQQsf9PmFgGKSS";
const F = {
  unit: "jW5Lvy4xhM6TJfuRe", vendor: "eHitMP3nGQQatF8kh", // same uuids on both boards
  caller: "f5e9dmi6asisCtnxh", phone: "2jfzkKDgdTkorRazx", address: "M3ML7R2GEtZNT8B4D",
  emergency: "TGCYL9WNpwYnWL4Rr", reached: "sexLhcvAAG9k8vbgf", eta: "JzDGhanqc5JqyErbQ",
  agent: "9X4LmYkBi7KGNt2Cg", result: "WDRbEeGW789JM4YkM"
};
const MATCH_DAYS = 3;
const WAIT_MINUTES = 20; // Charlie's card should exist first; give it time before flagging
const LOOKBACK_DAYS = 7;

const aptlyKey = () => process.env.APTLY_RUBY_KEY || process.env.APTLY_OWNER_BILLING_KEY;
const secret = () => process.env.RUBY_MATCH_KEY || process.env.OWNER_BILLING_KEY || process.env.LEASING_FEES_KEY;
const h = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

async function aptly(path, body) {
  const key = aptlyKey();
  if (!key) throw new Error("APTLY_RUBY_KEY not set");
  const res = await fetch(`${APTLY_API}${path}`, {
    method: "POST",
    headers: { "x-token": key, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Aptly ${path} → ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

async function listActive(uuid, days) {
  const updatedAtMin = new Date(Date.now() - days * 86400000).toISOString();
  const cards = [];
  for (let page = 0; page < 20; page++) {
    const out = await aptly(`/api/board/${uuid}/list`, { page, pageSize: 1000, includeArchived: false, updatedAtMin });
    cards.push(...(out.data || []));
    if ((page + 1) * (out.pageSize || 1000) >= (out.count || 0)) break;
  }
  return cards;
}

const idOf = c => c.cardId || c._id;
const related = v => (Array.isArray(v) ? v : v ? [v] : []).filter(x => x && x._id);
const label = v => related(v).map(x => x.name).filter(Boolean).join(", ");
const stageOf = c => (c.stage && c.stage.label) || c.stage || "";
const ageMinutes = c => (Date.now() - new Date(c.createdAt).getTime()) / 60000;

// What should happen to one Ruby call, given the open Maintenance cards.
function decide(call, mxCards) {
  const vendor = related(call[F.vendor]);
  if (!vendor.length) return { action: "skip", why: "no vendor on the call" };
  const unit = related(call[F.unit]);
  if (!unit.length) return { action: "review", why: "Ruby did not pick a unit, so it can't be matched" };
  const found = mxCards.filter(c =>
    !["Closed", "Cancelled"].includes(stageOf(c)) &&
    ageMinutes(c) <= MATCH_DAYS * 1440 &&
    related(c[F.unit]).some(u => u._id === unit[0]._id));
  if (!found.length) {
    if (ageMinutes(call) < WAIT_MINUTES) return { action: "wait", why: "no Maintenance card yet" };
    return { action: "review", why: `no open Maintenance card for this unit from the last ${MATCH_DAYS} days` };
  }
  if (found.length > 1) return { action: "review", why: `${found.length} open Maintenance cards for this unit`, cards: found };
  const card = found[0];
  const current = related(card[F.vendor]);
  if (!current.length) return { action: "assign", card, vendor };
  if (current[0]._id === vendor[0]._id) return { action: "same", card };
  return { action: "review", why: `the card already has ${label(current)}, Ruby assigned ${label(vendor)}`, cards: [card] };
}

const cardUrl = (uuid, id) => `https://app.getaptly.com/ticket/${uuid}/${id}`;

function callNote(call) {
  return [
    `Ruby call report from ${call[F.agent] || "Ruby"}.`,
    `Caller: ${call[F.caller] || "not given"}, ${call[F.phone] || "no phone"}.`,
    `Issue: ${call.name || "not given"}.`,
    `Vendor assigned: ${label(call[F.vendor])}. Reached: ${call[F.reached] || "not given"}.`,
    call[F.eta] ? `ETA or notes: ${call[F.eta]}.` : ""
  ].filter(Boolean).join(" ");
}

async function emailReview(call, why, cards) {
  const row = (k, v) => `<tr><td style="padding:2px 12px 2px 0;color:#555">${h(k)}</td><td>${h(v)}</td></tr>`;
  const links = (cards || []).map(c => `<li><a href="${cardUrl(MX, idOf(c))}">${h(c.name)}</a></li>`).join("");
  const body = `<p>A Ruby call needs a person to check it: <b>${h(why)}</b>.</p>
<table>${row("Issue", call.name)}${row("Caller", call[F.caller])}${row("Phone", call[F.phone])}${row("Address given", call[F.address])}${row("Unit", label(call[F.unit]))}${row("Emergency", call[F.emergency])}${row("Vendor assigned", label(call[F.vendor]))}${row("Reached vendor", call[F.reached])}${row("ETA or notes", call[F.eta])}${row("Ruby agent", call[F.agent])}</table>
<p><a href="${cardUrl(RUBY, idOf(call))}">Open the Ruby Calls card</a></p>${links ? `<p>Maintenance cards:</p><ul>${links}</ul>` : ""}
<p>Set the vendor on the Maintenance card by hand, then move the Ruby card to Done.</p>`;
  await aptly("/api/email/send", {
    userId: KATIE_USER_ID, channelId: KATIE_FIG_INBOX,
    to: [{ value: JULIA }], cc: [{ value: KATIE }],
    subject: `Ruby call needs review: ${call.name || "no summary"}`, body, attachmentIds: [], failOnCreateNewThread: false
  });
}

// live false: report only, nothing changes.
async function run({ live }) {
  const calls = (await listActive(RUBY, LOOKBACK_DAYS)).filter(c => stageOf(c) === "New Call");
  const mxCards = await listActive(MX, LOOKBACK_DAYS);
  const report = [];
  for (const call of calls) {
    const d = decide(call, mxCards);
    const line = { call: call.name, action: d.action, why: d.why, card: d.card && d.card.name };
    report.push(line);
    if (!live) continue;
    if (d.action === "assign") {
      await aptly(`/api/board/${MX}`, { _id: idOf(d.card), [F.vendor]: d.vendor });
      d.card[F.vendor] = d.vendor; // a second call in this run sees the vendor
      await aptly(`/api/board/${MX}/${idOf(d.card)}/comment`, { userId: KATIE_USER_ID, content: callNote(call) });
    }
    if (d.action === "assign" || d.action === "same") {
      await aptly(`/api/board/${RUBY}`, { _id: idOf(call), stage: "Matched", [F.result]: `Maintenance card ${d.card.name}` });
    }
    if (d.action === "review") {
      await emailReview(call, d.why, d.cards);
      await aptly(`/api/board/${RUBY}`, { _id: idOf(call), stage: "Needs Review", [F.result]: d.why });
    }
  }
  return { live: !!live, calls: calls.length, report };
}

async function alertKatie(text) {
  if (!aptlyKey()) return;
  await aptly("/api/email/send", {
    userId: KATIE_USER_ID, channelId: KATIE_FIG_INBOX, to: [{ value: KATIE }], cc: [],
    subject: "Ruby vendor matching failed", body: h(text), attachmentIds: [], failOnCreateNewThread: false
  }).catch(() => {});
}

module.exports = { run, alertKatie, secret, listActive, RUBY, MX };
