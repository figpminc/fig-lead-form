// Live Rent Manager balance check before delinquency notices go out.
// Aptly's balances can lag Rent Manager by more than a day, so the notice rules must not rely on them.
// This reads each Grace Period tenant's balance from Rent Manager and marks only the cards that still owe.
// The Aptly rules "Stage Change: 14 Day Notice" and "Stage Change: 5 Day Notice" fire on that mark.
//
//   GET  ?key=<LEASING_FEES_KEY>&mode=access                        tests the Aptly key and RM access; changes nothing
//   GET  ?key=<LEASING_FEES_KEY>&mode=dry&board=monthly|weekly      shows what would be marked; changes nothing
//        &stage=<stage>                                             dry run only: look at a different stage
//   POST ?key=<LEASING_FEES_KEY>&mode=run&board=monthly|weekly      marks the cards and emails the summary
//
// Env vars: LEASING_FEES_KEY, RM_USERNAME, RM_AUTOMATION_PASSWORD, and an Aptly key allowed on both
// Delinquency boards and Leases (APTLY_NOTICE_CHECK_KEY, or one of the existing keys below).

const { rmLogin } = require("../lib/leasing-fees-core");

const API = "https://core-api.getaptly.com";
const RM_BASE = process.env.RM_BASE_URL || "https://figpm.rmx.rentmanager.com";
const LEASE_FIELD = "ms74BaSrWKde9muY7";
const COMMITTED_FIELD = "aBbW6qnJAbq6Pc2je";
const MIN_NOTICE_BALANCE = 100; // under $100 goes through Small Balance Owed, not a notice
const MAX_LOOKUP_FAILURE_RATE = 0.25;
const CONCURRENCY = 8;

const BOARDS = {
  monthly: { uuid: "zri2mvxNeqRiTSBFr", name: "Delinquency", verifiedField: "rDrSXSK45hHWXfGhk", checkField: "6wP55MJLKCQHKhDFf" },
  weekly: { uuid: "tDJGZjEH3JHdXBnpM", name: "Weekly Delinquency", verifiedField: "2e8PdktzFkbG7KpAN", checkField: "53NjQwZEg7W42ebcG" }
};

const KATIE_USER_ID = "cDdtciekpJx5GvTCv";
const KATIE_FIG_INBOX = process.env.APTLY_EMAIL_CHANNEL || "9be03003-b087-5ca4-8113-7ae86b89dfb7";
const ACCOUNT_MANAGER_EMAIL = "cassidyj@freedominvestmentgroupinc.com";
const KATIE_EMAIL = "katie@freedominvestmentgroupinc.com";

const json = (statusCode, body) => ({ statusCode, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(body, null, 1) });
const money = n => "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Aptly API keys are limited to certain boards, so each call uses the first key allowed on that board.
const aptlyKeys = () => [process.env.APTLY_NOTICE_CHECK_KEY, process.env.APTLY_OWNER_BILLING_KEY, process.env.APTLY_TURN_PROJECT_KEY, process.env.APTLY_LEASING_FEES_KEY, process.env.APTLY_VENDOR_KEY].filter(Boolean);

async function aptly(path, body) {
  let last = "No Aptly API key is set";
  for (const key of aptlyKeys()) {
    const res = await fetch(`${API}${path}`, {
      method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json", "x-token": key },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    if (res.status === 403) { last = `Aptly ${path.split("/").slice(0, 4).join("/")} returned 403: ${text.slice(0, 160)}`; continue; }
    if (!res.ok) throw new Error(`Aptly ${path.split("/").slice(0, 4).join("/")} returned ${res.status}: ${text.slice(0, 160)}`);
    return text ? JSON.parse(text) : {};
  }
  throw new Error(last);
}

async function rmBalance(session, tenantId) {
  const res = await fetch(`${RM_BASE}/api/Tenants/${tenantId}/Balance`, { headers: session.headers });
  const text = await res.text();
  if (!res.ok) throw new Error(`Rent Manager ${res.status}: ${text.slice(0, 120)}`);
  const n = Number(text);
  if (!Number.isFinite(n)) throw new Error(`Rent Manager returned an unreadable balance: ${text.slice(0, 60)}`);
  return n;
}

async function pool(items, worker) {
  const queue = items.map((item, i) => [item, i]);
  const out = new Array(items.length);
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) { const [item, i] = queue.shift(); out[i] = await worker(item); }
  }));
  return out;
}

// The Aptly lease card holds the Rent Manager lease ID; Rent Manager says which tenant is on that lease.
async function rmTenantForLease(session, rmLeaseId) {
  const res = await fetch(`${RM_BASE}/api/Leases/${rmLeaseId}?fields=LeaseID,TenantID`, { headers: session.headers });
  const text = await res.text();
  if (!res.ok) throw new Error(`Rent Manager lease ${rmLeaseId}: ${res.status} ${text.slice(0, 120)}`);
  return JSON.parse(text).TenantID || null;
}

// The only place a notice decision is made. Anything uncertain is sent for review instead of a notice.
function decide({ balance, tenantId, error }) {
  if (!tenantId) return { action: "review", why: "no Rent Manager tenant linked to this card" };
  if (error) return { action: "review", why: error };
  if (balance >= MIN_NOTICE_BALANCE) return { action: "notice" };
  if (balance >= 1) return { action: "small", why: "small balance" };
  return { action: "paid", why: "paid in Rent Manager" };
}

async function listStage(board, stage) {
  const cards = [];
  for (let page = 0; page < 20; page++) {
    const out = await aptly(`/api/board/${board.uuid}/list`, { page, pageSize: 500, includeArchived: false });
    cards.push(...(out.data || []));
    if ((page + 1) * (out.pageSize || 500) >= (out.count || 0)) break;
  }
  return cards.filter(c => (c.stage || c.Stage) === stage && !c.archived);
}

async function check(boardKey, { stage = "Grace Period", write = false } = {}) {
  const started = Date.now();
  const board = BOARDS[boardKey];
  if (!board) throw new Error("board must be monthly or weekly");
  if (write && stage !== "Grace Period") throw new Error("Only Grace Period cards can be marked");
  if (write && (!board.verifiedField || !board.checkField)) throw new Error(`${board.name} fields are not set in notice-check.js`);

  const session = await rmLogin();
  const cards = await listStage(board, stage);

  const rows = await pool(cards, async card => {
    const links = Array.isArray(card[LEASE_FIELD]) ? card[LEASE_FIELD] : [];
    const row = { id: card._id, name: String(card.name || "").split(" -  ")[0], committed: !!card[COMMITTED_FIELD], leaseId: links[0] && links[0]._id };
    try {
      if (!row.leaseId) throw new Error("no lease linked to this card");
      const lease = await aptly(`/api/board/lease/${row.leaseId}`);
      const leaseCard = lease.data !== undefined ? lease.data : lease;
      if (!leaseCard.rentmanagerId) throw new Error("lease card has no Rent Manager lease ID");
      row.tenantId = await rmTenantForLease(session, leaseCard.rentmanagerId);
      if (row.tenantId) row.balance = await rmBalance(session, row.tenantId);
    } catch (e) { row.error = String(e.message || e).slice(0, 160); }
    return { ...row, ...decide(row) };
  });

  const failed = rows.filter(r => r.action === "review");
  const summary = {
    board: board.name, stage, write, cards: rows.length, elapsedMs: 0,
    notice: rows.filter(r => r.action === "notice" && !r.committed),
    committed: rows.filter(r => r.committed).map(r => r.name),
    small: rows.filter(r => r.action === "small"),
    paid: rows.filter(r => r.action === "paid"),
    review: failed
  };

  // A wide failure means the check itself isn't working, so no one gets marked and no notice goes out.
  if (rows.length && failed.length / rows.length > MAX_LOOKUP_FAILURE_RATE) {
    summary.aborted = `${failed.length} of ${rows.length} cards could not be checked`;
    if (write) throw new Error(`${summary.aborted}. No notices were sent. First error: ${failed[0].why}`);
  }

  if (write) {
    const stamp = new Date().toLocaleString("en-US", { timeZone: "America/New_York", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" });
    const results = await pool(summary.notice, async r => {
      try {
        await aptly(`/api/board/${board.uuid}`, { _id: r.id, [board.checkField]: `${money(r.balance)} in Rent Manager on ${stamp} ET`, [board.verifiedField]: true });
        return null;
      } catch (e) { return `${r.name}: ${String(e.message || e).slice(0, 120)}`; }
    });
    summary.writeErrors = results.filter(Boolean);
    summary.emailed = await sendSummary(summary);
  }
  summary.elapsedMs = Date.now() - started;
  return summary;
}

function summaryText(s) {
  const l = [`The live Rent Manager check ran for ${s.board}.`, ""];
  l.push(`Getting a notice: ${s.notice.length}`);
  l.push(`No notice, already paid: ${s.paid.length}`);
  s.paid.forEach(r => l.push(`- ${r.name} (${money(r.balance)})`));
  l.push(`No notice, small balance: ${s.small.length}`);
  s.small.forEach(r => l.push(`- ${r.name} (${money(r.balance)})`));
  if (s.review.length) {
    l.push("", `NEEDS REVIEW, no notice sent: ${s.review.length}`);
    s.review.forEach(r => l.push(`- ${r.name}: ${r.why}`));
  }
  if ((s.writeErrors || []).length) {
    l.push("", `COULD NOT MARK, no notice sent: ${s.writeErrors.length}`);
    s.writeErrors.forEach(e => l.push(`- ${e}`));
  }
  return l.join("\n");
}

async function sendEmail(to, cc, subject, text) {
  const key = process.env.APTLY_LEASING_FEES_KEY;
  if (!key) throw new Error("APTLY_LEASING_FEES_KEY not set");
  const body = text.split("\n").map(x => x.replace(/&/g, "&amp;").replace(/</g, "&lt;")).join("<br>");
  const res = await fetch(`${API}/api/email/send`, {
    method: "POST",
    headers: { "x-token": key, "Content-Type": "application/json" },
    body: JSON.stringify({ userId: KATIE_USER_ID, channelId: KATIE_FIG_INBOX, to: [{ value: to }], cc: cc ? [{ value: cc }] : [], subject, body, failOnCreateNewThread: false })
  });
  if (!res.ok) throw new Error(`Aptly email returned ${res.status}`);
  return true;
}

async function sendSummary(s) {
  try {
    return await sendEmail(ACCOUNT_MANAGER_EMAIL, KATIE_EMAIL, `Delinquency notices: ${s.notice.length} sent, ${s.paid.length} already paid (${s.board})`, summaryText(s));
  } catch (e) { console.error("notice-check summary email failed", e.message); return false; }
}

async function access() {
  const out = { aptlyKeys: aptlyKeys().length };
  for (const k of Object.keys(BOARDS)) {
    try { const r = await aptly(`/api/board/${BOARDS[k].uuid}/list`, { page: 0, pageSize: 1 }); out[k] = `ok, ${r.count} cards`; out[`${k}Keys`] = r.data && r.data[0] ? Object.keys(r.data[0]).slice(0, 14) : []; out[`${k}Stage`] = r.data && r.data[0] ? r.data[0].stage : null; } catch (e) { out[k] = String(e.message); }
  }
  try {
    const r = await aptly("/api/board/lease/list", { page: 0, pageSize: 1 });
    const lease = r.data && r.data[0];
    out.lease = `ok, ${r.count} cards`;
    out.leaseKeys = lease ? Object.keys(lease).filter(k => /^[a-z]/i.test(k) && k.length < 20).slice(0, 30) : [];
    out.leaseRefs = lease && lease.references ? lease.references.filter(x => x.source === "rentmanager").map(x => x.type) : "no references in the API";
    if (lease) { const one = await aptly(`/api/board/lease/${lease._id}`); const d = one.data !== undefined ? one.data : one; out.leaseOneRefs = d.references ? d.references.filter(x => x.source === "rentmanager").map(x => x.type) : "no references"; out.leaseOneId = d.rentmanagerId || null; }
  } catch (e) { out.lease = String(e.message); }
  try {
    const session = await rmLogin();
    out.rmLogin = session.method;
    const t = await fetch(`${RM_BASE}/api/Tenants?pagesize=1&fields=TenantID`, { headers: session.headers }).then(r => r.json());
    out.rmBalance = t[0] ? typeof (await rmBalance(session, t[0].TenantID)) : "no tenants";
  } catch (e) { out.rm = String(e.message); }
  return out;
}

exports.handler = async function (event) {
  const q = event.queryStringParameters || {};
  const secret = process.env.LEASING_FEES_KEY;
  if (!secret || q.key !== secret) return json(401, { error: "Unauthorized" });
  try {
    if (q.mode === "access") return json(200, await access());
    if (q.mode === "dry") return json(200, await check(q.board, { stage: q.stage || "Grace Period" }));
    if (q.mode === "run" && event.httpMethod === "POST") return json(200, await check(q.board, { write: true }));
    return json(400, { error: "mode must be access, dry, or POST run" });
  } catch (e) {
    return json(500, { error: String(e.message || e), diag: e.diag });
  }
};

exports.check = check;
exports.summaryText = summaryText;
exports.sendEmail = sendEmail;
exports.decide = decide;
