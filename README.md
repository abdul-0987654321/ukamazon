# Shift Bot (server version)

Runs 24/7. Watches the public Telegram channel, and for each account whose filters match a new
post it opens the shift, clicks Apply, logs in if Amazon asks (reading the email code from that
person's Gmail), clicks Next and Start Application, and stops at Amazon's assessment.

The assessment is the candidate's own test. The bot never takes it.

## Run on your own PC first (free)
1. `npm install` then `npx playwright install chromium`
2. Copy `.env.example` to `.env`. On Windows set `HEADLESS=false` and `BROWSER_CHANNEL=chrome`.
   In Pakistan also set `TME_RELAY_URL` to your Google Apps Script link.
3. Copy `accounts.example.json` to `accounts.json` and fill it in.
4. Keep `DRY_RUN=true`, set `PROCESS_OLD_POSTS=1`, then `npm start`.
5. Open http://localhost:3000 to see the status page.

## Deploy on Render
1. Put this folder in a private GitHub repository (accounts.json and .env are not uploaded).
2. Render -> New -> Web Service -> pick the repo. It detects the Dockerfile.
3. Health check path: `/health`
4. Environment variables: everything from `.env.example`, plus `ACCOUNTS_JSON` with the accounts
   as one line of JSON, and `STATUS_TOKEN` so the status page is private.
5. Amazon blocks cloud servers, so set `PROXY_SERVER` (and username/password) to a UK
   residential proxy. Without it the status page shows the accounts as "blocked".
6. Pick an instance that never sleeps and has enough memory for a browser (2 GB is a safe start).

## Statuses
- idle / applying / done: normal
- needs assessment: the application was started, the person must complete the assessment
- paused: two failures in a row, waits 15 minutes
- login failed: wrong details or the email code could not be read
- blocked: Amazon refused the connection, a proxy is needed

## Settings
- `DRY_RUN=true` stops before "Start Application". Set `false` to really apply.
- `EXTRA_STEP_BUTTONS`, `EXTRA_COMMIT_BUTTONS`: extra button texts, comma separated, if Amazon
  adds a new step.
