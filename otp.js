// Reads Amazon's 6-digit verification code from the account's Gmail (IMAP + app password).
const strip = (html) =>
  (html || "").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ");

async function waitForCode(acc, requestedAt, timeoutMs = 170000) {
  if (process.env.OTP_TEST_CODE) return process.env.OTP_TEST_CODE; // used only by local tests
  if (!acc.imapUser || !acc.imapPass) return "";
  const { ImapFlow } = require("imapflow");
  const { simpleParser } = require("mailparser");

  const client = new ImapFlow({
    host: "imap.gmail.com", port: 993, secure: true,
    auth: { user: acc.imapUser, pass: String(acc.imapPass).replace(/\s+/g, "") },
    logger: false,
  });
  await client.connect();
  try {
    const boxes = await client.list();
    const all = boxes.find((b) => b.specialUse === "\\All");
    const junk = boxes.find((b) => b.specialUse === "\\Junk");
    const folders = [all ? all.path : "INBOX"];
    if (junk) folders.push(junk.path);

    const notBefore = requestedAt.getTime() - 30000;
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      let best = null;
      for (const folder of folders) {
        const lock = await client.getMailboxLock(folder);
        try {
          const uids = await client.search({ gmraw: 'newer_than:1d "verification code"' }, { uid: true });
          for (const uid of (uids || []).slice(-6)) {
            const msg = await client.fetchOne(String(uid), { source: true, internalDate: true }, { uid: true });
            if (!msg) continue;
            const at = new Date(msg.internalDate).getTime();
            if (at < notBefore) continue;
            const mail = await simpleParser(msg.source);
            if (!/verification code/i.test(mail.subject || "")) continue;
            const m = `${mail.text || ""}\n${strip(mail.html)}`.match(/(?<!\d)(\d{6})(?!\d)/);
            if (m && (!best || at > best.at)) best = { at, code: m[1] };
          }
        } finally {
          lock.release();
        }
      }
      if (best) return best.code;
      await new Promise((r) => setTimeout(r, 3000));
    }
    return "";
  } finally {
    await client.logout().catch(() => {});
  }
}

module.exports = { waitForCode };
