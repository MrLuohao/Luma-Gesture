const fs = require("node:fs");
const path = require("node:path");

function unquoteEnvValue(value) {
  const trimmed = String(value || "").trim();
  if (trimmed.length < 2) return trimmed;
  const quote = trimmed[0];
  if ((quote !== "\"" && quote !== "'") || trimmed[trimmed.length - 1] !== quote) {
    return trimmed;
  }
  return trimmed.slice(1, -1);
}

function loadLocalEnv(rootDir) {
  const envPath = path.join(rootDir, ".env");
  if (!fs.existsSync(envPath)) return;

  const content = fs.readFileSync(envPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    if (process.env[key]) continue;
    process.env[key] = unquoteEnvValue(rawValue);
  }
}

module.exports = { loadLocalEnv };
