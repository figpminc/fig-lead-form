// Manual / test entry point for the weekly Ninety scorecard fill (see netlify/lib/ninety-scorecard-core.js).
//
//   /.netlify/functions/ninety-scorecard?key=<SCORECARD_KEY>&mode=check
//         confirms the Ninety token works and every metric id still matches its title
//   /.netlify/functions/ninety-scorecard?key=<SCORECARD_KEY>&mode=dryrun[&week=YYYY-MM-DD]
//         computes the numbers for the last full week (or the week containing that date); writes and emails nothing
//   /.netlify/functions/ninety-scorecard?key=<SCORECARD_KEY>&mode=post[&week=YYYY-MM-DD]
//         same as the scheduled run: writes to Ninety only if NINETY_WRITE=true, and emails Katie

const { run, checkKpis } = require("../lib/ninety-scorecard-core");

exports.handler = async function (event) {
  const json = (statusCode, body) => ({ statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body, null, 2) });
  const q = event.queryStringParameters || {};
  const secret = process.env.SCORECARD_KEY;
  if (!secret || q.key !== secret) return json(401, { error: "Unauthorized" });

  try {
    if (q.mode === "check") return json(200, { kpis: await checkKpis() });
    if (q.mode === "dryrun") return json(200, await run({ week: q.week, write: false, sendEmail: false }));
    if (q.mode === "post") return json(200, await run({ week: q.week }));
    return json(400, { error: "mode must be check, dryrun or post" });
  } catch (e) {
    return json(500, { error: String(e.message || e) });
  }
};
