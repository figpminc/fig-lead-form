// Scheduled run of the monthly leasing-fee bills: 1st of each month (schedule in netlify.toml).
// Bills the previous month and emails Cassidy. If anything fails, emails Katie instead.

const { run, aptlyAlertKatie } = require("../lib/leasing-fees-core");

exports.handler = async function () {
  try {
    const out = await run({ post: true });
    console.log("leasing-fees", JSON.stringify({ period: out.period, alreadyRan: out.alreadyRan, created: out.created, flagged: (out.flagged || []).length, emailed: out.emailed }));
    return { statusCode: 200 };
  } catch (e) {
    const msg = String(e.message || e);
    console.error("leasing-fees failed", msg, JSON.stringify(e.diag || []));
    await aptlyAlertKatie("Leasing fee bills did NOT run", `The monthly leasing/renewal fee bill job failed:\n\n${msg}\n\nNothing was emailed to Cassidy. Check Rent Manager before re-running.`);
    return { statusCode: 500 };
  }
};
