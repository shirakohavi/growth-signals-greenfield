// Step 4: AI classification (BUILD_BRIEF §6) for jobs collected without it (ATS boards, Getro).
// Only open jobs with no function yet are sent, so each role is classified once.
// Country from the ATS is kept when present; the AI only fills missing ones.
// Usage: npx tsx scripts/enrich_jobs.ts [--remote] [--limit N]
import { mkdir, writeFile } from "node:fs/promises";
import { aiErrorMessage, classifyJobs, usage, type JobToClassify } from "../src/ai/claude.ts";
import { d1ExecFile, d1Query, sq } from "../src/lib/d1.ts";
import { hasAnthropicKey, loadDevVars } from "./env.ts";

loadDevVars();
const args = process.argv.slice(2);
const remote = args.includes("--remote");
const limit = args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) : Infinity;
const BATCH = 40;

async function main() {
  if (!hasAnthropicKey()) {
    console.error("ANTHROPIC_API_KEY not set. Add a line ANTHROPIC_API_KEY=... to .dev.vars (git-ignored), then re-run.");
    process.exit(2);
  }
  const rows = d1Query<JobToClassify & { has_country: number }>(
    `SELECT CAST(j.id AS TEXT) AS id, c.name AS company, j.title, j.department, j.location, j.country IS NOT NULL AS has_country
       FROM jobs j JOIN companies c ON c.id = j.company_id
      WHERE j.is_open = 1 AND j.function IS NULL ORDER BY j.id`, remote,
  ).slice(0, limit);
  if (!rows.length) { console.log("nothing to classify"); return; }
  console.log(`classifying ${rows.length} jobs in ${Math.ceil(rows.length / BATCH)} calls`);

  const sql: string[] = [];
  let done = 0;
  let failedBatches = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    try {
      const out = await classifyJobs(batch);
      for (const r of out) {
        const country = r.country && /^[A-Z]{2}$/.test(r.country) ? r.country : null;
        sql.push(`UPDATE jobs SET function = ${sq(r.function)}, seniority = ${sq(r.seniority)}, country = COALESCE(country, ${sq(country)}) WHERE id = ${Number(r.id)};`);
      }
      done += out.length;
      if (out.length < batch.length) console.log(`  batch ${i / BATCH + 1}: ${batch.length - out.length} job(s) not returned; they stay unclassified for the next run`);
    } catch (e) {
      failedBatches++;
      console.log(`  batch ${i / BATCH + 1} failed: ${aiErrorMessage(e)} (left for next run)`);
    }
  }
  if (sql.length) {
    await mkdir("data/runs", { recursive: true });
    const path = `data/runs/enrich-${new Date().toISOString().slice(0, 10)}.sql`;
    await writeFile(path, sql.join("\n") + "\n");
    d1ExecFile(path, remote);
  }
  console.log(`classified ${done}/${rows.length} · failed batches ${failedBatches} · AI calls ${usage.calls} (${usage.input} in / ${usage.output} out tokens)`);
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
