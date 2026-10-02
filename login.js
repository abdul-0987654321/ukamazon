// Log in by hand ONCE and save the login, so the bot does not have to log in by itself.
// Run:  node login.js          (first account)
//       node login.js "Name"   (a specific account from accounts.json)
try { require("dotenv").config(); } catch (e) {}
process.env.HEADLESS = "false"; // always show the browser for a manual login
const fs = require("fs");
const readline = require("readline");
const { getContext, saveState, closeAll, isAuth } = require("./amazon");
const { waitForCode } = require("./otp");

(async () => {
  const accounts = JSON.parse(process.env.ACCOUNTS_JSON || fs.readFileSync("accounts.json", "utf8"));
  const wanted = process.argv[2];
  const acc = wanted ? accounts.find((a) => a.name === wanted) : accounts[0];
  if (!acc) { console.log("Account not found in accounts.json"); process.exit(1); }

  const ctx = await getContext(acc);
  const page = await ctx.newPage();
  await page.goto(process.env.AMAZON_LOGIN_URL || "https://www.jobsatamazon.co.uk/app#/login");

  console.log(`\nLOGIN FOR: ${acc.name}`);
  console.log("1) In the browser window, log in yourself: email, password, then choose the email code.");
  console.log("2) When Amazon sends the code, it will be shown here (if the Gmail password is set).");
  console.log("3) Type the code into Amazon and finish the login.\n");

  // Show the email code in this window as soon as it arrives
  let shown = false;
  const watcher = setInterval(async () => {
    if (shown) return;
    const text = (await page.locator("body").innerText().catch(() => "")).toLowerCase();
    if (/enter the verification code|verification code has been sent/.test(text)) {
      shown = true;
      console.log("Amazon sent a code. Reading it from Gmail...");
      try {
        const code = await waitForCode(acc, new Date(Date.now() - 20000));
        console.log(code ? `\n   CODE:  ${code}\n` : "Could not find the code email. Ask the client for the code.");
      } catch (e) {
        console.log("Could not read Gmail:", e.message);
      }
    }
  }, 2000);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise((r) => rl.question("When you are fully logged in, press Enter here to save the login... ", r));
  rl.close();
  clearInterval(watcher);

  if (isAuth(page)) console.log("Note: the browser still shows the login page. Saving anyway.");
  await saveState(acc);
  await closeAll();
  console.log(`\nLogin saved for ${acc.name}. Now run:  npm start\n`);
  process.exit(0);
})().catch((e) => { console.error("Error:", e.message); process.exit(1); });