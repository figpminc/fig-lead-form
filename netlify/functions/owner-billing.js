// Manual / test entry point for the monthly owner invoices (see netlify/lib/owner-billing-core.js).
//
//   /.netlify/functions/owner-billing?key=<OWNER_BILLING_KEY>&mode=dryrun     what would be invoiced; emails and marks nothing
//   /.netlify/functions/owner-billing?key=<OWNER_BILLING_KEY>&mode=pdf&n=1    view invoice #1 as a PDF
//   /.netlify/functions/owner-billing?key=<OWNER_BILLING_KEY>&mode=raw&board=mx  first tagged card as the API returns it
//   /.netlify/functions/owner-billing?key=<OWNER_BILLING_KEY>&mode=test       email the invoices to Katie only
//   /.netlify/functions/owner-billing?key=<OWNER_BILLING_KEY>&mode=send       email Julia (same as the scheduled run)
//
// mode=mark is the "Mark as sent" link in Julia's email. It is signed per invoice (no key needed).
// A GET only shows a confirm button, so email link scanners can't mark anything; the POST marks the cards.

const { run, previewPdf, markSent, verify, secret, BOARDS, listCards } = require("../lib/owner-billing-core");

const json = (statusCode, body) => ({ statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body, null, 2) });
const page = (statusCode, inner) => ({
  statusCode, headers: { "Content-Type": "text/html; charset=utf-8" },
  body: `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>FIG Maintenance invoices</title>
<body style="font-family:system-ui,sans-serif;max-width:560px;margin:40px auto;padding:0 16px;line-height:1.5">${inner}</body>`
});
const h = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

exports.handler = async function (event) {
  const q = { ...(event.queryStringParameters || {}) };
  if (event.httpMethod === "POST" && event.body) {
    const raw = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString() : event.body;
    for (const [k, v] of new URLSearchParams(raw)) q[k] = v;
  }

  if (q.mode === "mark") {
    if (!verify(q.inv, q.cards, q.sig)) return page(403, "<p>This link isn't valid. Ask Katie to check it.</p>");
    const n = String(q.cards).split(",").filter(Boolean).length;
    if (event.httpMethod !== "POST") {
      return page(200, `<h2>Mark invoice ${h(q.inv)} as sent?</h2>
<p>Only do this once the invoice has been sent to Clyr. It marks its ${n} Aptly card${n === 1 ? "" : "s"} Owner Billed, so they won't be invoiced again.</p>
<form method="post"><input type="hidden" name="mode" value="mark"><input type="hidden" name="inv" value="${h(q.inv)}">
<input type="hidden" name="cards" value="${h(q.cards)}"><input type="hidden" name="sig" value="${h(q.sig)}">
<button style="font-size:16px;padding:10px 18px">Yes, it was sent to Clyr</button></form>`);
    }
    try {
      const r = await markSent(q.inv, q.cards);
      return page(r.failed.length ? 500 : 200, r.failed.length
        ? `<h2>Partly done</h2><p>Marked ${r.done.length} of ${n} cards. These failed: ${h(r.failed.join("; "))}. Tell Katie.</p>`
        : `<h2>Done</h2><p>Invoice ${h(q.inv)} is marked sent. ${r.done.length} card${r.done.length === 1 ? "" : "s"} marked Owner Billed in Aptly.</p>`);
    } catch (e) {
      return page(500, `<h2>Something went wrong</h2><p>${h(e.message || e)}</p><p>Nothing may have been marked. Tell Katie.</p>`);
    }
  }

  if (!secret() || q.key !== secret()) return json(401, { error: "Unauthorized" });
  try {
    if (q.mode === "dryrun" || q.mode === "test" || q.mode === "send") return json(200, await run({ mode: q.mode }));
    if (q.mode === "pdf") {
      const inv = await previewPdf(q.n);
      if (!inv) return json(404, { error: "No invoice with that number this run" });
      return { statusCode: 200, headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${inv.file}"` }, body: inv.bytes.toString("base64"), isBase64Encoded: true };
    }
    if (q.mode === "raw") {
      const board = BOARDS.find(b => b.key === (q.board || "mx"));
      const cards = await listCards(board);
      const tagged = cards.filter(c => [board.lock, board.ozone, board.dehu].some(f => c[f] === true));
      return json(200, { board: board.name, cards: cards.length, tagged: tagged.length, sample: tagged[0] || cards[0] || null });
    }
    return json(400, { error: "mode must be dryrun, pdf, raw, test or send" });
  } catch (e) {
    return json(500, { error: String(e.message || e) });
  }
};
