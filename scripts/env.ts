// Loads .dev.vars (the file wrangler uses for local secrets) into process.env for Node scripts,
// so ANTHROPIC_API_KEY lives in one git-ignored place. Never prints values.
import { existsSync, readFileSync } from "node:fs";

export function loadDevVars(path = ".dev.vars"): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]]) continue;
    process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
  }
}

export const hasAnthropicKey = () => Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
