// Weekly Ninety scorecard fill for FIG Property Management (Julia's make ready + maintenance metrics).
//
// For the last full Ninety week (Mon–Sun, Eastern), computes:
//   Number of Turns Complete          Make Ready cards whose Make Ready Complete Date falls in the week
//   Avg # of Days for Make Ready      those cards: Mirror Move-Out Date → Make Ready Complete Date
//   Make Ready under 3 weeks (%)      share of those cards at 21 days or less
//   Avg # of Days for Turn            those cards: Turn Work Start Date → Turn Work Complete Date
//   Maintenance Survey Rating (30d)   average Process Rating on Maintenance cards closed in the 30 days ending that Sunday
//   Vendor NPS                        Retently vendor campaign, responses in the RETENTLY_WINDOW_DAYS ending that Sunday
//
// Definitions agreed with Katie 11/13/2026: Aptly is the source going forward (not Meld).
// Chat messages per Meld and median repair speed stay manual. "% internal turns not billed" was archived 11/13.
//
// Writes to Ninety only when NINETY_WRITE=true (otherwise report-only: computes and emails the numbers).
//
// Env vars:
//   NINETY_TOKEN              Ninety Personal Access Token (User Settings → Developer Settings)
//   NINETY_WRITE              "true" to write scores; anything else = report only
//   APTLY_SCORECARD_KEY       Aptly API key that covers the Make Ready and Maintenance boards
//   RETENTLY_API_KEY          Retently API key (read permission is enough)
//   RETENTLY_VENDOR_CAMPAIGN  Retently campaign id for the vendor survey
//   RETENTLY_WINDOW_DAYS      optional, default 90
//   SCORECARD_KEY             shared secret for the manual/dry-run URL

const APTLY_API = "https://core-api.getaptly.com";
const NINETY_API = "https://api.public.ninety.io/v1";
const RETENTLY_API = "https://app.retently.com/api/v2";

const MAKE_READY_BOARD = "MoXvCc5Ee9YyrYEpF";
const MAINTENANCE_BOARD = "naaJQQsf9PmFgGKSS";

const F = {
  stage: ["stage", "Stage"],
  moveOut: ["k2csDQLcSosroQWmH", "Mirror Move-Out Date"],
  mrComplete: ["oG75NFwirdzgncmpY", "Make Ready Complete Date"],
  turnStart: ["rSTf94pbZrAkf4jyp", "Turn Work Start Date"],
  turnComplete: ["ZSpAtD7qGZ8E3eNJd", "Turn Work Complete Date"],
  processRating: ["W7rSmLPpsM5zgNrrx", "Process Rating"],
  vendorRating: ["Rj2mZkiFLd2coGxHG", "Vendor Rating"],
  closedDate: ["closedAt", "closedDate", "Closed Date"],
  title: ["name", "Title", "title"]
};
const STAGE_COMPLETE = ["A2s2LuRP6iSQAMENk", "Complete"];
const STAGE_CANCELLED = ["J7inNkRzhqPbpPsgT", "Cancelled"];

// Ninety Measurables. Each id is checked against its title before anything is written.
const KPI = {
  turnsComplete: { id: "6a1f0ac442d5a87ae87f0b47", title: "Number of Turns Complete" },
  makeReadyDays: { id: "69c6a090386fa68ae03fcfb5", title: "EXCELLENCE - Avg # of Days for Make Ready" },
  under3Weeks: { id: "697e99916282efce92b097b2", title: "EXCELLENCE - Make Ready completed under 3 weeks 95% of time (weekly)" },
  turnDays: { id: "6a7f300c4bf39540432c89aa", title: "EXCELLENCE - Avg # of Days for Turn" },
  surveyRating: { id: "65bc0a9d81872d0011baa993", title: "HOSPITALITY - Maintenance Survey Rating from last 30 days (Weekly)" },
  vendorNps: { id: "697e88516282efce92b06e5d", title: "HOSPITALITY - Vendor NPS Survey (Weekly)" }
};

const KATIE_USER_ID = "cDdtciekpJx5GvTCv";
const KATIE_FIG_INBOX = process.env.APTLY_EMAIL_CHANNEL || "9be03003-b087-5ca4-8113-7ae86b89dfb7";
const KATIE = "katie@freedominvestmentgroupinc.com";

// ---------- dates (Eastern) ----------

const etDate = iso => {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d)) return null;
  return d.toLocaleDateString("en-CA", { timeZone: "America/New_York" }); // YYYY-MM-DD
};
const addDays = (ymd, n) => { const d = new Date(ymd + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dayDiff = (a, b) => Math.round((new Date(b + "T12:00:00Z") - new Date(a + "T12:00:00Z")) / 86400000);

// Last full Mon–Sun week before today (ET), or the week containing ?week=YYYY-MM-DD.
function weekFor(weekParam) {
  let anchor;
  if (weekParam && /^\d{4}-\d{2}-\d{2}$/.test(weekParam)) anchor = weekParam;
  else anchor = addDays(etDate(new Date().toISOString()), -7);
  const dow = new Date(anchor + "T12:00:00Z").getUTCDay(); // 0 Sun..6 Sat
  const monday = addDays(anchor, -((dow + 6) % 7));
  return { start: monday, end: addDays(monday, 6), label: `${monday} to ${addDays(monday, 6)}` };
}

// ---------- helpers ----------

function val(card, keys) {
  for (const k of keys) {
    let v = card[k];
    if (v === undefined && card.fields) v = card.fields[k];
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) v = v[0];
    if (v && typeof v === "object") v = v.value ?? v.label ?? v.uuid ?? v.date ?? v;
    return v;
  }
  return null;
}
const stageIs = (card, ids) => ids.includes(String(val(card, F.stage) || ""));
const num = v => (v === null || v === undefined || v === "" || isNaN(Number(v)) ? null : Number(v));
const avg = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const round = (x, d = 2) => (x === null ? null : Math.round(x * 10 ** d) / 10 ** d);

// ---------- Aptly ----------

async function aptlyCards(boardId, sinceDays) {
  const key = process.env.APTLY_SCORECARD_KEY;
  if (!key) throw new Error("APTLY_SCORECARD_KEY not set");
  const cards = [];
  const since = new Date(Date.now() - sinceDays * 86400000).toISOString();
  for (let page = 0; page < 40; page++) {
    const res = await fetch(`${APTLY_API}/api/board/${boardId}/list`, {
      method: "POST",
      headers: { "x-token": key, "Content-Type": "application/json" },
      body: JSON.stringify({ page, pageSize: 500, includeArchived: true, updatedAtMin: since })
    });
    if (!res.ok) throw new Error(`Aptly list ${boardId} → ${res.status} ${(await res.text()).slice(0, 200)}`);
    const out = await res.json();
    cards.push(...(out.data || []));
    if ((page + 1) * (out.pageSize || 500) >= (out.count || 0)) break;
  }
  return cards;
}

function makeReadyMetrics(cards, wk) {
  const done = [];
  const flags = [];
  for (const c of cards) {
    if (stageIs(c, STAGE_CANCELLED)) continue;
    const complete = etDate(val(c, F.mrComplete));
    if (!complete || complete < wk.start || complete > wk.end) continue;
    const title = val(c, F.title) || c._id;
    const moveOut = etDate(val(c, F.moveOut));
    const ts = etDate(val(c, F.turnStart));
    const tc = etDate(val(c, F.turnComplete));
    const row = { title, moveOut, complete, makeReadyDays: moveOut ? dayDiff(moveOut, complete) : null, turnStart: ts, turnComplete: tc, turnDays: ts && tc ? dayDiff(ts, tc) : null };
    if (!moveOut) flags.push(`${title}: no Mirror Move-Out Date, left out of the make ready averages`);
    if (row.turnDays === null) flags.push(`${title}: turn work start/complete date missing, left out of Avg Days for Turn`);
    else if (row.turnDays === 0) flags.push(`${title}: turn work started and completed the same day (0 days), counted as 0`);
    if (!stageIs(c, STAGE_COMPLETE)) flags.push(`${title}: has a Make Ready Complete Date but is in stage "${val(c, F.stage)}"`);
    done.push(row);
  }
  const mr = done.map(r => r.makeReadyDays).filter(x => x !== null);
  const td = done.map(r => r.turnDays).filter(x => x !== null);
  return {
    turnsComplete: done.length,
    makeReadyDays: round(avg(mr)),
    under3Weeks: mr.length ? round((100 * mr.filter(x => x <= 21).length) / mr.length) : null,
    turnDays: round(avg(td)),
    rows: done,
    flags
  };
}

function surveyMetrics(cards, wk) {
  const from = addDays(wk.end, -29);
  const rows = [];
  for (const c of cards) {
    const p = num(val(c, F.processRating));
    if (p === null) continue;
    const closed = etDate(val(c, F.closedDate));
    if (!closed || closed < from || closed > wk.end) continue;
    rows.push({ title: val(c, F.title) || c._id, closed, process: p, vendor: num(val(c, F.vendorRating)) });
  }
  return {
    window: `${from} to ${wk.end}`,
    responses: rows.length,
    processRating: round(avg(rows.map(r => r.process))),
    vendorRating: round(avg(rows.map(r => r.vendor).filter(x => x !== null))),
    rows
  };
}

// ---------- Retently ----------

async function vendorNps(wk) {
  const key = process.env.RETENTLY_API_KEY;
  const campaign = process.env.RETENTLY_VENDOR_CAMPAIGN;
  if (!key || !campaign) return { ok: false, why: "RETENTLY_API_KEY / RETENTLY_VENDOR_CAMPAIGN not set" };
  const days = Number(process.env.RETENTLY_WINDOW_DAYS || 90);
  const start = addDays(wk.end, -(days - 1));
  const scores = [];
  for (let page = 1; page <= 20; page++) {
    const qs = new URLSearchParams({ page: String(page), limit: "1000", campaignId: campaign, startDate: start, endDate: `${wk.end}T23:59:59.999Z` });
    const res = await fetch(`${RETENTLY_API}/feedback?${qs}`, { headers: { "X-Api-Key": key } });
    if (!res.ok) return { ok: false, why: `Retently feedback → ${res.status} ${(await res.text()).slice(0, 200)}` };
    const out = await res.json();
    const list = out?.data?.responses || out?.data?.feedback || (Array.isArray(out?.data) ? out.data : null) || out?.responses || [];
    for (const r of list) { const s = num(r.score ?? r.rating ?? r.value); if (s !== null) scores.push(s); }
    const pages = out?.data?.pages ?? out?.pages ?? 1;
    if (page >= pages || !list.length) break;
  }
  if (!scores.length) return { ok: true, responses: 0, nps: null, window: `${start} to ${wk.end}` };
  const promoters = scores.filter(s => s >= 9).length, detractors = scores.filter(s => s <= 6).length;
  return { ok: true, responses: scores.length, nps: Math.round((100 * (promoters - detractors)) / scores.length), window: `${start} to ${wk.end}` };
}

// ---------- Ninety ----------

async function ninety(method, path, body) {
  const token = process.env.NINETY_TOKEN;
  if (!token) throw new Error("NINETY_TOKEN not set");
  const res = await fetch(`${NINETY_API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Ninety ${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

// Confirms every KPI id still points at the metric we expect (titles can be renamed; ids can be wrong).
async function checkKpis() {
  const found = {};
  let nextToken;
  for (let i = 0; i < 20; i++) {
    const qs = new URLSearchParams({ limit: "100" });
    if (nextToken) qs.set("nextToken", nextToken);
    const out = await ninety("GET", `/scorecard/kpis/company?${qs}`);
    for (const k of out.items || out.data || []) found[k.id || k._id] = k.title || k.name;
    nextToken = out.pagination?.nextToken;
    if (!nextToken) break;
  }
  return Object.entries(KPI).map(([key, k]) => ({ key, id: k.id, expected: k.title, actual: found[k.id] || null, ok: (found[k.id] || "").trim() === k.title }));
}

// ---------- run ----------

async function run({ week, write = process.env.NINETY_WRITE === "true", sendEmail = true } = {}) {
  const wk = weekFor(week);
  const [mrCards, mxCards] = await Promise.all([aptlyCards(MAKE_READY_BOARD, 400), aptlyCards(MAINTENANCE_BOARD, 120)]);
  const mr = makeReadyMetrics(mrCards, wk);
  const sv = surveyMetrics(mxCards, wk);
  const nps = await vendorNps(wk).catch(e => ({ ok: false, why: String(e.message || e) }));

  const values = {
    turnsComplete: mr.turnsComplete,
    makeReadyDays: mr.makeReadyDays,
    under3Weeks: mr.under3Weeks,
    turnDays: mr.turnDays,
    surveyRating: sv.processRating,
    vendorNps: nps.ok ? nps.nps : null
  };

  let kpiCheck = null, written = null;
  if (write) {
    kpiCheck = await checkKpis();
    const bad = kpiCheck.filter(k => !k.ok);
    if (bad.length) throw new Error(`Ninety metric id/title mismatch, nothing written: ${bad.map(b => `${b.key} expected "${b.expected}" got "${b.actual}"`).join("; ")}`);
    const items = Object.entries(values).filter(([, v]) => v !== null).map(([k, v]) => ({ kpiId: KPI[k].id, periodStartDate: wk.start, value: v }));
    if (items.length) {
      const out = await ninety("POST", "/scorecard/scores/batch", { items });
      written = out;
      const failed = (out.results || []).filter(r => r.status !== "written");
      if (failed.length) mr.flags.push(`Ninety refused ${failed.length} score(s): ${failed.map(f => `${f.kpiId} ${f.error?.message || ""}`).join("; ")}`);
    }
  }

  const label = { turnsComplete: "Number of Turns Complete", makeReadyDays: "Avg # of Days for Make Ready", under3Weeks: "Make Ready completed under 3 weeks (%)", turnDays: "Avg # of Days for Turn", surveyRating: "Maintenance Survey Rating (last 30 days)", vendorNps: "Vendor NPS" };
  const lines = [
    `Ninety scorecard — week of ${wk.label}`,
    write ? "These numbers were written to Ninety." : "REPORT ONLY: nothing was written to Ninety.",
    "",
    ...Object.entries(values).map(([k, v]) => `${label[k]}: ${v === null ? "(no data)" : v}`),
    "",
    `Turns completed this week (${mr.rows.length}):`,
    ...(mr.rows.length ? mr.rows.map(r => `  ${r.title}: move-out ${r.moveOut || "?"} → complete ${r.complete} = ${r.makeReadyDays ?? "?"} days; turn work ${r.turnDays ?? "?"} days`) : ["  none"]),
    "",
    `Maintenance surveys ${sv.window}: ${sv.responses} response(s); avg process ${sv.processRating ?? "-"}, avg vendor ${sv.vendorRating ?? "-"}`,
    `Vendor NPS: ${nps.ok ? `${nps.nps ?? "-"} from ${nps.responses} response(s), ${nps.window}` : `not checked (${nps.why})`}`
  ];
  if (mr.flags.length) lines.push("", "Check these:", ...mr.flags.map(f => `  - ${f}`));
  const subject = `${write ? "" : "[Report only] "}Ninety scorecard — week of ${wk.start}`;
  const text = lines.join("\n");

  let emailed = false;
  if (sendEmail) emailed = await aptlyEmail({ to: KATIE, subject, text }).then(() => true).catch(() => false);
  return { week: wk, write, values, makeReady: mr, surveys: sv, vendorNps: nps, kpiCheck, written, emailed, subject, text };
}

async function aptlyEmail({ to, subject, text }) {
  const key = process.env.APTLY_SCORECARD_KEY;
  if (!key) throw new Error("APTLY_SCORECARD_KEY not set");
  const html = text.split("\n").map(l => l.replace(/&/g, "&amp;").replace(/</g, "&lt;")).join("<br>");
  const res = await fetch(`${APTLY_API}/api/email/send`, {
    method: "POST",
    headers: { "x-token": key, "Content-Type": "application/json" },
    body: JSON.stringify({ userId: KATIE_USER_ID, channelId: KATIE_FIG_INBOX, to: [{ value: to }], subject, body: html, failOnCreateNewThread: false })
  });
  if (!res.ok) throw new Error(`Aptly email → ${res.status}`);
}

module.exports = { run, checkKpis, weekFor, makeReadyMetrics, surveyMetrics, aptlyEmail, KATIE };
