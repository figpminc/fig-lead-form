// Scheduled run of the live Rent Manager check (schedule in netlify.toml).
// Thursdays: Weekly Delinquency, Second Creek cards. Mondays: Weekly Delinquency, Trailblazer cards.
// The 6th: Delinquency. More than one can apply on the same day.
// If a run fails nobody is marked, so no notices go out, and Katie and the Account Manager are emailed.

const { check, sendEmail } = require("./notice-check");

const KATIE_EMAIL = "katie@freedominvestmentgroupinc.com";
const ACCOUNT_MANAGER_EMAIL = "cassidyj@freedominvestmentgroupinc.com";

exports.handler = async function () {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const boards = [];
  if (now.getDate() === 6) boards.push("monthly");
  if (now.getDay() === 4) boards.push("weekly");
  if (now.getDay() === 1) boards.push("trailblazer");
  let failed = false;
  for (const board of boards) {
    try {
      const s = await check(board, { write: true });
      console.log("notice-check", board, JSON.stringify({ cards: s.cards, notice: s.notice.length, paid: s.paid.length, small: s.small.length, review: s.review.length, writeErrors: s.writeErrors.length, emailed: s.emailed, ms: s.elapsedMs }));
    } catch (e) {
      failed = true;
      console.error("notice-check failed", board, e.message);
      await sendEmail(ACCOUNT_MANAGER_EMAIL, KATIE_EMAIL, `Delinquency notices did NOT go out (${board})`, `The live Rent Manager balance check failed, so no notices were sent for this board:\n\n${e.message}\n\nNo cards were marked. Tell Katie before sending anything by hand.`).catch(() => {});
    }
  }
  return { statusCode: failed ? 500 : 200 };
};
