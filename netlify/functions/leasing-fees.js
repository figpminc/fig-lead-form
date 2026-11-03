// Manual / test entry point for the monthly leasing-fee bills (see netlify/lib/leasing-fees-core.js).
//
//   /.netlify/functions/leasing-fees?key=<LEASING_FEES_KEY>&mode=login            test the RM login only
//   /.netlify/functions/leasing-fees?key=<LEASING_FEES_KEY>&mode=dryrun&period=YYYY-MM
//                                         show what would be billed; posts and emails nothing
//   /.netlify/functions/leasing-fees?key=<LEASING_FEES_KEY>&mode=post&period=YYYY-MM
//                                         create the bills and email Cassidy (same as the scheduled run)

const { run, rmLogin } = require("../lib/leasing-fees-core");

exports.handler = async function (event) {
  const json = (statusCode, body) => ({ statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body, null, 2) });

  const q = event.queryStringParameters || {};
  const secret = process.env.LEASING_FEES_KEY;
  if (!secret || q.key !== secret) return json(401, { error: "Unauthorized" });

  try {
    if (q.mode === "login") {
      const s = await rmLogin();
      return json(200, { ok: true, method: s.method, diag: s.diag });
    }
    if (q.mode === "dryrun") {
      const out = await run({ period: q.period, post: false, sendEmail: false });
      return json(200, out);
    }
    if (q.mode === "post") {
      const out = await run({ period: q.period, post: true });
      return json(200, out);
    }
    return json(400, { error: "mode must be login, dryrun or post" });
  } catch (e) {
    return json(500, { error: String(e.message || e), diag: e.diag });
  }
};
