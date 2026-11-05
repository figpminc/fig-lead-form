// Called by the Aptly automation when Create Turn Project is checked on a Make Ready card.
// For each issue picked in Turn Issues Needed, it creates a Rent Manager issue and a matching
// Turn Work Orders card right away, so nobody waits for the overnight sync. The RM issue number is
// saved on the card. A comment on the Make Ready card reports the result and blocks a second run.
//
//   POST /.netlify/functions/turn-project?key=<hook key>&card=<id>         create the project
//   GET  /.netlify/functions/turn-project?key=<secret>&card=<id>&dry=1     shows the plan; changes nothing
//   GET  /.netlify/functions/turn-project?key=<secret>&mode=rminfo&issue=<id>  RM statuses and one issue; changes nothing
//
// Env vars: VENDOR_WEBHOOK_KEY, APTLY_VENDOR_KEY, RM_USERNAME, RM_AUTOMATION_PASSWORD

const crypto = require("crypto");
const { rmLogin } = require("../lib/leasing-fees-core");

const API = "https://core-api.getaptly.com";
const RM_BASE = process.env.RM_BASE_URL || "https://figpm.rmx.rentmanager.com";
const MAKE_READY = "MoXvCc5Ee9YyrYEpF";
const TURN_WO = "uYi6ZiD2WBu3ewPbx";
const COMMENT_USER = "cDdtciekpJx5GvTCv";
const MAINTENANCE_ADMIN = "udA4AurEsheRDJm8C";
const MAINTENANCE_ADMIN_RM_USER = 13;
const STATUS_NEW = 2;
const CATEGORY_TURNOVER = 15;
const MARKER = "Turn project";

const MR = { issuesNeeded: "QWsh3D2x5mfu86S4h", createProject: "rsMuAAqpwa44Ds7Q3", unit: "jqqnyPoY56AWzQjxk", building: "g9H2d86wZCropbHSj", lease: "G6BKdnweeTyjbef4u" };
const WO = { issueId: "QBLnTaXCbaCqJs7co", category: "r5pES4msj8YaC7wPJ", unit: "jW5Lvy4xhM6TJfuRe", building: "TKdovRPB9xJfYaP78", lease: "X5Et2msLcSY4QDNLu" };

// Same order and due-date offsets as the Turn - Standard template in Rent Manager.
const ISSUES = [
  { title: "Move Out Inspection", days: 2, text: "Complete move out inspection in zInspector." },
  { title: "Lock Change", days: 2, text: "Change locks after move out." },
  { title: "Clean Out", days: 2, text: "Remove items and trash left in unit." },
  { title: "Floor Scan", days: 2, text: "Floor plan scan of unit." },
  { title: "Make Ready Repairs", days: 5, text: "Turn work per the approved scope. Update the due date once the vendor accepts." },
  { title: "Completion Inspection", days: 7, text: "Inspect unit after turn work is done (zInspector). Cleaning starts after the Maintenance Admin approves." },
  { title: "Clean to Be Rent Ready", days: 9, text: "Final clean and listing pictures." }
];

const json = (statusCode, body) => ({ statusCode, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(body) });

async function aptly(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json", "x-token": process.env.APTLY_VENDOR_KEY },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Aptly ${path.split("/").slice(0, 4).join("/")} returned ${res.status}: ${text.slice(0, 200)}`);
  const parsed = text ? JSON.parse(text) : {};
  return parsed.data !== undefined ? parsed.data : parsed;
}

const comment = (cardId, content) => aptly(`/api/board/${MAKE_READY}/${cardId}/comment`, { userId: COMMENT_USER, content });

function cardIdFrom(event) {
  const q = event.queryStringParameters || {};
  if (q.card) return q.card;
  const raw = event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString() : event.body;
  let b = {};
  try { b = JSON.parse(raw || "{}"); } catch (e) { return null; }
  const id = b.cardId || b._id || b.id || b.instanceId || (b.card && (b.card.cardId || b.card._id)) || (b.data && (b.data.cardId || b.data._id));
  return typeof id === "string" ? id : null;
}

async function rmGet(session, path) {
  const res = await fetch(`${RM_BASE}/api/${path}`, { headers: session.headers });
  const text = await res.text();
  if (!res.ok) throw new Error(`Rent Manager GET ${path.split("?")[0]} returned ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

async function createRmIssue(session, issue) {
  const res = await fetch(`${RM_BASE}/api/ServiceManagerIssues?embeds=ServiceManagerIssueLinkedProperties,ServiceManagerIssueLinkedUnits`, {
    method: "POST",
    headers: { ...session.headers, "Content-Type": "application/json" },
    body: JSON.stringify([issue])
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Rent Manager returned ${res.status}: ${text.slice(0, 300)}`);
  const parsed = JSON.parse(text);
  return (Array.isArray(parsed) ? parsed[0] : parsed).ServiceManagerIssueID;
}

function dueDate(days) {
  const d = new Date(Date.now() + days * 86400000);
  return `${d.toLocaleDateString("en-CA", { timeZone: "America/New_York" })}T12:00:00`;
}

const links = v => (Array.isArray(v) ? v : []).filter(x => x && x._id).map(x => ({ _id: x._id, name: x.name }));

function plan(card) {
  const picked = new Set((Array.isArray(card[MR.issuesNeeded]) ? card[MR.issuesNeeded] : []).map(String));
  return ISSUES.filter(i => picked.has(i.title));
}

async function run(cardId, dry) {
  const card = await aptly(`/api/board/${MAKE_READY}/${cardId}`);
  const issues = plan(card);
  const unitLink = links(card[MR.unit])[0];
  if (!unitLink) throw new Error("This Make Ready card has no Unit");
  const unitCard = await aptly(`/api/board/unit/${unitLink._id}`);
  const rmUnitId = Number(unitCard.rentmanagerId);
  if (!rmUnitId) throw new Error(`Unit ${unitLink.name} has no Rent Manager ID`);

  const session = await rmLogin();
  const rmUnit = await rmGet(session, `Units/${rmUnitId}?fields=UnitID,PropertyID,Name`);
  const comments = await aptly(`/api/board/${MAKE_READY}/${cardId}/comments`);
  const list = Array.isArray(comments) ? comments : comments.comments || [];
  const already = list.some(c => String(c.content || "").includes(MARKER));
  const summary = { card: card.name, createChecked: card[MR.createProject] === true, unit: unitLink.name, rmUnit, issues: issues.map(i => i.title), already };
  if (dry) return { dry: true, ...summary };
  if (already) return { skipped: "A project was already created for this card", ...summary };
  if (card[MR.createProject] !== true) return { skipped: "Create Turn Project is not checked", ...summary };
  if (!issues.length) {
    await comment(cardId, `${MARKER} NOT created: no issues were picked in Turn Issues Needed. Ask an admin to re-run it after picking them.`);
    return { skipped: "No issues picked", ...summary };
  }

  const created = [];
  try {
    for (const i of issues) {
      const rmId = await createRmIssue(session, {
        Title: i.title,
        Description: i.text,
        CategoryID: CATEGORY_TURNOVER,
        StatusID: STATUS_NEW,
        AssignedToUserID: MAINTENANCE_ADMIN_RM_USER,
        DueDate: dueDate(i.days),
        ServiceManagerIssueLinkedProperties: [{ PropertyID: rmUnit.PropertyID }],
        ServiceManagerIssueLinkedUnits: [{ UnitID: rmUnitId }]
      });
      const entry = { title: i.title, rmId };
      created.push(entry);
      const made = await aptly(`/api/board/${TURN_WO}`, {
        name: i.title,
        stage: "New",
        description: i.text,
        assignee: MAINTENANCE_ADMIN,
        dueAt: `${dueDate(i.days)}.000Z`,
        [WO.issueId]: String(rmId),
        [WO.category]: "Turnover",
        [WO.unit]: [unitLink],
        [WO.building]: links(card[MR.building]),
        [WO.lease]: links(card[MR.lease])
      });
      entry.cardId = made && (made._id || made.cardId || made.id);
    }
  } catch (e) {
    const done = created.map(c => `${c.title} (RM #${c.rmId}${c.cardId ? "" : ", no Aptly card"})`).join(", ") || "nothing";
    await comment(cardId, `${MARKER} FAILED partway. Created so far: ${done}. Error: ${String(e.message || e).slice(0, 300)}`);
    throw e;
  }
  await comment(cardId, `${MARKER} created: ${created.map(c => `${c.title} (RM #${c.rmId})`).join(", ")}. See the Turn Work Orders board.`);
  return { created, ...summary };
}

exports.handler = async function (event) {
  const q = event.queryStringParameters || {};
  const secret = process.env.VENDOR_WEBHOOK_KEY;
  // The Aptly automation holds a key derived from the secret, so its URL only opens this function.
  const hookKey = secret && crypto.createHash("sha256").update(`${secret}:turn-project`).digest("hex");
  if (!secret || (q.key !== secret && q.key !== hookKey)) return json(401, { error: "Unauthorized" });
  try {
    if (q.mode === "rminfo") {
      const session = await rmLogin();
      const statuses = await rmGet(session, "ServiceManagerStatuses?fields=ServiceManagerStatusID,Name,IsClosed");
      const issue = q.issue ? await rmGet(session, `ServiceManagerIssues/${Number(q.issue)}`) : null;
      return json(200, { statuses, issue });
    }
    const dry = q.dry === "1";
    if (!dry && event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });
    const cardId = cardIdFrom(event);
    if (!cardId) return json(400, { error: "No card id" });
    return json(200, await run(cardId, dry));
  } catch (e) {
    return json(500, { error: String(e.message || e) });
  }
};
