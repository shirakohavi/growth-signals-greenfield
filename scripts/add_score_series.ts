// Adds score_series to the existing public/ranking.json from local D1, without re-running scoring
// (a full score run can make new AI reason calls). score.ts emits the same field on every normal run.
// Usage: npx tsx scripts/add_score_series.ts [--remote]
import { readFile, writeFile } from "node:fs/promises";
import { d1Query, sq } from "../src/lib/d1.ts";
import { scoreSeries } from "../src/lib/score_series.ts";

const remote = process.argv.includes("--remote");
const data = JSON.parse(await readFile("public/ranking.json", "utf8")) as { run_date: string; companies: { name: string; score: number; open_jobs: number; score_series?: unknown }[] };
const ids = new Map(d1Query<{ id: number; name: string }>("SELECT id, name FROM companies", remote).map((r) => [r.name, r.id]));
const past = d1Query<{ company_id: number; run_date: string; score: number | null }>(`SELECT company_id, run_date, score FROM scores WHERE run_date < ${sq(data.run_date)}`, remote);
const snaps = d1Query<{ company_id: number; run_date: string; open_jobs: number | null; is_dummy: number }>("SELECT company_id, run_date, open_jobs, is_dummy FROM snapshots", remote);
let n = 0;
for (const c of data.companies) {
  const id = ids.get(c.name);
  if (id === undefined) continue;
  c.score_series = scoreSeries(past.filter((r) => r.company_id === id), snaps.filter((s) => s.company_id === id), { date: data.run_date, score: c.score, open: c.open_jobs });
  n++;
}
await writeFile("public/ranking.json", JSON.stringify(data, null, 2));
console.log(`score_series added for ${n} companies`);
