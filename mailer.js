// Optional email alerts. Skipped quietly when SMTP_USER / SMTP_PASS are not set.
let transporter = null;
function getTransport() {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  if (!transporter) {
    transporter = require("nodemailer").createTransport({
      service: "gmail",
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS.replace(/\s+/g, "") },
    });
  }
  return transporter;
}

async function sendAlert(to, subject, text) {
  const t = getTransport();
  const rcpt = to || process.env.ALERT_TO;
  if (!t || !rcpt) return false;
  try {
    await t.sendMail({ from: `"Shift Bot" <${process.env.SMTP_USER}>`, to: rcpt, subject, text });
    return true;
  } catch (e) {
    console.log("Email alert failed:", e.message);
    return false;
  }
}
module.exports = { sendAlert };
