// Reads the public channel page. On a server outside Pakistan, t.me is read directly.
const { parsePage } = require("./parser");

async function fetchPosts(channel) {
  const relay = (process.env.TME_RELAY_URL || "").trim().replace(/\/$/, "");
  const url = relay
    ? `${relay}${relay.includes("?") ? "&" : "?"}channel=${encodeURIComponent(channel)}&t=${Date.now()}`
    : `https://t.me/s/${encodeURIComponent(channel)}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124 Safari/537.36" },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`channel page returned ${res.status}`);
  return parsePage(await res.text());
}

module.exports = { fetchPosts };
