// Scheduled weekly Ninety scorecard fill: Mondays (schedule in netlify.toml).
// Fills last week's make ready, survey and vendor NPS metrics and emails Katie the numbers.
// If it fails, emails Katie the error instead.

const { run, aptlyEmail, KATIE } = require("../lib/ninety-scorecard-core");

exports.handler = async function () {
  try {
    const out = await run({});
    console.log("ninety-scorecard", JSON.stringify({ week: out.week.label, write: out.write, values: out.values, emailed: out.emailed }));
    return { statusCode: 200 };
  } catch (e) {
    const msg = String(e.message || e);
    console.error("ninety-scorecard failed", msg);
    await aptlyEmail({ to: KATIE, subject: "Ninety scorecard did NOT update", text: `The weekly Ninety scorecard job failed:\n\n${msg}\n\nEnter this week's make ready and survey numbers by hand.` }).catch(() => {});
    return { statusCode: 500 };
  }
};
