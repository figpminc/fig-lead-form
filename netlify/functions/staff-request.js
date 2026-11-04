// Office staff maintenance request: creates a NEW Service Manager issue in Rent Manager.
// It never edits an existing issue. The overnight sync brings the issue into Aptly Work Orders,
// and the MX feed copies it to Maintenance.
//
//   GET  /.netlify/functions/staff-request?key=<STAFF_REQUEST_KEY>                  the form
//   GET  /.netlify/functions/staff-request?key=<STAFF_REQUEST_KEY>&mode=lists       properties and units
//   GET  /.netlify/functions/staff-request?key=<STAFF_REQUEST_KEY>&mode=tenants&unit=<UnitID>
//   POST /.netlify/functions/staff-request?key=<STAFF_REQUEST_KEY>                  create the issue
//   POST ...&dry=1                                                                  show the body; creates nothing

const { rmLogin } = require("../lib/leasing-fees-core");
const PAGE = require("../lib/staff-request-page");

const RM_BASE = process.env.RM_BASE_URL || "https://figpm.rmx.rentmanager.com";
const STATUS_NEW = 2;
const JULIA_USER_ID = 13;
const CATEGORIES = new Set([4, 8, 9, 10, 11, 12, 13, 14]);
const PRIORITIES = new Set([3, 4, 5]); // Medium, High, Low. Emergencies don't use this form.
const LINK_EMBEDS = "ServiceManagerIssueLinkedProperties,ServiceManagerIssueLinkedUnits,ServiceManagerIssueLinkedTenants";

const json = (statusCode, body) => ({ statusCode, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(body) });

async function rmGet(session, path) {
  const res = await fetch(`${RM_BASE}/api/${path}`, { headers: session.headers });
  const text = await res.text();
  if (!res.ok) throw new Error(`Rent Manager GET ${path.split("?")[0]} returned ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

async function rmGetAll(session, path) {
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const rows = await rmGet(session, `${path}&pagesize=1000&pagenumber=${page}`);
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

async function lists(session) {
  const [properties, units] = await Promise.all([
    rmGetAll(session, "Properties?fields=PropertyID,Name,ShortName,IsActive"),
    rmGetAll(session, "Units?fields=UnitID,Name,PropertyID")
  ]);
  const active = properties.filter(p => p.IsActive);
  const ids = new Set(active.map(p => p.PropertyID));
  return {
    properties: active.map(p => ({ id: p.PropertyID, name: p.Name })).sort((a, b) => a.name.localeCompare(b.name)),
    units: units.filter(u => ids.has(u.PropertyID)).map(u => ({ id: u.UnitID, name: u.Name, property: u.PropertyID }))
  };
}

async function tenants(session, unitId) {
  const leases = await rmGet(session, `Leases?filters=UnitID,eq,${unitId}&embeds=Tenant`);
  const today = new Date().toISOString().slice(0, 10);
  const current = new Map();
  for (const l of leases) {
    if (l.MoveOutDate && l.MoveOutDate.slice(0, 10) < today) continue;
    if (l.Tenant) current.set(l.TenantID, { id: l.TenantID, name: l.Tenant.Name });
  }
  return [...current.values()];
}

function buildIssue(f) {
  const title = String(f.title || "").trim();
  const description = String(f.description || "").trim();
  const enteredBy = String(f.enteredBy || "").trim();
  const propertyId = Number(f.propertyId), unitId = Number(f.unitId) || 0;
  const categoryId = Number(f.categoryId), priorityId = Number(f.priorityId);
  const tenantIds = (Array.isArray(f.tenantIds) ? f.tenantIds : []).map(Number).filter(Boolean);
  const missing = [];
  if (!propertyId) missing.push("property");
  if (!title) missing.push("title");
  if (!description) missing.push("description");
  if (!enteredBy) missing.push("your name");
  if (!CATEGORIES.has(categoryId)) missing.push("category");
  if (!PRIORITIES.has(priorityId)) missing.push("priority");
  if (missing.length) return { missing };

  const lockbox = String(f.lockbox || "").trim();
  const lines = [description, ...(lockbox ? [`Lockbox: ${lockbox}`] : []), `Entered by ${enteredBy} on the staff request form.`];
  return {
    issue: {
      Title: title.slice(0, 100),
      Description: lines.join("\n"),
      CategoryID: categoryId,
      PriorityID: priorityId,
      StatusID: STATUS_NEW,
      AssignedToUserID: JULIA_USER_ID,
      IsAllowedToEnter: f.okToEnter === true,
      HasPets: f.hasPets === true,
      ServiceManagerIssueLinkedProperties: [{ PropertyID: propertyId }],
      ServiceManagerIssueLinkedUnits: unitId ? [{ UnitID: unitId }] : [],
      ServiceManagerIssueLinkedTenants: tenantIds.map(TenantID => ({ TenantID }))
    }
  };
}

async function createIssue(session, issue) {
  const res = await fetch(`${RM_BASE}/api/ServiceManagerIssues?embeds=${LINK_EMBEDS}`, {
    method: "POST",
    headers: { ...session.headers, "Content-Type": "application/json" },
    body: JSON.stringify([issue])
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Rent Manager returned ${res.status}: ${text.slice(0, 300)}`);
  const parsed = JSON.parse(text);
  const created = Array.isArray(parsed) ? parsed[0] : parsed;
  // Read it back: the form only reports success if the unit really saved on the issue.
  const check = await rmGet(session, `ServiceManagerIssues/${created.ServiceManagerIssueID}?embeds=${LINK_EMBEDS}`);
  const wanted = issue.ServiceManagerIssueLinkedUnits.length;
  const linked = (check.ServiceManagerIssueLinkedUnits || []).length;
  return { id: check.ServiceManagerIssueID, linkWarning: wanted && !linked ? "The unit did not save on the issue. Add it in Rent Manager." : "" };
}

exports.handler = async function (event) {
  const q = event.queryStringParameters || {};
  const secret = process.env.STAFF_REQUEST_KEY;
  if (!secret || q.key !== secret) return { statusCode: 401, body: "Unauthorized" };

  try {
    if (event.httpMethod === "POST") {
      const raw = event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString() : event.body;
      const built = buildIssue(JSON.parse(raw || "{}"));
      if (built.missing) return json(400, { error: `Please fill in: ${built.missing.join(", ")}` });
      if (q.dry === "1") return json(200, { dry: true, issue: built.issue });
      return json(200, await createIssue(await rmLogin(), built.issue));
    }
    if (q.mode === "lists") return json(200, await lists(await rmLogin()));
    if (q.mode === "tenants") {
      const unit = Number(q.unit);
      if (!unit) return json(400, { error: "unit is required" });
      return json(200, { tenants: await tenants(await rmLogin(), unit) });
    }
    return { statusCode: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex", "Referrer-Policy": "no-referrer" }, body: PAGE };
  } catch (e) {
    return json(500, { error: String(e.message || e) });
  }
};
