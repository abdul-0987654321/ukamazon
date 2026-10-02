// Reads the public channel page (t.me/s/<channel>) and picks the shifts that match the filters.
const ShiftParser = (() => {
  const decodeOnce = (s) =>
    s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, " ");
  const decode = (s) => {
    let prev;
    do { prev = s; s = decodeOnce(s); } while (s !== prev);
    return s;
  };
  const stripTags = (html) => decode(html.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, ""));

  // -> [{ id, text, links: [{ label, url }] }] oldest first
  function parsePage(html) {
    const posts = [];
    for (const block of html.split(/data-post="/).slice(1)) {
      const id = Number((block.match(/^[^/"]+\/(\d+)"/) || [])[1]);
      const body = (block.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/) || [])[1];
      if (!id || !body) continue;
      const links = [];
      body.replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, url, label) => {
        links.push({ url: decode(url), label: stripTags(label).replace(/^[^\p{L}\p{N}]+/u, "").trim() });
      });
      // when the post was published (the page gives it as <time datetime="...">)
      const stamp = (block.match(/<time[^>]*datetime="([^"]+)"/) || [])[1];
      const time = stamp ? Date.parse(stamp) : 0;
      posts.push({ id, text: stripTags(body).trim(), links, time: Number.isNaN(time) ? 0 : time });
    }
    return posts.sort((a, b) => a.id - b.id);
  }

  function parsePost(post) {
    const lines = post.text.split("\n").map((l) => l.trim());
    const pick = (re) => (lines.find((l) => re.test(l)) || "").toLowerCase();
    return {
      id: post.id,
      text: post.text,
      location: (lines[0] || "").toLowerCase(),
      job: pick(/associate|operative|driver|warehouse/i),
      type: pick(/full-time|part-time|reduced|flex/i),
      shifts: post.links
        .filter((l) => /jobId=/i.test(l.url))
        .map((l) => {
          const h = l.label.match(/\((\d+)h\)/i);
          return { text: l.label, url: l.url, hours: h ? Number(h[1]) : null };
        }),
    };
  }

  const list = (v) => (v || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const any = (arr, str) => arr.length === 0 || arr.some((k) => str.includes(k));

  function matching(post, s) {
    if (!any(list(s.locations), post.location)) return [];
    if (!any(list(s.jobs), post.job)) return [];
    if (!any(list(s.types), post.type)) return [];
    const shiftWords = list(s.shifts);
    const min = Number(s.minHours || 0), max = Number(s.maxHours || 999);
    return post.shifts.filter((sh) => {
      if (!any(shiftWords, sh.text.toLowerCase())) return false;
      if (sh.hours !== null && (sh.hours < min || sh.hours > max)) return false;
      return true;
    });
  }

  return { parsePage, parsePost, matching };
})();
if (typeof module !== "undefined") module.exports = ShiftParser;