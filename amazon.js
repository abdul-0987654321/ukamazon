// Drives a headless browser through Amazon's hourly-jobs site for one account:
// open shift -> Apply -> (log in if asked, reading the email code) -> Next -> Start Application.
// It stops at the assessment, which the candidate must take themselves.
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { waitForCode } = require("./otp");

const DATA_DIR = process.env.DATA_DIR || "data";
const LOGIN_URL = process.env.AMAZON_LOGIN_URL || "https://www.jobsatamazon.co.uk/app#/login";

const names = (env, defaults) => [
  ...defaults,
  ...(process.env[env] || "").split(",").map((s) => s.trim()).filter(Boolean),
];
const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const exact = (list) => list.map((t) => `^${esc(t)}$`);

const APPLY = ["^apply$", "^apply now$"];
const STEP = () => exact(names("EXTRA_STEP_BUTTONS", ["Next", "Continue", "Select this job", "Select this shift"]));
// Buttons that create or submit something. Test mode (DRY_RUN) stops before these.
const COMMIT = () => exact(names("EXTRA_COMMIT_BUTTONS", ["Start application", "Create application", "Submit application", "Submit"]));
const ASSESSMENT = ["^start assessment$", "^(begin|take) assessment$"];
const LOGIN_NEXT = ["^continue$", "^send", "^verify", "^sign in$", "^log ?in$", "^submit$", "^next$"];

let browser = null;
const contexts = new Map();
const safe = (s) => String(s).replace(/[^a-z0-9_-]/gi, "_");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  const opts = {
    headless: process.env.HEADLESS !== "false",
    args: ["--disable-blink-features=AutomationControlled", "--no-sandbox", "--disable-dev-shm-usage"],
    ignoreDefaultArgs: ["--enable-automation"],
  };
  if (process.env.BROWSER_CHANNEL) opts.channel = process.env.BROWSER_CHANNEL;
  if (process.env.PROXY_SERVER) {
    opts.proxy = {
      server: process.env.PROXY_SERVER,
      username: process.env.PROXY_USERNAME || undefined,
      password: process.env.PROXY_PASSWORD || undefined,
    };
  }
  browser = await chromium.launch(opts);
  browser.on("disconnected", () => { contexts.clear(); browser = null; });
  return browser;
}

const stateFile = (acc) => path.join(DATA_DIR, `${safe(acc.name)}.json`);

async function getContext(acc) {
  const b = await getBrowser();
  if (contexts.has(acc.name)) return contexts.get(acc.name);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const opts = {
    storageState: fs.existsSync(stateFile(acc)) ? stateFile(acc) : undefined,
    locale: "en-GB",
    timezoneId: "Europe/London",
    viewport: { width: 1366, height: 850 },
  };
  // The bundled headless browser announces itself as "Headless", so give it a normal name.
  // Real Chrome (BROWSER_CHANNEL=chrome) keeps its own, which is what Amazon expects.
  if (!process.env.BROWSER_CHANNEL) {
    const major = b.version().split(".")[0];
    opts.userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
  }
  // Optional: give the site a fixed UK location (off by default)
  if (process.env.GEO_LAT && process.env.GEO_LNG) {
    opts.permissions = ["geolocation"];
    opts.geolocation = { latitude: Number(process.env.GEO_LAT), longitude: Number(process.env.GEO_LNG) };
  }
  const ctx = await b.newContext(opts);
  // Surveys, tracking, video, fonts and the announcement banner are not needed to apply.
  // Some of them hang for 40+ seconds on a slow connection, so stop them at once.
  if (process.env.BLOCK_EXTRAS !== "false") {
    const EXTRAS = /qualtrics\.com|omtrdc\.net|demdex\.net|adobedtm\.com|unagi[\w-]*\.amazon\.com|google-analytics\.com|googletagmanager\.com|doubleclick\.net|amabot-rest-global-banner|\.mp4(\?|$)|\.woff2?(\?|$)/i;
    await ctx.route(EXTRAS, (route) => route.abort());
  }
  // Skipping pictures and fonts saves proxy data. Off unless a proxy is used or BLOCK_IMAGES=true,
  // because a hidden picture check on the login page would otherwise never load.
  const block = process.env.BLOCK_IMAGES ? process.env.BLOCK_IMAGES === "true" : !!process.env.PROXY_SERVER;
  if (block) {
    await ctx.route("**/*", (route) =>
      ["image", "media", "font"].includes(route.request().resourceType()) ? route.abort() : route.continue()
    );
  }
  // Put the saved sessionStorage back before any page script runs
  if (fs.existsSync(sessionFile(acc))) {
    const store = JSON.parse(fs.readFileSync(sessionFile(acc), "utf8"));
    await ctx.addInitScript((saved) => {
      try {
        const items = saved[location.origin];
        if (items && !sessionStorage.getItem("__restored")) {
          for (const [k, v] of Object.entries(items)) if (sessionStorage.getItem(k) === null) sessionStorage.setItem(k, v);
          sessionStorage.setItem("__restored", "1");
        }
      } catch (e) {}
    }, store);
  }
  ctx.on("close", () => contexts.delete(acc.name));
  contexts.set(acc.name, ctx);
  return ctx;
}

const sessionFile = (acc) => path.join(DATA_DIR, `${safe(acc.name)}.session.json`);

// Save the login: cookies and localStorage (storageState) plus sessionStorage of the open pages
const saveState = async (acc) => {
  const ctx = contexts.get(acc.name);
  if (!ctx) return;
  await ctx.storageState({ path: stateFile(acc) }).catch(() => {});
  const store = fs.existsSync(sessionFile(acc)) ? JSON.parse(fs.readFileSync(sessionFile(acc), "utf8")) : {};
  for (const p of ctx.pages()) {
    try {
      const origin = new URL(p.url()).origin;
      if (!/^https?:/.test(origin)) continue;
      const items = await p.evaluate(() => Object.fromEntries(Object.entries(sessionStorage)));
      if (Object.keys(items).length) store[origin] = items;
    } catch (e) {}
  }
  fs.writeFileSync(sessionFile(acc), JSON.stringify(store));
};

// ---------- page helpers ----------
const isAuth = (page) => /auth\.hiring\.amazon|[#/]login(\?|\/|$)/i.test(page.url());

const buttons = (page) =>
  page
    .evaluate(() => {
      const label = (el) => (el.innerText || el.value || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
      return [...new Set(
        [...document.querySelectorAll("button, [role=button], input[type=submit]")]
          .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !el.disabled; })
          .map(label)
          .filter(Boolean)
      )].slice(0, 30);
    })
    .catch(() => []);

// Find the first visible button whose text matches one of the patterns, tag it, return its text
const mark = (page, sources) =>
  page
    .evaluate((srcs) => {
      document.querySelectorAll("[data-sb-hit]").forEach((e) => e.removeAttribute("data-sb-hit"));
      const label = (el) => (el.innerText || el.value || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
      const els = [...document.querySelectorAll("button, [role=button], a[href], input[type=submit]")].filter((el) => {
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && !el.disabled && el.getAttribute("aria-disabled") !== "true";
      });
      for (const src of srcs) {
        const re = new RegExp(src, "i");
        const hit = els.find((e) => re.test(label(e)));
        if (hit) { hit.setAttribute("data-sb-hit", "1"); return label(hit); }
      }
      return null;
    }, sources)
    .catch(() => null);

// Is there a button with the right name that is not usable yet (greyed out / hidden)?
const probe = (page, sources) =>
  page
    .evaluate((srcs) => {
      const label = (el) => (el.innerText || el.value || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
      const els = [...document.querySelectorAll("button, [role=button], a[href], input[type=submit]")];
      for (const src of srcs) {
        const re = new RegExp(src, "i");
        const el = els.find((e) => re.test(label(e)));
        if (!el) continue;
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        const why = el.disabled ? "disabled" : el.getAttribute("aria-disabled") === "true" ? "greyed out" :
          r.width === 0 || r.height === 0 || st.visibility === "hidden" ? "hidden" : "ready";
        return { label: label(el), why };
      }
      return null;
    }, sources)
    .catch(() => null);

const clickMarked = async (page) => {
  try {
    await page.locator('[data-sb-hit="1"]').first().click({ timeout: 6000 });
    return true;
  } catch (e) {
    return false;
  }
};

// Press the tagged button. If something is covering it, fall back to a direct click on the element.
async function press(page) {
  try {
    await page.locator('[data-sb-hit="1"]').first().click({ timeout: 3000 });
    return true;
  } catch (e) {
    return page
      .evaluate(() => {
        const el = document.querySelector('[data-sb-hit="1"]');
        if (!el) return false;
        el.scrollIntoView({ block: "center" });
        el.click();
        return true;
      })
      .catch(() => false);
  }
}

// Cookie banner, announcement and sticky alerts can cover the buttons. Close them first.
const OVERLAYS = [
  "^continue\\s*without accepting cookies$", "^accept all( cookies)?$", "^close cookie consent",
  "^dismiss announcement$", "^close sticky alerts$",
];
async function dismissOverlays(page) {
  for (const src of OVERLAYS) {
    if (await mark(page, [src])) {
      await press(page);
      await sleep(300);
    }
  }
}

const isLoading = (page) =>
  page.evaluate(() => { const e = document.querySelector(".loadingBackground"); return !!e && e.getBoundingClientRect().height > 0; }).catch(() => false);

const pageText = (page) =>
  page.evaluate(() => ((document.querySelector("main, [role=main]") || document.body).innerText || "").replace(/\s+/g, " ").trim()).catch(() => "");

const errorBanner = (page) =>
  page
    .evaluate(() => {
      const btn = [...document.querySelectorAll("button, [role=button]")].find((b) =>
        /close error message/i.test((b.getAttribute("aria-label") || "") + " " + (b.innerText || ""))
      );
      if (!btn || btn.getBoundingClientRect().height === 0) return "";
      let el = btn;
      for (let i = 0; i < 5 && el.parentElement; i++) {
        el = el.parentElement;
        const t = (el.innerText || "").replace(/\s+/g, " ").trim();
        if (t.length > 15) return t.slice(0, 300);
      }
      return "(error banner shown, no text)";
    })
    .catch(() => "");

const isBlocked = async (page) => {
  const t = await page.evaluate(() => document.title + " " + (document.body ? document.body.innerText.slice(0, 400) : "")).catch(() => "");
  return /request blocked|403 error|request could not be satisfied/i.test(t);
};

// A fingerprint of what is on screen: address, buttons, input fields and the start of the text
const signature = async (page) =>
  page.url() + "|" + (await buttons(page)).join(",") + "|" +
  (await page
    .evaluate(() => {
      const inputs = [...document.querySelectorAll("input:not([type=hidden])")]
        .filter((i) => i.getBoundingClientRect().height > 0)
        .map((i) => i.type + ":" + (i.name || i.id || ""))
        .join(",");
      const text = ((document.querySelector("main, [role=main]") || document.body).innerText || "").replace(/\s+/g, " ").slice(0, 300);
      return inputs + "|" + text;
    })
    .catch(() => ""));

async function settle(page, ms = 15000) {
  const end = Date.now() + ms;
  let last = page.url(), since = Date.now();
  await page.waitForLoadState("domcontentloaded", { timeout: ms }).catch(() => {});
  while (Date.now() < end) {
    await sleep(250);
    const now = page.url();
    if (now !== last) { last = now; since = Date.now(); continue; }
    if (await isLoading(page)) { since = Date.now(); continue; }
    if (Date.now() - since > 1200) return;
  }
}

async function waitChange(page, before, ms = 15000) {
  const end = Date.now() + ms;
  await sleep(500);
  while (Date.now() < end) {
    if (!(await isLoading(page)) && (await signature(page)) !== before) return true;
    await sleep(300);
  }
  return false;
}

async function waitFor(page, sources, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await mark(page, sources)) return true;
    await sleep(350);
  }
  return false;
}

// Type like a person: click the box, then press the keys one by one
async function typeInto(el, text) {
  await el.click({ timeout: 5000 }).catch(() => {});
  await el.fill("").catch(() => {});
  await el.pressSequentially(String(text), { delay: 45 });
}

// What the login page itself says is wrong (red text, alerts)
const loginErrors = (page) =>
  page
    .evaluate(() =>
      [...document.querySelectorAll('[role=alert], [aria-live], [class*="error" i], [class*="Error"], [data-test-component*="Flash"]')]
        .filter((e) => e.getBoundingClientRect().height > 0)
        .map((e) => (e.innerText || "").replace(/\s+/g, " ").trim())
        .filter((t) => t.length > 3)
        .slice(0, 4)
        .join(" | ")
    )
    .catch(() => "");

async function emptyInput(page, selector) {
  const all = page.locator(selector);
  const n = await all.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const el = all.nth(i);
    if ((await el.isVisible().catch(() => false)) && !(await el.inputValue().catch(() => "x"))) return el;
  }
  return null;
}

// ---------- login ----------
async function handleLogin(page, acc, log) {
  if (process.env.AUTO_LOGIN === "false") {
    log("Amazon is asking to log in and AUTO_LOGIN is off. Run  node login.js  to log in by hand once.");
    return false;
  }
  const recent = (acc._logins = (acc._logins || []).filter((t) => Date.now() - t < 3600000));
  if (recent.length >= 3) { log("Too many logins in the last hour, not trying again yet."); return false; }
  recent.push(Date.now());

  // Remember requests Amazon refused, so we can see why a step did not move on
  const refused = [];
  const onResponse = (r) => {
    try {
      const type = r.request().resourceType();
      if ((type === "xhr" || type === "fetch" || type === "document") && r.status() >= 400) {
        refused.push(`${r.status()} ${new URL(r.url()).host}${new URL(r.url()).pathname}`.slice(0, 90));
        if (refused.length > 6) refused.shift();
      }
    } catch (e) {}
  };
  page.on("response", onResponse);

  let codeAt = new Date();
  let codeTries = 0;
  let stalls = 0;
  for (let i = 0; i < 14 && isAuth(page); i++) {
    await settle(page, 12000);
    if (!isAuth(page)) break;
    if (await isBlocked(page)) { log("Amazon blocked this connection on the login page."); return false; }

    await dismissOverlays(page);
    const remember = page.getByLabel(/keep me signed in|remember (this|me|device)|trust this device/i).first();
    if (await remember.isVisible().catch(() => false)) await remember.check({ timeout: 3000 }).catch(() => {});

    const text = (await page.locator("body").innerText().catch(() => "")).toLowerCase();
    const before = await signature(page);
    let did = "-";

    if (/enter the verification code|verification code has been sent|verification code sent/.test(text)) {
      const box = await emptyInput(page, "input:not([type=hidden]):not([type=radio]):not([type=checkbox])");
      if (!box) {
        // The code is already typed in. Amazon shows "Verify" and then "Continue": press whichever is there.
        const next = await mark(page, LOGIN_NEXT);
        if (next) { await press(page); log(`Login: code already entered -> "${next}"`); }
        if (!(await waitChange(page, before, 15000)) && ++stalls >= 3) {
          log(`The code page did not move on. Amazon says: ${(await loginErrors(page)) || "(no message shown)"}`);
          page.off("response", onResponse);
          return false;
        }
        continue;
      }
      if (++codeTries > 2) { log("The verification code was not accepted twice."); return false; }
      log("Waiting for the verification code email...");
      let code = "";
      try { code = await waitForCode(acc, codeAt); } catch (e) { log("Could not read the email code: " + e.message); }
      if (!code) { log("No verification code arrived."); return false; }
      await typeInto(box, code);
      did = "entered the code";
      codeAt = new Date();
    } else if (/where should we send/.test(text)) {
      await page.getByText(/email verification code/i).first().click({ timeout: 5000 }).catch(() => {});
      did = "chose email code";
      codeAt = new Date();
    } else {
      const pw = await emptyInput(page, "input[type=password]");
      if (pw) { await typeInto(pw, acc.password); did = "entered password"; }
      else {
        const em = await emptyInput(page, "input[type=email], input[type=text], input[type=tel]");
        if (em) { await typeInto(em, acc.email); did = "entered email"; }
      }
    }

    const name = await mark(page, LOGIN_NEXT);
    if (name) await press(page);
    log(`Login: ${did} -> ${name ? `"${name}"` : "no button"}`);
    const moved = await waitChange(page, before, 25000);

    // The page did not move on: stop instead of pressing the button again and again
    if (!moved && name) {
      if (++stalls >= 2 || did === "-") {
        const errs = await loginErrors(page);
        log(`Login is stuck on this screen. Amazon says: ${errs || "(no message shown)"}`);
        log(`Refused requests: ${refused.join(" ; ") || "none"}`);
        try {
          fs.mkdirSync(path.join(DATA_DIR, "shots"), { recursive: true });
          await page.screenshot({ path: path.join(DATA_DIR, "shots", `${safe(acc.name)}-login-stuck.png`), fullPage: true });
        } catch (e) {}
        page.off("response", onResponse);
        return false;
      }
    } else {
      stalls = 0;
    }
  }
  page.off("response", onResponse);

  if (isAuth(page)) {
    log(`Login did not finish. Buttons: ${(await buttons(page)).join(" | ")}. Page: ${(await pageText(page)).slice(0, 200)}`);
    return false;
  }
  await saveState(acc);
  log("Logged in.");
  return true;
}

// Log in ahead of time so the first shift is not slowed down by the login
async function warmLogin(acc, log) {
  const ctx = await getContext(acc);
  const page = await ctx.newPage();
  try {
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
    await settle(page);
    if (await isBlocked(page)) return { ok: false, reason: "IP_BLOCKED" };
    if (!isAuth(page)) { log("Already logged in."); return { ok: true }; }
    const ok = await handleLogin(page, acc, log);
    return ok ? { ok: true } : { ok: false, reason: "LOGIN_FAILED" };
  } catch (e) {
    return { ok: false, reason: e.message.split("\n")[0] };
  } finally {
    await page.close().catch(() => {});
  }
}

// ---------- apply ----------
async function applyToJob(acc, job, dryRun, log) {
  const ctx = await getContext(acc);
  let page = await ctx.newPage();
  const opened = [page];
  let popup = null;
  const onPage = (p) => { popup = p; opened.push(p); };
  ctx.on("page", onPage);
  const jobId = (job.url.match(/jobId=([A-Za-z0-9-]+)/) || [])[1] || "";
  let committed = false; // true once "Start Application" was pressed: an application now exists
  const done = (ok, reason, message) => ({ ok, reason, message, committed });
  // Any page of Amazon's assessment (by address, heading or wording). The bot must not touch these.
  const onAssessment = async () => {
    if (/assess/i.test(page.url())) return true;
    if (await mark(page, ASSESSMENT)) return true;
    const head = await page.evaluate(() => [...document.querySelectorAll("h1, h2")].map((h) => h.innerText).join(" | ").slice(0, 300)).catch(() => "");
    if (/assessment/i.test(head)) return true;
    return /work situations|five sections|start assessment|assessment instructions/i.test((await pageText(page)).slice(0, 700));
  };
  // The address carries an application id once an application exists. After that the bot does not click.
  const applicationExists = () => /applicationId=/i.test(page.url());

  // Remember slow and failed requests, to see what the application page is waiting for
  const started = new Map();
  const slow = [];
  const failed = [];
  const short = (u) => { try { const x = new URL(u); return (x.host + x.pathname).slice(0, 70); } catch (e) { return String(u).slice(0, 70); } };
  const onReq = (r) => started.set(r, Date.now());
  const onFin = (r) => { const t = started.get(r); started.delete(r); if (t && Date.now() - t > 4000) slow.push([Date.now() - t, short(r.url())]); };
  const onFail = (r) => { started.delete(r); if (failed.length < 5) failed.push(`${short(r.url())} (${(r.failure() || {}).errorText || "failed"})`); };
  ctx.on("request", onReq);
  ctx.on("requestfinished", onFin);
  ctx.on("requestfailed", onFail);
  const netReport = () => {
    const fmt = (list) => list.sort((x, y) => y[0] - x[0]).slice(0, 5).map(([d, u]) => `${(d / 1000).toFixed(0)}s ${u}`).join(" ; ") || "none";
    const pending = [...started.entries()].filter(([, t]) => Date.now() - t > 4000).map(([r, t]) => [Date.now() - t, short(r.url())]);
    const realFails = failed.filter((f) => !/ERR_FAILED|ERR_ABORTED|ERR_BLOCKED/.test(f));
    return `Slow but finished: ${fmt([...slow])}. Still waiting: ${fmt(pending)}. Failed: ${realFails.slice(0, 3).join(" ; ") || "none"}`;
  };
  let reported = false;

  try {
    await page.goto(job.url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await settle(page);
    if (await isBlocked(page)) return done(false, "IP_BLOCKED", "Amazon blocked this server's connection. A UK residential proxy is needed (PROXY_SERVER).");

    // Wait for the Apply button, but give up quickly if the shift is already gone
    let ready = false;
    const until = Date.now() + 15000;
    while (Date.now() < until) {
      if (await mark(page, APPLY)) { ready = true; break; }
      if (Date.now() - (until - 15000) > 2000) {
        const text = await pageText(page);
        const gone = text.match(/[^.]*(doesn.t have available shifts|no longer available|no available shifts|has been filled)[^.]*\./i);
        let here = page.url();
        try { here = decodeURIComponent(here); } catch (_) {}
        if (gone || !here.includes(jobId)) return done(false, "SHIFT_GONE", gone ? gone[0].trim() : "The job page is no longer available.");
      }
      await sleep(350);
    }
    if (!ready) return done(false, "NO_APPLY_BUTTON", `Buttons: ${(await buttons(page)).join(" | ")}`);

    await dismissOverlays(page);
    if (!(await mark(page, APPLY)) || !(await press(page))) {
      let here = page.url();
      try { here = decodeURIComponent(here); } catch (_) {}
      if (!here.includes(jobId) || !/jobDetail/i.test(here)) return done(false, "SHIFT_GONE", "The job page is no longer available.");
      return done(false, "NO_APPLY_BUTTON", `Could not click Apply. Buttons: ${(await buttons(page)).join(" | ")}`);
    }
    const t0 = Date.now();
    const since = () => ((Date.now() - t0) / 1000).toFixed(0) + "s";
    log("Clicked Apply.");
    // The application opens in a new tab (or sometimes in the same tab). Wait for either.
    for (let i = 0; i < 48 && !popup; i++) {
      if (/\/application(\/|\?|$)/i.test(page.url()) || isAuth(page)) break;
      if (i === 16 && !popup) {
        const err = await errorBanner(page);
        if (err) return done(false, "AMAZON_ERROR", err);
        // nothing happened yet: press Apply once more
        await dismissOverlays(page);
        if (await mark(page, APPLY)) await press(page);
      }
      await sleep(250);
    }
    if (popup) { page = popup; popup = null; }
    else if (!/\/application(\/|\?|$)/i.test(page.url()) && !isAuth(page)) {
      const err = await errorBanner(page);
      return done(false, err ? "AMAZON_ERROR" : "APPLY_DID_NOT_OPEN", err || `Apply was clicked but the application did not open. Buttons: ${(await buttons(page)).join(" | ")}`);
    }

    const deadline = Date.now() + 180000;
    let last = null; // the last button we clicked: { name, url, at, commit }
    let blankSince = 0; // when the page was first seen empty (still loading)
    let idleSince = 0; // when the page was first seen loaded but with no usable button
    while (Date.now() < deadline) {
      await settle(page);
      if (await isBlocked(page)) return done(false, "IP_BLOCKED", "Amazon blocked this server's connection.");

      if (isAuth(page)) {
        if (!(await handleLogin(page, acc, log))) return done(false, "LOGIN_FAILED", "Could not log in.");
        last = null;
        continue;
      }

      const err = await errorBanner(page);
      if (err) return done(false, "AMAZON_ERROR", err);
      await dismissOverlays(page);

      // The assessment is the candidate's own test. The bot never clicks anything on it.
      if (await onAssessment()) {
        committed = true; // an application exists if Amazon is showing its assessment
        return done(true, "ASSESSMENT_NEEDED", "Amazon is showing the assessment. The candidate must complete it themselves.");
      }
      if (applicationExists()) {
        committed = true;
        return done(true, "STARTED", `An application already exists for this job. The page shows: ${(await pageText(page)).slice(0, 200)}. Buttons: ${(await buttons(page)).join(" | ")}`);
      }

      let name = await mark(page, COMMIT());
      const isCommit = !!name;
      if (!name) name = await mark(page, STEP());

      if (!name) {
        // give the page a little longer before giving up
        if (await waitFor(page, [...ASSESSMENT, ...COMMIT(), ...STEP()], 12000)) { blankSince = 0; continue; }
        if (isAuth(page)) continue;
        // An empty page means the application is still loading (it can take 20-40 seconds). Keep waiting.
        const shown = await buttons(page);
        const body = await pageText(page);
        if (!shown.length && body.length < 30) {
          if (!blankSince) { blankSince = Date.now(); log(`Application page is still loading (${since()} after Apply), waiting...`); }
          if (Date.now() - blankSince < 80000) { await sleep(1000); continue; }
          return done(false, "PAGE_DID_NOT_LOAD", `The application page stayed empty. ${netReport()}`);
        }
        // The page is showing but its button is not usable yet (greyed out while Amazon loads). Wait for it.
        if (!idleSince) {
          idleSince = Date.now();
          const st = await probe(page, [...COMMIT(), ...STEP()]);
          log(`Page is showing but no button is ready yet${st ? ` ("${st.label}" is ${st.why})` : ""} (${since()} after Apply), waiting...`);
        }
        if (Date.now() - idleSince < 60000) { await sleep(700); continue; }
        const text = (await pageText(page)).slice(0, 220);
        if (committed) return done(true, "CHECK_PAGE", `Application started. The page now shows: ${text}`);
        return done(false, "NO_BUTTON", `Buttons: ${(await buttons(page)).join(" | ")}. Page: ${text}. ${netReport()}`);
      }

      if (isCommit && dryRun) {
        return done(true, "DRY_OK", `Reached "${name}" (test mode, not clicked, nothing was created).`);
      }

      // Never press the same button again while Amazon is still working on the first press.
      // A button that creates something (Start Application) is pressed once only.
      if (last && last.name === name && last.url === page.url()) {
        const waited = Date.now() - last.at;
        if (waited < (last.commit ? 30000 : 12000)) { await sleep(500); continue; }
        if (last.commit || ++last.repeats > 1) {
          return done(last.commit, last.commit ? "CHECK_PAGE" : "STUCK", `Clicked "${name}" but the page did not move on. ${(await pageText(page)).slice(0, 160)}`);
        }
      }

      const repeats = last && last.name === name && last.url === page.url() ? last.repeats : 0;
      await mark(page, isCommit ? COMMIT() : STEP());
      if (!(await press(page))) { await sleep(500); continue; }
      if (isCommit) committed = true;
      last = { name, url: page.url(), at: Date.now(), commit: isCommit, repeats };
      blankSince = 0;
      idleSince = 0;
      if (!reported && Date.now() - t0 > 12000) { reported = true; log(`The page took ${since()} to be ready. ${netReport()}`); }
      log(`Clicked "${name}" (${since()} after Apply).`);
      await sleep(600);

      if (isCommit) {
        // "Start Application" was pressed. From here on the bot only looks, it does not click:
        // the next pages are Amazon's assessment or steps that have not been mapped yet.
        // Wait until Amazon really leaves this screen (it can take 30-60 seconds).
        const fromUrl = page.url();
        const sameButton = [`^${esc(name)}$`];
        const until = Date.now() + 120000;
        let moved = false;
        while (Date.now() < until) {
          await sleep(700);
          const errNow = await errorBanner(page);
          if (errNow) return done(false, "AMAZON_ERROR", errNow);
          if (/assess|applicationId=/i.test(page.url())) { moved = true; break; }
          if (await isLoading(page)) continue;
          // still on the same screen while the button we pressed is still showing
          if (await mark(page, sameButton)) continue;
          if (page.url() !== fromUrl || (await buttons(page)).length || (await pageText(page)).length > 30) { moved = true; break; }
        }
        await settle(page, 8000);
        log(`After "${name}": ${moved ? "Amazon moved to the next page" : "the page did not change"} (${since()} after Apply).`);
        if (await onAssessment()) {
          return done(true, "ASSESSMENT_NEEDED", "Application started. Amazon asks the candidate to complete the assessment.");
        }
        if (!moved) {
          return done(true, "PRESSED_NO_CHANGE", `"${name}" was pressed but Amazon stayed on the same page for 2 minutes. Check the account to see whether the application exists.`);
        }
        return done(true, "STARTED", `Application started. The next page shows: ${(await pageText(page)).slice(0, 200)}. Buttons: ${(await buttons(page)).join(" | ")}`);
      }
    }
    return done(committed, committed ? "CHECK_PAGE" : "TIMEOUT", (await pageText(page)).slice(0, 220));
  } catch (e) {
    try {
      fs.mkdirSync(path.join(DATA_DIR, "shots"), { recursive: true });
      await page.screenshot({ path: path.join(DATA_DIR, "shots", `${safe(acc.name)}-error.png`) });
    } catch (_) {}
    return done(false, "ERROR", e.message.split("\n")[0]);
  } finally {
    ctx.off("page", onPage);
    ctx.off("request", onReq);
    ctx.off("requestfinished", onFin);
    ctx.off("requestfailed", onFail);
    await saveState(acc);
    for (const p of opened) await p.close().catch(() => {});
  }
}

async function closeAll() {
  if (browser) await browser.close().catch(() => {});
}

module.exports = { applyToJob, warmLogin, closeAll, getContext, saveState, isAuth };