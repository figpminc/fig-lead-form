// Manual / test entry point for matching Ruby calls to Maintenance cards (see netlify/lib/ruby-match-core.js).
//
//   /.netlify/functions/ruby-match?key=<RUBY_MATCH_KEY>&mode=dryrun     what would happen; changes nothing
//   /.netlify/functions/ruby-match?key=<RUBY_MATCH_KEY>&mode=raw        newest Ruby card as the API returns it
//   /.netlify/functions/ruby-match?key=<RUBY_MATCH_KEY>&mode=run        set vendors now (same as the scheduled run)

const { run, secret, listActive, RUBY } = require("../lib/ruby-match-core");

exports.handler = async function (event) {
  const json = (statusCode, body) => ({ statusCode, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(body, null, 2) });
  const q = event.queryStringParameters || {};
  if (!secret() || q.key !== secret()) return json(401, { error: "Unauthorized" });
  try {
    if (q.mode === "dryrun") return json(200, await run({ live: false }));
    if (q.mode === "run") return json(200, await run({ live: true }));
    if (q.mode === "raw") return json(200, (await listActive(RUBY, 7))[0] || null);
    return json(400, { error: "mode must be dryrun, raw or run" });
  } catch (e) {
    return json(500, { error: String(e.message || e) });
  }
};
