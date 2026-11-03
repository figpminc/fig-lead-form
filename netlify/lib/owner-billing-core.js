// Monthly owner invoices for FIG Property Management's billable services:
// lock changes ($50 per deadbolt + $10 per passage knob), ozone ($200), dehumidifier ($200).
//
// On the 1st, pulls every Aptly card on the Maintenance and Make Ready boards that is tagged
// "Bill Owner: ..." and not yet "Owner Billed" (archived cards included), makes one PDF invoice
// per property from FIG Maintenance, and emails them to Julia (cc Katie) to review and send to
// Clyr. Nothing is entered in Rent Manager. Each invoice in the email has a "Mark as sent" link;
// confirming it sets Owner Billed + Owner Bill Reference on that invoice's cards, so they aren't
// billed again. Unmarked cards come back on the next run.
//
// Rules (Katie, 10/30/2026):
//   - Bill the property, never the tenant.
//   - Never guess a lock count: a lock change with no deadbolt/knob counts is flagged, not billed.
//   - Second Creek Studios is FIG-owned: flagged for Katie, not billed.
//
// Env vars (Netlify → Site configuration → Environment variables):
//   APTLY_OWNER_BILLING_KEY   Aptly API key (falls back to APTLY_LEASING_FEES_KEY)
//   OWNER_BILLING_KEY         shared secret for the manual URL and the signed "Mark as sent" links
//                             (falls back to LEASING_FEES_KEY)
//   SITE_URL                  optional; Netlify sets URL automatically

const crypto = require("crypto");
const { invoicePdf, money } = require("./owner-billing-pdf");

const APTLY_API = "https://core-api.getaptly.com";
const KATIE_USER_ID = "cDdtciekpJx5GvTCv";
const KATIE_FIG_INBOX = process.env.APTLY_EMAIL_CHANNEL || "9be03003-b087-5ca4-8113-7ae86b89dfb7";
const JULIA = "julial@freedominvestmentgroupinc.com";
const KATIE = "katie@freedominvestmentgroupinc.com";

const PRICE = { deadbolt: 50, knob: 10, ozone: 200, dehumidifier: 200 };
const SECOND_CREEK = /second creek/i;
const TAGS_START = "2026-10-30T00:00:00.000Z"; // the Bill Owner fields were created 10/30

const BOARDS = [
  {
    key: "mx", name: "Maintenance", uuid: "naaJQQsf9PmFgGKSS",
    lock: "6GxA3tkd3Tr67our5", ozone: "S9yTmpvMEjNe3qZXc", dehu: "fQPKYhLFBho7Poqu6",
    billed: "H2Nic7iWwmAvb3mY2", ref: "gi4kSugaxRt7ANjqW",
    deadbolts: "ikSrAL3F6xQ8vHSfD", knobs: "GiFcyAZ4AR2FDmtBH",
    unit: "jW5Lvy4xhM6TJfuRe", building: "TKdovRPB9xJfYaP78", owners: "bhQgyonp48jLXHC2P",
    issue: "QBLnTaXCbaCqJs7co", dates: ["4EAAo3DHBfyHfkhHz"] // Scheduled Date
  },
  {
    key: "mr", name: "Make Ready", uuid: "MoXvCc5Ee9YyrYEpF",
    lock: "9rkDAWfq3owaGxCtp", ozone: "eMYmQ5QvbZhL2HEBb", dehu: "G7uWnucCGTkijtioE",
    billed: "QAXwQ8zstYdPpvddR", ref: "cxtdno2LveJYmbv76",
    deadbolts: "JR66wCBjcBjDPFdTN", knobs: "HGhRX6wNL8dgndk2d",
    unit: "jqqnyPoY56AWzQjxk", building: "g9H2d86wZCropbHSj", owners: "PgZBNuP4nCk57eNo7",
    issue: null, dates: ["oG75NFwirdzgncmpY", "ZWCQzajTbvFKJYyZM"] // Make Ready Complete, Turn Prep Completed
  }
];
const BOARD = Object.fromEntries(BOARDS.map(b => [b.key, b]));

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const pad = n => String(n).padStart(2, "0");

function today() {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return {
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    ym: `${now.getFullYear()}${pad(now.getMonth() + 1)}`,
    period: `${MONTHS[prev.getMonth()]} ${prev.getFullYear()}`
  };
}

const aptlyKey = () => process.env.APTLY_OWNER_BILLING_KEY || process.env.APTLY_LEASING_FEES_KEY;
const secret = () => process.env.OWNER_BILLING_KEY || process.env.LEASING_FEES_KEY;
const siteUrl = () => process.env.SITE_URL || process.env.URL || "";

// ---------- Aptly ----------

async function aptly(path, body) {
  const key = aptlyKey();
  if (!key) throw new Error("APTLY_OWNER_BILLING_KEY not set");
  const res = await fetch(`${APTLY_API}${path}`, {
    method: "POST",
    headers: { "x-token": key, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Aptly ${path} → ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

async function listCards(board) {
  const cards = [];
  for (let page = 0; page < 20; page++) {
    const out = await aptly(`/api/board/${board.uuid}/list`, { page, pageSize: 1000, includeArchived: true, updatedAtMin: TAGS_START });
    cards.push(...(out.data || []));
    if ((page + 1) * (out.pageSize || 1000) >= (out.count || 0)) break;
  }
  return cards;
}

async function updateCard(board, cardId, fields) {
  return aptly(`/api/board/${board.uuid}`, { _id: cardId, ...fields });
}

// Related-record and person fields come back as objects or arrays of objects with a name.
function names(v) {
  const arr = Array.isArray(v) ? v : v ? [v] : [];
  return arr.map(x => (typeof x === "string" ? "" : x.name || x.fullName || x.title || [x.firstName, x.lastName].filter(Boolean).join(" ") || "")).filter(Boolean);
}
const first = v => names(v)[0] || "";
const isTrue = v => v === true || v === "true";
const num = v => (v === null || v === undefined || v === "" ? 0 : Number(v) || 0);
const day = v => (v ? String(v).slice(0, 10) : "");

// ---------- pricing ----------

function jobsFromCard(board, c) {
  const cardId = c.cardId || c._id;
  const unitName = first(c[board.unit]);
  // Building is filled on most cards; otherwise the property is the part of the unit name before " - ".
  const property = first(c[board.building]) || (unitName.includes(" - ") ? unitName.split(" - ")[0] : unitName) || "(no property)";
  // Unit names repeat the property, sometimes twice ("Louella Dr - Louella Dr - 117"); keep just the unit.
  let unit = unitName;
  while (property && unit.toLowerCase().startsWith(property.toLowerCase() + " - ")) unit = unit.slice(property.length + 3);
  const base = {
    board: board.key, cardId, title: c.name || c.title || "", property, unit,
    owner: names(c[board.owners]).join(", "),
    issue: board.issue ? String(c[board.issue] || "") : "",
    workDate: board.dates.map(f => day(c[f])).find(Boolean) || day(c.updatedAt || c.lastActivity)
  };
  const jobs = [], flags = [];
  if (isTrue(c[board.lock])) {
    const d = num(c[board.deadbolts]), k = num(c[board.knobs]);
    if (!d && !k) flags.push({ ...base, why: "Lock change tagged but Deadbolts Changed / Passage Knobs Changed are blank. Enter the counts on the card." });
    else {
      const parts = [];
      if (d) parts.push(`${d} deadbolt${d === 1 ? "" : "s"} x $50`);
      if (k) parts.push(`${k} passage knob${k === 1 ? "" : "s"} x $10`);
      jobs.push({ ...base, service: "Lock change", detail: parts.join(" + "), amount: d * PRICE.deadbolt + k * PRICE.knob });
    }
  }
  if (isTrue(c[board.ozone])) jobs.push({ ...base, service: "Ozone placement", detail: "Ozone machine placement", amount: PRICE.ozone });
  if (isTrue(c[board.dehu])) jobs.push({ ...base, service: "Dehumidifier placement", detail: "Dehumidifier placement", amount: PRICE.dehumidifier });
  return { jobs, flags };
}

async function collect() {
  const jobs = [], flags = [], secondCreek = [];
  let scanned = 0;
  for (const board of BOARDS) {
    const cards = await listCards(board);
    scanned += cards.length;
    for (const c of cards) {
      if (isTrue(c[board.billed])) continue;
      if (![board.lock, board.ozone, board.dehu].some(f => isTrue(c[f]))) continue;
      const r = jobsFromCard(board, c);
      if (SECOND_CREEK.test(r.jobs[0]?.property || r.flags[0]?.property || "")) { secondCreek.push(...r.jobs, ...r.flags); continue; }
      jobs.push(...r.jobs);
      flags.push(...r.flags);
    }
  }
  return { jobs, flags, secondCreek, scanned };
}

function invoices(jobs, t) {
  const byProp = new Map();
  [...jobs].sort((a, b) => (a.property + a.unit + a.workDate).localeCompare(b.property + b.unit + b.workDate))
    .forEach(j => { if (!byProp.has(j.property)) byProp.set(j.property, []); byProp.get(j.property).push(j); });
  let n = 1;
  return [...byProp.entries()].map(([property, js]) => {
    const number = `FM-${t.ym}-${pad(n++)}`;
    const owner = js.find(j => j.owner)?.owner || "";
    const { bytes, total } = invoicePdf({ number, date: t.date, period: t.period, property, owner, jobs: js });
    const cards = [...new Set(js.map(j => `${j.board}:${j.cardId}`))];
    return { number, property, owner, total, jobs: js, cards, bytes, file: `${number} ${property.replace(/[^A-Za-z0-9 .-]+/g, "").trim()}.pdf` };
  });
}

// ---------- signed "Mark as sent" links ----------

const sign = (inv, cards) => crypto.createHmac("sha256", secret() || "").update(`${inv}|${cards}`).digest("hex").slice(0, 32);
const verify = (inv, cards, sig) => {
  if (!secret() || !sig) return false;
  const a = Buffer.from(sign(inv, cards)), b = Buffer.from(String(sig));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const markLink = inv => {
  const cards = inv.cards.join(",");
  return `${siteUrl()}/.netlify/functions/owner-billing?mode=mark&inv=${encodeURIComponent(inv.number)}&cards=${encodeURIComponent(cards)}&sig=${sign(inv.number, cards)}`;
};

async function markSent(inv, cardsParam) {
  const done = [], failed = [];
  for (const item of String(cardsParam).split(",").filter(Boolean)) {
    const [bk, id] = item.split(":");
    const board = BOARD[bk];
    if (!board || !id) { failed.push(item); continue; }
    try { await updateCard(board, id, { [board.billed]: true, [board.ref]: inv }); done.push(item); }
    catch (e) { failed.push(`${item} (${String(e.message).slice(0, 80)})`); }
  }
  return { done, failed };
}

// ---------- email ----------

async function uploadAttachment(name, bytes) {
  const up = await aptly("/api/files/upload-url", {
    name, extension: "pdf", size: bytes.length, contentType: "application/pdf",
    attachEntityType: "channel", attachEntityId: KATIE_FIG_INBOX
  });
  const form = new FormData();
  for (const [k, v] of Object.entries(up.fields || {})) form.append(k, v);
  form.append("file", new Blob([bytes], { type: "application/pdf" }), name);
  const s3 = await fetch(up.url, { method: "POST", body: form });
  if (!s3.ok) throw new Error(`file upload → ${s3.status}`);
  await aptly("/api/files/upload-complete", { fileId: up.fileId });
  return up.fileId;
}

const h = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function emailHtml(invs, flags, secondCreek, t, test) {
  const total = invs.reduce((s, i) => s + i.total, 0);
  const rows = invs.map(i => `<tr><td>${h(i.number)}</td><td>${h(i.property)}</td><td style="text-align:right">${i.jobs.length}</td><td style="text-align:right">${money(i.total)}</td>` +
    `<td>${test ? "(test, no link)" : `<a href="${markLink(i)}">Mark as sent</a>`}</td></tr>`).join("");
  const lines = invs.flatMap(i => i.jobs.map(j => `<li>${h(i.number)} · ${h(j.property)} ${h(j.unit)}${j.issue ? " (issue " + h(j.issue) + ")" : ""} · ${h(j.service)}: ${h(j.detail)} = ${money(j.amount)}</li>`)).join("");
  const flagList = flags.map(f => `<li>${h(f.property)} ${h(f.unit)} (${h(f.title)}): ${h(f.why)}</li>`).join("");
  const scList = secondCreek.map(f => `<li>${h(f.unit)} (${h(f.title)}): ${h(f.service || "lock change")} ${f.amount ? money(f.amount) : ""}</li>`).join("");
  return [
    test ? `<p><b>TEST RUN: sent to Katie only. Nothing was marked billed.</b></p>` : "",
    `<p>Hi Julia,</p>`,
    invs.length
      ? `<p>Attached are this month's FIG Maintenance invoices for lock changes, ozone and dehumidifier placements: ${invs.length} invoice${invs.length === 1 ? "" : "s"}, ${money(total)} total. Please review them and send them to Clyr.</p>`
      : `<p>No billable lock changes, ozone or dehumidifier placements were tagged this month, so there are no invoices.</p>`,
    invs.length ? `<p><b>After you send an invoice to Clyr, click its "Mark as sent" link.</b> That marks its cards Owner Billed in Aptly so they are not billed again. Anything you don't mark comes back on next month's run.</p>` : "",
    invs.length ? `<table border="1" cellpadding="5" style="border-collapse:collapse"><tr><th>Invoice</th><th>Property</th><th>Jobs</th><th>Total</th><th></th></tr>${rows}</table>` : "",
    lines ? `<p><b>Line items</b></p><ul>${lines}</ul>` : "",
    flagList ? `<p><b>Not invoiced, needs info</b></p><ul>${flagList}</ul><p>Fix these on the card and they'll be picked up next month (or ask Katie to re-run it).</p>` : "",
    scList ? `<p><b>Second Creek (FIG-owned, not invoiced). Katie to decide</b></p><ul>${scList}</ul>` : "",
    `<p>Prices: lock change $50 per deadbolt + $10 per passage knob; ozone $200; dehumidifier $200. Invoices are billed to the property.</p>`
  ].join("\n");
}

async function sendEmail({ subject, html, attachmentIds, to, cc }) {
  return aptly("/api/email/send", {
    userId: KATIE_USER_ID, channelId: KATIE_FIG_INBOX,
    to: to.map(value => ({ value })), cc: cc.map(value => ({ value })),
    subject, body: html, attachmentIds, failOnCreateNewThread: false
  });
}

async function alertKatie(subject, text) {
  if (!aptlyKey()) return;
  await sendEmail({ subject, html: h(text).replace(/\n/g, "<br>"), attachmentIds: [], to: [KATIE], cc: [] }).catch(() => {});
}

// ---------- the run ----------
// mode "dryrun": compute only. "test": email Katie only, no mark links. "send": email Julia, cc Katie.

async function run({ mode = "dryrun" } = {}) {
  const t = today();
  const { jobs, flags, secondCreek, scanned } = await collect();
  const invs = invoices(jobs, t);
  const summary = {
    period: t.period, scanned, invoices: invs.map(i => ({ number: i.number, property: i.property, owner: i.owner, total: i.total, jobs: i.jobs.map(j => `${j.unit} ${j.service} ${j.detail} ${money(j.amount)} ${j.workDate}`), cards: i.cards })),
    total: invs.reduce((s, i) => s + i.total, 0), flagged: flags, secondCreek
  };
  if (mode === "dryrun") return summary;

  const test = mode !== "send";
  const attachmentIds = [];
  for (const i of invs) attachmentIds.push(await uploadAttachment(i.file, i.bytes));
  await sendEmail({
    subject: `${test ? "[TEST] " : ""}FIG Maintenance invoices to review - ${t.period}`,
    html: emailHtml(invs, flags, secondCreek, t, test), attachmentIds,
    to: test ? [KATIE] : [JULIA], cc: test ? [] : [KATIE]
  });
  return { ...summary, emailed: test ? KATIE : JULIA, attachments: attachmentIds.length };
}

// Single invoice PDF for viewing in the browser (mode=pdf&n=1).
async function previewPdf(n) {
  const { jobs } = await collect();
  const invs = invoices(jobs, today());
  return invs[(Number(n) || 1) - 1] || null;
}

module.exports = { run, previewPdf, markSent, verify, alertKatie, secret, BOARDS, listCards };
