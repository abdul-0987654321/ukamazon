// Shift bot, server version. Runs 24/7: watches the public Telegram channel and applies for
// each account whose filters match. Shows a small status page on PORT.
try { require("dotenv").config(); } catch (e) {}
const fs = require("fs");
const http = require("http");
const { log, lines } = require("./log");
const { fetchPosts } = require("./channel");
const { parsePost, matching } = require("./parser");
const { applyToJob, warmLogin, closeAll } = require("./amazon");
const { sendAlert } = require("./mailer");

const CHANNEL = process.env.TG_CHANNEL || "amazonwarehousejobs_uk";
const POLL_MS = Math.max(2, Number(process.env.POLL_SECONDS || 5)) * 1000;
const DRY_RUN = process.env.DRY_RUN !== "false"; // safe by default
const OLD_POSTS = Number(process.env.PROCESS_OLD_POSTS || 0);
// On start, also try every post from the last N minutes (0 = only new posts)
const LOOKBACK_MIN = Number(process.env.LOOKBACK_MINUTES || 0);
const MAX_PARALLEL = Number(process.env.MAX_PARALLEL || 3);
const ALL_SHIFTS = process.env.ONE_SHIFT_PER_POST === "false";
const WARM = process.env.WARM_LOGIN !== "false";
// RUN_ONCE=true: take the recent posts once, try them all, print a summary and stop (no watching)
const RUN_ONCE = process.env.RUN_ONCE === "true";
const results = [];
const PAUSE_MS = 15 * 60000;

// ---------- accounts ----------
function loadAccounts() {
  let raw = process.env.ACCOUNTS_JSON;
  if (!raw && fs.existsSync("accounts.json")) raw = fs.readFileSync("accounts.json", "utf8");
  if (!raw) throw new Error("No accounts. Set ACCOUNTS_JSON or create accounts.json (see accounts.example.json).");
  const list = JSON.parse(raw);
  return list
    .filter((a) => a.enabled !== false)
    .map((a) => {
      if (!a.name || !a.email || !a.password) throw new Error("Each account needs name, email and password.");
      return {
        ...a,
        maxApplies: Number(a.maxApplies || 1),
        state: { status: "idle", applied: 0, fails: 0, pausedUntil: 0, last: "", busy: false },
        queue: [],
        tried: new Map(),
      };
    });
}

let accounts = [];
let lastId = 0, first = true, polling = false, running = 0;
const stats = { posts: 0, startedAt: Date.now(), lastPoll: 0, lastError: "" };

const canApply = (a) =>
  !["needs_assessment", "login_failed", "blocked", "done"].includes(a.state.status) &&
  Date.now() >= a.state.pausedUntil &&
  (a.state.applied < a.maxApplies || (RUN_ONCE && DRY_RUN));

function setStatus(a, status, last) {
  a.state.status = status;
  if (last) a.state.last = last;
}

// ---------- channel ----------
function handlePost(raw, isOld) {
  const post = parsePost(raw);
  stats.posts++;
  const takers = [];
  for (const a of accounts) {
    if (!canApply(a)) continue;
    const hits = matching(post, a);
    if (!hits.length) continue;
    let added = 0;
    for (const h of ALL_SHIFTS ? hits : hits.slice(0, 1)) {
      // the channel repeats the same shifts every few minutes: do not try one link again within 30 minutes
      const lastTry = a.tried.get(h.url) || 0;
      if (Date.now() - lastTry < 30 * 60000) continue;
      a.tried.set(h.url, Date.now());
      a.queue.push({ url: h.url, label: h.text, where: post.location, foundAt: Date.now(), old: !!isOld });
      added++;
    }
    if (added) takers.push(a.name);
  }
  log(`Post #${post.id}: ${post.location} | ${post.shifts.length} shifts | for: ${takers.join(", ") || "nobody"}`);
}

async function poll() {
  if (polling) return;
  polling = true;
  try {
    const posts = await fetchPosts(CHANNEL);
    stats.lastPoll = Date.now();
    stats.lastError = "";
    if (first) {
      first = false;
      let old = OLD_POSTS > 0 ? posts.slice(-OLD_POSTS) : [];
      if (LOOKBACK_MIN > 0) {
        const since = Date.now() - LOOKBACK_MIN * 60000;
        const recent = posts.filter((p) => p.time && p.time >= since);
        log(`Found ${recent.length} post(s) from the last ${LOOKBACK_MIN} minutes.`);
        old = [...new Map([...old, ...recent].map((p) => [p.id, p])).values()];
      }
      // newest first: the newest shifts are the most likely to still be open
      old.sort((a, b) => b.id - a.id).forEach((p) => handlePost(p, true));
      lastId = posts.length ? posts[posts.length - 1].id : 0;
      log(`Watching t.me/s/${CHANNEL}. Latest post is #${lastId}.`);
    } else {
      for (const p of posts) {
        if (p.id > lastId) { handlePost(p, false); lastId = p.id; }
      }
    }
  } catch (e) {
    stats.lastError = e.message;
    log(`Could not read the channel: ${e.message}`);
  } finally {
    polling = false;
  }
  pump();
}

// ---------- applying ----------
function pump() {
  for (const a of accounts) {
    if (running >= MAX_PARALLEL) return;
    if (a.state.busy || !a.queue.length) continue;
    if (!canApply(a)) { a.queue.length = 0; continue; }
    work(a);
  }
}

async function work(a) {
  a.state.busy = true;
  running++;
  const say = (t) => log(t, a.name);
  try {
    while (a.queue.length && canApply(a)) {
      const job = a.queue.shift();
      if (!job.old && Date.now() - job.foundAt > 120000) continue; // too old, shift is likely gone
      setStatus(a, "applying", `${job.where} | ${job.label}`);
      say(`Applying: ${job.where} | ${job.label}`);
      const t0 = Date.now();
      const res = await applyToJob(a, job, DRY_RUN, say);
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      const what = `${job.where} | ${job.label}`;
      results.push({ account: a.name, what, reason: res.reason, secs });

      if (res.committed && res.reason !== "ASSESSMENT_NEEDED") {
        // "Start Application" was pressed, so an application exists. Stop here and let a person look.
        a.state.applied++; a.state.fails = 0;
        a.queue.length = 0;
        say(`${res.reason === "PRESSED_NO_CHANGE" ? "START PRESSED, NOT CONFIRMED" : "APPLICATION STARTED"} in ${secs}s: ${what}. ${res.message}`);
        setStatus(a, "needs_assessment", `${res.reason === "PRESSED_NO_CHANGE" ? "Start pressed, not confirmed" : "Started"}: ${what}. Check the account and continue by hand.`);
        sendAlert(a.alertTo, "Application started", `The bot started an application for:\n${what}\n\n${res.message}\n\nPlease log in to jobsatamazon.co.uk and continue.`);
      } else if (res.reason === "SHIFT_GONE") {
        say(`Skipped, shift no longer available (${secs}s).`);
        setStatus(a, "idle", `Shift gone: ${what}`);
      } else if (res.reason === "DRY_OK") {
        a.state.applied++; a.state.fails = 0;
        say(`TEST OK in ${secs}s: ${res.message}`);
        setStatus(a, "idle", `Test OK: ${what}`);
      } else if (res.reason === "ASSESSMENT_NEEDED") {
        a.state.applied++; a.state.fails = 0;
        say(`APPLICATION STARTED in ${secs}s: ${what}. The candidate must now complete Amazon's assessment.`);
        setStatus(a, "needs_assessment", `Started: ${what}. Assessment needed.`);
        a.queue.length = 0;
        sendAlert(a.alertTo, "Application started: complete your assessment",
          `The bot started an application for:\n${what}\n\nPlease log in to jobsatamazon.co.uk and complete the assessment yourself.\nThe bot is paused for this account until it is restarted.`);
      } else if (res.ok) {
        a.state.applied++; a.state.fails = 0;
        say(`APPLIED in ${secs}s: ${what}. ${res.message}`);
        setStatus(a, "idle", `Applied: ${what}`);
        sendAlert(a.alertTo, "Shift applied", `${what}\n\n${res.message}`);
      } else if (res.reason === "IP_BLOCKED") {
        say(`BLOCKED: ${res.message}`);
        setStatus(a, "blocked", res.message);
        a.queue.length = 0;
      } else if (res.reason === "LOGIN_FAILED") {
        say("Login failed. This account is paused so it does not get locked.");
        setStatus(a, "login_failed", "Login failed. Check the email, password and Gmail app password.");
        a.queue.length = 0;
        sendAlert(a.alertTo, "Shift bot: login failed", "The bot could not log in to your Amazon account. Please check the details.");
      } else {
        a.state.fails++;
        say(`Failed (${res.reason}) after ${secs}s: ${res.message}`);
        setStatus(a, "idle", `Failed (${res.reason}): ${what}`);
        if (a.state.fails >= 2) {
          a.state.fails = 0;
          a.state.pausedUntil = Date.now() + PAUSE_MS;
          a.queue.length = 0;
          setStatus(a, "paused", "Two failures in a row. Paused for 15 minutes.");
          say("Two failures in a row. Paused for 15 minutes.");
        }
      }
      if (a.state.applied >= a.maxApplies && a.state.status === "idle" && !(RUN_ONCE && DRY_RUN)) setStatus(a, "done", a.state.last);
    }
  } catch (e) {
    say("Unexpected error: " + e.message);
  } finally {
    a.state.busy = false;
    running--;
    if (RUN_ONCE) setTimeout(finishBatch, 500);
    pump();
  }
}

// ---------- batch summary (RUN_ONCE) ----------
let finished = false;
async function finishBatch() {
  if (finished || accounts.some((a) => a.state.busy || (a.queue.length && canApply(a)))) return;
  finished = true;
  const names = {
    DRY_OK: "Reached Start Application (test mode)", ASSESSMENT_NEEDED: "Application started, assessment shown",
    STARTED: "Application started", SHIFT_GONE: "Shift already gone",
  };
  const count = {};
  for (const r of results) count[r.reason] = (count[r.reason] || 0) + 1;
  log("");
  log(`===== SUMMARY: ${results.length} shift(s) tried =====`);
  for (const [reason, n] of Object.entries(count)) log(`  ${n} x ${names[reason] || "Failed: " + reason}`);
  log("");
  for (const r of results) log(`  ${(names[r.reason] || r.reason).padEnd(40)} ${r.secs}s  ${r.what}`);
  log("===== Finished. The bot has stopped. =====");
  await closeAll();
  process.exit(0);
}

// ---------- status page ----------
const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function statusPage() {
  const rows = accounts
    .map((a) => {
      const st = a.state.status === "paused" && Date.now() >= a.state.pausedUntil ? "idle" : a.state.status;
      return `<tr><td>${escHtml(a.name)}</td><td class="s-${st}">${st.replace("_", " ")}</td><td>${a.state.applied} / ${a.maxApplies}</td><td>${escHtml(a.locations || "any")}</td><td>${escHtml(a.state.last || "")}</td></tr>`;
    })
    .join("");
  const ago = stats.lastPoll ? Math.round((Date.now() - stats.lastPoll) / 1000) + "s ago" : "not yet";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="10"><title>Shift Bot</title><style>
:root{--bg:#f4f5f7;--panel:#fff;--ink:#16202b;--muted:#5d6b7a;--line:#dfe3e8;--ok:#177a36;--bad:#b3261e;--warn:#8a5a00}
@media (prefers-color-scheme:dark){:root{--bg:#12161b;--panel:#1b2129;--ink:#e8edf2;--muted:#9aa7b4;--line:#2d3641;--ok:#58c97c;--bad:#ff8a80;--warn:#ffcf70}}
body{margin:0;padding:16px;background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
h1{font-size:19px;margin:0 0 4px}p{margin:0 0 14px;color:var(--muted)}
.wrap{overflow-x:auto;background:var(--panel);border:1px solid var(--line);border-radius:10px}
table{border-collapse:collapse;width:100%;min-width:640px}th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:12.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}tr:last-child td{border-bottom:0}
.s-idle,.s-applying,.s-done{color:var(--ok);font-weight:600}.s-paused,.s-needs_assessment{color:var(--warn);font-weight:600}.s-login_failed,.s-blocked{color:var(--bad);font-weight:600}
pre{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px;font:12.5px/1.5 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;max-height:60vh;overflow:auto}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:20px 0 8px}
</style></head><body>
<h1>Shift Bot ${DRY_RUN ? "(TEST MODE: nothing is submitted)" : "(LIVE)"}</h1>
<p>Channel: ${escHtml(CHANNEL)} · last check ${ago}${stats.lastError ? " · error: " + escHtml(stats.lastError) : ""} · posts seen: ${stats.posts} · proxy: ${process.env.PROXY_SERVER ? "on" : "off"}</p>
<div class="wrap"><table><tr><th>Account</th><th>Status</th><th>Applied</th><th>Locations</th><th>Last event</th></tr>${rows}</table></div>
<h2>Activity</h2><pre>${escHtml(lines.slice(-150).join("\n"))}</pre></body></html>`;
}

function startStatusServer() {
  const port = Number(process.env.PORT || 3000);
  http
    .createServer((req, res) => {
      const u = new URL(req.url, "http://x");
      if (u.pathname === "/health") { res.writeHead(200); return res.end("ok"); }
      const token = process.env.STATUS_TOKEN;
      if (token && u.searchParams.get("token") !== token) { res.writeHead(401); return res.end("Add ?token=... to the address."); }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(statusPage());
    })
    .listen(port, () => log(`Status page on port ${port}`));
}

// ---------- start ----------
async function main() {
  accounts = loadAccounts();
  log(`Shift bot starting. ${accounts.length} account(s). ${DRY_RUN ? "TEST MODE (nothing is submitted)." : "LIVE mode."} Proxy: ${process.env.PROXY_SERVER ? "on" : "off"}.`);
  startStatusServer();

  if (WARM) {
    for (const a of accounts) {
      const say = (t) => log(t, a.name);
      say("Logging in...");
      const r = await warmLogin(a, say);
      if (r.ok) setStatus(a, "idle", "Logged in and ready.");
      else if (r.reason === "IP_BLOCKED") {
        setStatus(a, "blocked", "Amazon blocked this server's connection. Set a UK residential proxy (PROXY_SERVER).");
        say("BLOCKED by Amazon. A UK residential proxy is needed.");
      } else {
        setStatus(a, "login_failed", `Login failed (${r.reason}).`);
        say(`Login failed (${r.reason}).`);
      }
    }
  }

  await poll();
  if (RUN_ONCE) {
    log("RUN_ONCE: trying the posts found above, then stopping.");
    setTimeout(finishBatch, 3000);
  } else {
    setInterval(poll, POLL_MS);
  }
}

process.on("SIGTERM", async () => { await closeAll(); process.exit(0); });
process.on("SIGINT", async () => { await closeAll(); process.exit(0); });
process.on("unhandledRejection", (e) => log("Unhandled error: " + (e && e.message ? e.message : e)));

if (require.main === module) {
  main().catch((e) => { console.error("Could not start:", e.message); process.exit(1); });
}