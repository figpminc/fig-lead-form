// Manual / test entry point for the weekly Ninety scorecard fill (see netlify/lib/ninety-scorecard-core.js).
//
//   /.netlify/functions/ninety-scorecard?key=<SCORECARD_KEY>&mode=check
//         confirms the Ninety token works and every metric id still matches its title
//   /.netlify/functions/ninety-scorecard?key=<SCORECARD_KEY>&mode=dryrun[&week=YYYY-MM-DD]
//         computes the numbers for the last full week (or the week containing that date); writes and emails nothing
//   /.netlify/functions/ninety-scorecard?key=<SCORECARD_KEY>&mode=post[&week=YYYY-MM-DD]
//         same as the scheduled run: writes to Ninety only if NINETY_WRITE=true, and emails Katie

const { run, checkKpis } = require("../lib/ninety-scorecard-core");

// Describes the token without revealing it: length, stray characters, and (if it is a JWT) its issue/expiry dates.
function tokenShape(t) {
  if (!t) return { present: false };
  const out = {
    present: true,
    length: t.length,
    trimmedLength: t.trim().length,
    startsWithBearer: /^\s*bearer\s/i.test(t),
    hasQuotes: /["']/.test(t),
    hasWhitespaceInside: /\s/.test(t.trim()),
    dots: (t.match(/\./g) || []).length,
    looksLikeJwt: /^eyJ/.test(t.trim().replace(/^bearer\s+/i, "")),
    // the pieces between spaces/line breaks: their lengths and whether a piece is a plain word (a label)
    pieces: t.trim().split(/\s+/).map(p => ({ length: p.length, plainWord: /^[A-Za-z:]+$/.test(p) })),
    breakKinds: [...new Set((t.trim().match(/\s/g) || []).map(c => ({ " ": "space", "\n": "newline", "\r": "return", "\t": "tab" }[c] || "other")))]
  };
  if (out.looksLikeJwt && out.dots === 2) {
    try {
      const p = JSON.parse(Buffer.from(t.trim().replace(/^bearer\s+/i, "").split(".")[1], "base64url").toString());
      if (p.iat) out.issued = new Date(p.iat * 1000).toISOString();
      if (p.exp) { out.expires = new Date(p.exp * 1000).toISOString(); out.expired = p.exp * 1000 < Date.now(); }
    } catch (e) { out.payloadReadable = false; }
  }
  return out;
}

// Tries the token as-is, with all whitespace removed, and as just its last piece; reports Ninety's answer for each.
async function tryVariants(t) {
  if (!t) return [];
  const v = { asIs: t.trim(), noWhitespace: t.replace(/\s+/g, ""), lastPiece: t.trim().split(/\s+/).pop(), longestPiece: t.trim().split(/\s+/).sort((a, b) => b.length - a.length)[0] };
  const out = {};
  for (const [name, tok] of Object.entries(v)) {
    const res = await fetch("https://api.public.ninety.io/v1/scorecard/kpis/company?limit=1", { headers: { Authorization: `Bearer ${tok}` } }).catch(e => ({ status: String(e.message || e) }));
    out[name] = res.status;
  }
  return out;
}

exports.handler = async function (event) {
  const json = (statusCode, body) => ({ statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body, null, 2) });
  const q = event.queryStringParameters || {};
  const secret = process.env.SCORECARD_KEY;
  if (!secret || q.key !== secret) return json(401, { error: "Unauthorized" });

  try {
    if (q.mode === "check") {
      const token = tokenShape(process.env.NINETY_TOKEN);
      token.variants = await tryVariants(process.env.NINETY_TOKEN);
      try { return json(200, { token, kpis: await checkKpis() }); }
      catch (e) { return json(500, { token, error: String(e.message || e) }); }
    }
    if (q.mode === "dryrun") return json(200, await run({ week: q.week, write: false, sendEmail: false }));
    if (q.mode === "post") return json(200, await run({ week: q.week }));
    return json(400, { error: "mode must be check, dryrun or post" });
  } catch (e) {
    return json(500, { error: String(e.message || e) });
  }
};
