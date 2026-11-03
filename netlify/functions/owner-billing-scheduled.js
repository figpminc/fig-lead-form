// Scheduled run of the monthly owner invoices: 1st of each month (schedule in netlify.toml).
// Emails Julia the PDF invoices to review and send to Clyr. If anything fails, emails Katie instead.

const { run, alertKatie } = require("../lib/owner-billing-core");

exports.handler = async function () {
  try {
    const out = await run({ mode: "send" });
    console.log("owner-billing", JSON.stringify({ period: out.period, invoices: out.invoices.length, total: out.total, flagged: out.flagged.length, emailed: out.emailed }));
    return { statusCode: 200 };
  } catch (e) {
    const msg = String(e.message || e);
    console.error("owner-billing failed", msg);
    await alertKatie("Maintenance invoices did NOT run", `The monthly lock change / ozone / dehumidifier invoice job failed:\n\n${msg}\n\nNothing was emailed to Julia and no cards were marked billed. It is safe to re-run.`);
    return { statusCode: 500 };
  }
};
