// Easy setup: asks a few questions and writes .env and accounts.json for you.
// Run:  node setup.js
const fs = require("fs");
const readline = require("readline");

const rl = readline.createInterface({ input: process.stdin });
const answers = [];
const waiting = [];
rl.on("line", (line) => (waiting.length ? waiting.shift()(line.trim()) : answers.push(line.trim())));
rl.on("close", () => waiting.forEach((w) => w("")));
const ask = (q) =>
  new Promise((resolve) => {
    process.stdout.write(q);
    if (answers.length) resolve(answers.shift());
    else waiting.push(resolve);
  });

(async () => {
  console.log("\nSHIFT BOT SETUP\nType each answer and press Enter.\n");

  const email = await ask("1) Client's Amazon email: ");
  const password = await ask("2) Client's Amazon password: ");
  let gmail = await ask("3) Client's Gmail address (press Enter if it is the same as the Amazon email): ");
  if (!gmail) gmail = email;
  const appPass = (await ask("4) The 16-letter Gmail password: ")).replace(/\s+/g, "");
  const locations = await ask("5) Locations wanted, comma separated (press Enter for any location): ");
  const relay = await ask("6) Relay link (your Google Apps Script link, press Enter if you have none): ");
  rl.close();

  if (!email || !password) {
    console.log("\nEmail and password are needed. Run  node setup.js  again.");
    process.exit(1);
  }

  const accounts = [
    { name: "Client", email, password, imapUser: gmail, imapPass: appPass, locations, maxApplies: 1 },
  ];
  fs.writeFileSync("accounts.json", JSON.stringify(accounts, null, 2));

  const env = [
    "DRY_RUN=true",
    "PROCESS_OLD_POSTS=1",
    "POLL_SECONDS=10",
    "TG_CHANNEL=amazonwarehousejobs_uk",
    `TME_RELAY_URL=${relay}`,
    "HEADLESS=false",
    "BROWSER_CHANNEL=chrome",
    "PORT=3000",
    "",
  ].join("\n");
  fs.writeFileSync(".env", env);

  console.log("\nSaved accounts.json and .env");
  console.log(appPass.length === 16 ? "The Gmail password has 16 letters. Good." : `Note: the Gmail password has ${appPass.length} letters, it should have 16.`);
  console.log("\nNow close all Chrome windows and run:  npm start\n");
})();