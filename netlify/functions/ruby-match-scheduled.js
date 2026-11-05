// Scheduled run of the Ruby call matching (schedule in netlify.toml). If it fails, emails Katie at
// most once an hour, because this runs every few minutes.

const { run, alertKatie } = require("../lib/ruby-match-core");

exports.handler = async function () {
  try {
    const out = await run({ live: true });
    console.log("ruby-match", JSON.stringify(out));
    return { statusCode: 200 };
  } catch (e) {
    const msg = String(e.message || e);
    console.error("ruby-match failed", msg);
    if (new Date().getMinutes() < 5) await alertKatie(`Ruby vendors are not reaching Maintenance cards:\n\n${msg}`);
    return { statusCode: 500 };
  }
};
