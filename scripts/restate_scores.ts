// Restates past runs' scores under today's rules, so the ▲▼ change and the score chart show changes in the
// data, not rule changes. Works from each past run's stored signals (scores.signals_json); no AI, no scraping.
// Rules applied (BUILD_BRIEF §10):
//  - Count a market once (18 Nov 2026): a first-run market hint (indirect new_market) is dropped when the
//    run's GTM build-out counts the same country.
//  - Undated news never scores a market (18 Nov 2026): a new_market signal with no date that isn't based on
//    job posts (from an office/team mention in news) is dropped.
// Usage: npx tsx scripts/restate_scores.ts [--remote] [--dry-run]
import { writeFile, mkdir } from "node:fs/promises";
import { d1ExecFile, d1Query, sq } from "../src/lib/d1.ts";
import { bandOf } from "../src/scoring/signals.ts";

type Sig = { key: string; value: number; evidence: number; detail: string; points: number; date: string | null };
const remote = process.argv.includes("--remote"), dry = process.argv.includes("--dry-run");
const latest = d1Query<{ d: string }>("SELECT MAX(run_date) AS d FROM scores", remote)[0]?.d;
const rows = d1Query<{ company_id: number; name: string; run_date: string; score: number; signals_json: string }>(
  `SELECT s.company_id, c.name, s.run_date, s.score, s.signals_json FROM scores s JOIN companies c ON c.id = s.company_id WHERE s.run_date < ${sq(latest)} ORDER BY s.run_date, c.name`, remote);

const sql: string[] = [];
for (const r of rows) {
  const sigs = JSON.parse(r.signals_json || "[]") as Sig[];
  const built = sigs.find((s) => s.key === "gtm_buildout")?.detail.match(/ in ([A-Z]{2})\b/)?.[1];
  const undatedNews = (s: Sig) => s.key.startsWith("new_market:") && !s.date && !/open GTM role/.test(s.detail);
  const keep = sigs.filter((s) => !(built && s.key === `new_market:${built}` && s.evidence < 1) && !undatedNews(s));
  if (keep.length === sigs.length) continue;
  const score = Math.max(0, Math.min(100, Math.round(keep.reduce((a, s) => a + s.value, 0))));
  console.log(`${r.run_date}  ${r.name.padEnd(18)} ${r.score} -> ${score}`);
  sql.push(`UPDATE scores SET score = ${score}, band = ${sq(bandOf(score))}, decline_flag = ${keep.some((s) => s.points < 0) ? 1 : 0}, signals_json = ${sq(JSON.stringify(keep))} WHERE company_id = ${r.company_id} AND run_date = ${sq(r.run_date)};`);
}
console.log(`${sql.length} past scores restated (runs before ${latest})`);
if (sql.length && !dry) {
  await mkdir("data/runs", { recursive: true });
  const path = `data/runs/restate-${latest}.sql`;
  await writeFile(path, sql.join("\n") + "\n");
  d1ExecFile(path, remote);
}
