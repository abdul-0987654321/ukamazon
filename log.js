// Small in-memory log shown on the status page (also printed to the console).
const lines = [];
function log(text, who = "") {
  const line = `${new Date().toISOString().slice(11, 19)} ${who ? "[" + who + "] " : ""}${text}`;
  console.log(line);
  lines.push(line);
  if (lines.length > 400) lines.shift();
}
module.exports = { log, lines };
