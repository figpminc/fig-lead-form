// Test only: copy a file Charlie attached to a Rent Manager issue onto a Maintenance card.
//
//   /.netlify/functions/issue-files-test?key=<KEY>&issue=6012                         list the issue's attachments
//   /.netlify/functions/issue-files-test?key=<KEY>&issue=6012&card=<cardId>&file=1    copy attachment 1 to the card
//
// Files sit on the issue's History notes. /api/HistoryView/Detail gives each file's Token, and
// /api/Download?token=<Token> serves it. Aptly takes uploads at POST /api/board/{id}/{cardId}/file.

const { rmLogin } = require("../lib/leasing-fees-core");
const { secret } = require("../lib/ruby-match-core");

const RM_BASE = process.env.RM_BASE_URL || "https://figpm.rmx.rentmanager.com";
const APTLY_API = "https://core-api.getaptly.com";
const MX = "naaJQQsf9PmFgGKSS";

const json = (statusCode, body) => ({ statusCode, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(body, null, 2) });

async function rmJson(session, path) {
  const res = await fetch(`${RM_BASE}/api/${path}`, { headers: session.headers });
  const text = await res.text();
  if (!res.ok) throw new Error(`Rent Manager ${path.split("?")[0]} returned ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

async function attachments(session, issue) {
  const data = await rmJson(session, `ServiceManagerIssues/${issue}?embeds=History`);
  const out = [];
  for (const h of (data.History || []).filter(x => x.HasAttachment)) {
    const detail = await rmJson(session, `HistoryView/Detail?historyID=${h.HistoryID}&historyType=${h.HistoryType}&entityType=${h.EntityType}`);
    for (const a of detail.HistoryModel.HistoryAttachments || []) {
      out.push({ historyId: h.HistoryID, note: h.Note, name: `${a.File.Name}${a.File.Extension}`, token: a.File.Token });
    }
  }
  return out;
}

exports.handler = async function (event) {
  const q = event.queryStringParameters || {};
  if (!secret() || q.key !== secret()) return json(401, { error: "Unauthorized" });
  const issue = Number(q.issue);
  if (!issue) return json(400, { error: "issue is required" });
  const started = Date.now();
  try {
    const session = await rmLogin();
    const files = await attachments(session, issue);
    if (!q.card) return json(200, { issue, files: files.map((f, i) => ({ file: i + 1, note: f.note, name: f.name })), ms: Date.now() - started });

    const f = files[Number(q.file) - 1];
    if (!f) return json(400, { error: "no such file" });
    const res = await fetch(`${RM_BASE}/api/Download?token=${f.token}`, { headers: session.headers });
    if (!res.ok) throw new Error(`Rent Manager download returned ${res.status}`);
    const bytes = await res.arrayBuffer();
    const downloaded = Date.now() - started;

    const form = new FormData();
    const types = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", heic: "image/heic", mp4: "video/mp4", mov: "video/quicktime", pdf: "application/pdf" };
    form.append("file", new Blob([bytes], { type: types[f.name.split(".").pop().toLowerCase()] || "application/octet-stream" }), f.name);
    const up = await fetch(`${APTLY_API}/api/board/${MX}/${q.card}/file`, {
      method: "POST",
      headers: { "x-token": process.env.APTLY_RUBY_KEY || process.env.APTLY_OWNER_BILLING_KEY },
      body: form
    });
    const text = await up.text();
    if (!up.ok) throw new Error(`Aptly upload returned ${up.status}: ${text.slice(0, 200)}`);
    return json(200, { name: f.name, sizeMB: +(bytes.byteLength / 1048576).toFixed(2), downloadedMs: downloaded, totalMs: Date.now() - started });
  } catch (e) {
    return json(500, { error: String(e.message || e), ms: Date.now() - started });
  }
};
