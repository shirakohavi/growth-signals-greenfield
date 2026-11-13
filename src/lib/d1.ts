// Run SQL against D1 through wrangler (local by default, --remote for the deployed database). Node only.
import { execFileSync } from "node:child_process";

const target = (remote: boolean) => (remote ? "--remote" : "--local");

export function d1Query<T = Record<string, unknown>>(sql: string, remote = false): T[] {
  const out = execFileSync("npx", ["wrangler", "d1", "execute", "team-signals", target(remote), "--json", "--command", sql], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024,
  });
  const parsed = JSON.parse(out) as { results: T[] }[];
  return parsed.flatMap((p) => p.results ?? []);
}

export function d1ExecFile(path: string, remote = false): void {
  execFileSync("npx", ["wrangler", "d1", "execute", "team-signals", target(remote), "--file", path], { stdio: ["ignore", "ignore", "inherit"] });
}

/** SQL literal. */
export const sq = (v: string | number | boolean | null | undefined): string =>
  v === null || v === undefined ? "NULL"
    : typeof v === "number" ? (Number.isFinite(v) ? String(v) : "NULL")
    : typeof v === "boolean" ? (v ? "1" : "0")
    : `'${v.replace(/'/g, "''")}'`;
