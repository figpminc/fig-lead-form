// Monthly owner leasing-fee billing for FIG Property Management.
//
// For the previous calendar month (or ?period=YYYY-MM), creates two Rent Manager bills
// under vendor FIG LEASING FEE, one split per property/unit:
//   1. Renewals: $250 for each lease renewal recorded in RM that month
//   2. Move-ins: 50% of one month's rent for each lease that moved in that month
// Then emails Cassidy the summary from Katie's FIG inbox in Aptly.
// No tenant charges are posted.
//
// Rules (Katie, 11/3/2026):
//   - Never bill Second Creek Studios (ShortName starts "SCS") or Trailblazer ("TRAIL").
//   - Skip move-ins whose Aptly Applicants card has Charge Leasing Fee = No.
//   - Unsigned renewals are billed. Holbrook is $250 like everyone else.
//   - Anything odd is flagged in the email instead of billed.
//
// Env vars (Netlify → Site configuration → Environment variables):
//   RM_USERNAME, RM_AUTOMATION_PASSWORD   dedicated Rent Manager automation user (RM_PASSWORD still works as a fallback)
//   RM_LOCATION_ID             optional, only if RM asks for a location at login
//   APTLY_LEASING_FEES_KEY              any Aptly API key for the company (Applicants board has API on)
//   LEASING_FEES_KEY           shared secret for the manual/dry-run URL

const RM_BASE = process.env.RM_BASE_URL || "https://figpm.rmx.rentmanager.com";
const APTLY_API = "https://core-api.getaptly.com";

const VENDOR_ID = 632;        // FIG LEASING FEE
const BANK_ID = 340;          // Wilson Owner Trust
const GL_ID = 316;            // 5001 Leasing Fee Expense
const RENEWAL_FEE = 250;
const MOVE_IN_RATE = 0.5;
const EXCLUDED = [/^SCS/i, /^TRAIL$/i];

const APPLICANTS_BOARD = "iEG7hQfz3fwD8ugZj";
const CHARGE_FEE_FIELD = "DPaSMACSmmbzriEtt";
const CHARGE_FEE_NO = "zxKpv8uiEmEhZJztC";
const KATIE_USER_ID = "cDdtciekpJx5GvTCv";
const KATIE_FIG_INBOX = process.env.APTLY_EMAIL_CHANNEL || "9be03003-b087-5ca4-8113-7ae86b89dfb7";
const CASSIDY = "cassidyj@freedominvestmentgroupinc.com";
const KATIE = "katie@freedominvestmentgroupinc.com";

// ---------- dates ----------

const pad = n => String(n).padStart(2, "0");
const ymd = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function periodFor(periodParam) {
  let y, m; // m is 0-based
  if (periodParam && /^\d{4}-\d{2}$/.test(periodParam)) {
    [y, m] = periodParam.split("-").map(Number); m -= 1;
  } else {
    const now = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
    y = now.getFullYear(); m = now.getMonth() - 1;
    if (m < 0) { m = 11; y -= 1; }
  }
  const start = new Date(Date.UTC(y, m, 1));
  const next = new Date(Date.UTC(y, m + 1, 1));
  return { start: ymd(start), next: ymd(next), billDate: ymd(next), label: `${MONTHS[m]} ${y}`, startDate: start };
}

const daysBetween = (a, b) => (new Date(b) - new Date(a)) / 86400000;
const money = n => "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const short = s => (s || "").slice(0, 10);

// ---------- Rent Manager ----------

async function rmLogin() {
  const user = process.env.RM_USERNAME, pass = process.env.RM_AUTOMATION_PASSWORD || process.env.RM_PASSWORD;
  if (!user || !pass) throw new Error("RM_USERNAME / RM_PASSWORD are not set in Netlify");
  const model = { Username: user, Password: pass };
  if (process.env.RM_LOCATION_ID) model.LocationID = Number(process.env.RM_LOCATION_ID);

  const auth = `${RM_BASE}/api/ExpressAuthentication/Authenticate`;
  const attempts = [
    { name: "json-body", url: auth, body: JSON.stringify(model) },
    { name: "query-model", url: `${auth}?authenticationModel=${encodeURIComponent(JSON.stringify(model))}`, body: "{}" }
  ];
  const diag = [];
  for (const a of attempts) {
    try {
      const res = await fetch(a.url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: a.body });
      const setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [res.headers.get("set-cookie")].filter(Boolean);
      const cookie = setCookies.map(c => c.split(";")[0]).join("; ");
      const text = await res.text();
      const headers = { Accept: "application/json" };
      if (cookie) headers.Cookie = cookie;
      const token = /^"[A-Za-z0-9\-_.]{20,}"$/.test(text.trim()) ? JSON.parse(text) : null;
      if (token) headers["X-RM12Api-ApiToken"] = token;
      const check = await fetch(`${RM_BASE}/api/Properties?pagesize=1&fields=PropertyID`, { headers });
      diag.push({ attempt: a.name, status: res.status, cookies: setCookies.length, token: !!token, check: check.status, reply: text.replace(/[A-Za-z0-9\-_.]{20,}/g, "[...]").slice(0, 160) });
      if (check.ok) return { headers, method: a.name, diag };
    } catch (e) {
      diag.push({ attempt: a.name, error: String(e.message || e).slice(0, 160) });
    }
  }
  const err = new Error("Rent Manager login failed");
  err.diag = diag;
  throw err;
}

function rmClient(session) {
  const call = async (method, path, body) => {
    const res = await fetch(`${RM_BASE}/api/${path}`, {
      method,
      headers: { ...session.headers, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`RM ${method} ${path.split("?")[0]} → ${res.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  };
  return { get: p => call("GET", p), post: (p, b) => call("POST", p, b) };
}

// ---------- Aptly ----------

async function aptlyApplicants() {
  const key = process.env.APTLY_LEASING_FEES_KEY;
  if (!key) return { ok: false, why: "APTLY_LEASING_FEES_KEY not set", cards: [] };
  const cards = [];
  const since = new Date(Date.now() - 200 * 86400000).toISOString();
  for (let page = 0; page < 20; page++) {
    const res = await fetch(`${APTLY_API}/api/board/${APPLICANTS_BOARD}/list`, {
      method: "POST",
      headers: { "x-token": key, "Content-Type": "application/json" },
      body: JSON.stringify({ page, pageSize: 500, includeArchived: true, updatedAtMin: since })
    });
    if (!res.ok) return { ok: false, why: `Aptly list → ${res.status}`, cards };
    const out = await res.json();
    cards.push(...(out.data || []));
    if ((page + 1) * (out.pageSize || 500) >= (out.count || 0)) break;
  }
  return { ok: true, cards };
}

const norm = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function findApplicantCard(cards, tenant, unitName) {
  const t = norm(tenant).split(" ");
  const last = t[t.length - 1], first = t[0];
  const u = norm(unitName);
  const matches = cards.filter(c => {
    const title = norm(c.name || c.Title || c.title);
    return title.includes(last) && title.includes(first);
  });
  return matches.find(c => u && norm(c.name || c.Title || c.title).includes(u)) || matches[0] || null;
}

const chargeFeeIsNo = card => {
  const v = card && card[CHARGE_FEE_FIELD];
  const val = Array.isArray(v) ? v[0] : v;
  return val === CHARGE_FEE_NO || /^no$/i.test(String(val || ""));
};

async function aptlyEmail({ subject, text }) {
  const key = process.env.APTLY_LEASING_FEES_KEY;
  if (!key) throw new Error("APTLY_LEASING_FEES_KEY not set; email not sent");
  const html = text.split("\n").map(l => l.replace(/&/g, "&amp;").replace(/</g, "&lt;")).join("<br>");
  const res = await fetch(`${APTLY_API}/api/email/send`, {
    method: "POST",
    headers: { "x-token": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      userId: KATIE_USER_ID, channelId: KATIE_FIG_INBOX,
      to: [{ value: CASSIDY }], cc: [{ value: KATIE }],
      subject, body: html, failOnCreateNewThread: false
    })
  });
  const out = await res.text();
  if (!res.ok) throw new Error(`Aptly email → ${res.status} ${out.slice(0, 200)}`);
  return true;
}

async function aptlyAlertKatie(subject, text) {
  const key = process.env.APTLY_LEASING_FEES_KEY;
  if (!key) return;
  await fetch(`${APTLY_API}/api/email/send`, {
    method: "POST",
    headers: { "x-token": key, "Content-Type": "application/json" },
    body: JSON.stringify({ userId: KATIE_USER_ID, channelId: KATIE_FIG_INBOX, to: [{ value: KATIE }], subject, body: text.replace(/\n/g, "<br>"), failOnCreateNewThread: false })
  }).catch(() => {});
}

// ---------- the run ----------

async function run({ period: periodParam, post = false, sendEmail = post } = {}) {
  const P = periodFor(periodParam);
  const session = await rmLogin();
  const rm = rmClient(session);

  const [props, chargeTypes] = await Promise.all([
    rm.get("Properties?fields=PropertyID,ShortName,Name&pagesize=5000"),
    rm.get("ChargeTypes?fields=ChargeTypeID,Name&pagesize=5000")
  ]);
  const PROP = Object.fromEntries(props.map(p => [p.PropertyID, p]));
  const RC_IDS = new Set(chargeTypes.filter(c => /^rc$/i.test(c.Name)).map(c => c.ChargeTypeID));
  const excluded = id => { const p = PROP[id]; return !!p && EXCLUDED.some(re => re.test(p.ShortName || "")); };
  const unitLabel = (propID, unitName) => {
    const pn = (PROP[propID] && PROP[propID].Name) || "";
    const un = String(unitName || "").trim();
    return un.toLowerCase().startsWith(pn.toLowerCase()) ? un : `${pn} - ${un}`;
  };

  // Existing leasing-fee bills (dedupe + already-ran check)
  const since = ymd(new Date(Date.UTC(P.startDate.getUTCFullYear() - 1, P.startDate.getUTCMonth(), 1)));
  const bills = await rm.get(`Bills?filters=AccountID,eq,${VENDOR_ID};PostDate,ge,${since}&embeds=BillDetails&pagesize=5000`);
  const already = { renewal: null, movein: null };
  const details = [];
  for (const b of bills) {
    if ((b.Comment || "").endsWith(`- ${P.label}`)) {
      if (/renewal/i.test(b.Comment)) already.renewal = b.ID; else already.movein = b.ID;
    }
    for (const d of b.BillDetails || []) details.push({ bill: b.ID, post: short(b.PostDate), unit: d.UnitID, prop: d.PropertyID, comment: d.Comment || "" });
  }
  if (post && (already.renewal || already.movein)) {
    // A bill for this month already exists; never post or email twice.
    return { period: P.label, alreadyRan: true, existing: already, login: session.method };
  }
  // Most recent earlier leasing-fee line for this unit/tenant of the same kind, if any.
  const billedBefore = (kind, propID, unitID, unitName, tenant) => details.filter(d => {
    const isRenewal = /renewal/i.test(d.comment);
    if ((kind === "renewal") !== isRenewal) return false;
    if (unitID > 0 && d.unit === unitID) return true;
    const c = norm(d.comment);
    if (tenant && c.includes(norm(tenant))) return true;
    return d.prop === propID && unitName && c.includes(norm(unitName));
  }).sort((a, b) => (a.post < b.post ? 1 : -1))[0];

  const renewals = [], moveIns = [], flagged = [], skipped = [];

  // 1. Renewals
  const terms = await rm.get(`LeaseRenewals?filters=CreateDate,ge,${P.start};CreateDate,lt,${P.next}&embeds=ParentLease,ParentLease.Tenant,Unit&pagesize=2000`);
  const parentIDs = [...new Set(terms.map(t => t.ParentLeaseID))];
  const siblings = parentIDs.length
    ? await rm.get(`LeaseRenewals?filters=ParentLeaseID,in,(${parentIDs.join(",")})&fields=LeaseRenewalID,ParentLeaseID,StartDate&pagesize=10000`)
    : [];
  for (const t of terms) {
    const L = t.ParentLease || {};
    const earlier = siblings.some(x => x.ParentLeaseID === t.ParentLeaseID && x.LeaseRenewalID !== t.LeaseRenewalID && x.StartDate && t.StartDate && x.StartDate < t.StartDate);
    if (!earlier) continue; // first term of a new lease → move-in, handled below
    const tenant = (L.Tenant && L.Tenant.Name) || "";
    const unitName = (t.Unit && t.Unit.Name) || "";
    const where = unitLabel(L.PropertyID, unitName);
    const row = { kind: "renewal", propID: L.PropertyID, unitID: t.UnitID, where, tenant, term: `${short(t.StartDate)} to ${short(t.EndDate) || "open"}`, amount: RENEWAL_FEE };
    if (excluded(L.PropertyID)) { skipped.push({ ...row, why: "excluded property" }); continue; }
    const dup = billedBefore("renewal", L.PropertyID, t.UnitID, unitName, tenant);
    if (dup && daysBetween(dup.post, P.start) <= 330) { skipped.push({ ...row, why: `already billed on #${dup.bill} (${dup.post})` }); continue; }
    if (L.MoveOutDate && t.StartDate && L.MoveOutDate < t.StartDate) { skipped.push({ ...row, why: `tenant moved out ${short(L.MoveOutDate)}` }); continue; }
    if (t.StartDate && daysBetween(t.StartDate, P.start) > 90) { flagged.push({ ...row, why: `new term started ${short(t.StartDate)}, more than 90 days before ${P.label}` }); continue; }
    renewals.push(row);
  }

  // 2. Move-ins
  const leases = await rm.get(`Leases?filters=MoveInDate,ge,${P.start};MoveInDate,lt,${P.next}&embeds=Tenant,Unit&pagesize=2000`);
  const [aptly, charges] = await Promise.all([
    aptlyApplicants().catch(e => ({ ok: false, why: String(e.message || e), cards: [] })),
    Promise.all(leases.map(L => excluded(L.PropertyID) ? [] : rm.get(`Tenants/${L.TenantID}/RecurringCharges`).catch(() => [])))
  ]);
  for (const [i, L] of leases.entries()) {
    const tenant = (L.Tenant && L.Tenant.Name) || "";
    const unitName = (L.Unit && L.Unit.Name) || "";
    const where = unitLabel(L.PropertyID, unitName);
    const base = { kind: "movein", propID: L.PropertyID, unitID: L.UnitID, where, tenant, moveIn: short(L.MoveInDate) };
    if (excluded(L.PropertyID)) { skipped.push({ ...base, why: "excluded property" }); continue; }
    const dup = billedBefore("movein", L.PropertyID, L.UnitID, unitName, tenant);
    if (dup && daysBetween(dup.post, L.MoveInDate) < 180) { skipped.push({ ...base, why: `already billed on #${dup.bill} (${dup.post})` }); continue; }
    const rcs = charges[i];
    const rc = (rcs || []).find(c => RC_IDS.has(c.ChargeTypeID) && (c.UnitID === L.UnitID || c.UnitID <= 0));
    if (!rc) { flagged.push({ ...base, why: "no monthly rent (RC) charge in RM" }); continue; }
    const row = { ...base, rent: rc.Amount, amount: Math.round(rc.Amount * MOVE_IN_RATE * 100) / 100 };
    if (L.MoveOutDate && daysBetween(L.MoveInDate, L.MoveOutDate) <= 30) { flagged.push({ ...row, why: `RM shows a move-out on ${short(L.MoveOutDate)}` }); continue; }
    if (aptly.ok) {
      const card = findApplicantCard(aptly.cards, tenant, unitName);
      if (!card) { flagged.push({ ...row, why: "no Aptly Applicants card found" }); continue; }
      if (chargeFeeIsNo(card)) { skipped.push({ ...row, why: "Aptly: Charge Leasing Fee = No" }); continue; }
    }
    moveIns.push(row);
  }

  // 3. Bills
  const D = `${P.billDate}T00:00:00`;
  const makeBill = (comment, rows, lineText) => ({
    AccountID: VENDOR_ID, AccountType: 8, PayeeName: "", Reference: "", Comment: comment,
    Amount: Math.round(rows.reduce((s, r) => s + r.amount, 0) * 100) / 100,
    TransactionDate: D, PostDate: D, DueDate: D, TermID: -1, BankID: BANK_ID, PayMethod: 0, IsApproved: false,
    BillDetails: rows.map((r, i) => ({ PostDate: D, PropertyID: r.propID, UnitID: r.unitID, Is1099: false, Amount: r.amount, GLAccountID: GL_ID, Comment: lineText(r), SortOrder: i + 1, IsBillable: false, Markup: 0 }))
  });
  const plans = [
    { key: "renewal", rows: renewals, bill: makeBill(`Lease Renewal Fees - ${P.label}`, renewals, r => `Lease Renewal Fee for ${r.where} (${r.tenant})`) },
    { key: "movein", rows: moveIns, bill: makeBill(`Leasing Fees (Move-Ins) - ${P.label}`, moveIns, r => `Leasing Fee for ${r.where} (${r.tenant}, 50% of ${money(r.rent)})`) }
  ];

  const created = {};
  for (const p of plans) {
    if (already[p.key]) { created[p.key] = { id: already[p.key], existing: true }; continue; }
    if (!p.rows.length || !post) continue;
    const out = await rm.post("Bills", [p.bill]);
    const id = out && out[0] && out[0].ID;
    const check = await rm.get(`Bills/${id}?embeds=BillDetails`);
    const ok = check && check.AccountID === VENDOR_ID && check.BankID === BANK_ID && (check.BillDetails || []).length === p.rows.length && Math.abs(check.Amount - p.bill.Amount) < 0.01;
    if (!ok) throw new Error(`Bill #${id} did not verify after posting; check it in RM`);
    created[p.key] = { id, amount: check.Amount };
  }

  // 4. Email
  const total = rows => money(rows.reduce((s, r) => s + r.amount, 0));
  const billRef = k => created[k] ? `#${created[k].id}${created[k].existing ? " (already existed)" : ""}` : (post ? "(none)" : "(dry run)");
  const lines = [];
  lines.push("Hi Cassidy,", "");
  lines.push(`The ${P.label} owner leasing and renewal fee bills are in Rent Manager for your review (FIG LEASING FEE, dated ${P.billDate}, Wilson Owner Trust, GL 5001). No tenant charges were posted. Let Katie know if anything should change.`, "");
  lines.push(`RENEWAL BILL ${billRef("renewal")}: ${total(renewals)} ($250 each)`);
  renewals.forEach((r, i) => lines.push(`${i + 1}. ${r.where} | ${r.tenant} | ${r.term}`));
  if (!renewals.length) lines.push("None this month.");
  lines.push("", `MOVE-IN BILL ${billRef("movein")}: ${total(moveIns)} (50% of monthly rent)`);
  moveIns.forEach((r, i) => lines.push(`${i + 1}. ${r.where} | ${r.tenant} | moved in ${r.moveIn} | rent ${money(r.rent)} | ${money(r.amount)}`));
  if (!moveIns.length) lines.push("None this month.");
  if (flagged.length) {
    lines.push("", "NEEDS REVIEW (not billed)");
    flagged.forEach(r => lines.push(`- ${r.where} (${r.tenant}): ${r.why}${r.amount ? `; would be ${money(r.amount)}` : ""}`));
  }
  const notExcluded = skipped.filter(s => s.why !== "excluded property");
  const excludedCount = skipped.length - notExcluded.length;
  if (skipped.length) {
    lines.push("", "SKIPPED");
    notExcluded.forEach(r => lines.push(`- ${r.where} (${r.tenant}): ${r.why}`));
    if (excludedCount) lines.push(`- ${excludedCount} at Second Creek / Trailblazer (never charged)`);
  }
  if (!aptly.ok) lines.push("", `Note: Aptly couldn't be checked for Charge Leasing Fee (${aptly.why}), so move-ins were billed without that check.`);
  lines.push("", "Thanks,", "Katie");
  const subject = `Leasing & Renewal Fee Bills – ${P.label} (Renewals ${billRef("renewal")} ${total(renewals)}, Move-ins ${billRef("movein")} ${total(moveIns)})`;
  const text = lines.join("\n");

  let emailed = false;
  if (sendEmail && (created.renewal || created.movein || flagged.length)) emailed = await aptlyEmail({ subject, text });

  return { period: P.label, billDate: P.billDate, posted: post, login: session.method, created, renewals, moveIns, flagged, skipped, aptlyChecked: aptly.ok, emailed, subject, text };
}

module.exports = { run, rmLogin, aptlyAlertKatie, periodFor };
