// One command for the whole run: collect → enrich → footprint → compare → score → dashboard.
// Each step is its own script (they can still be run alone). Stops at the first step that fails; sources that
// fail inside a step don't fail the step (they keep their last data, marked "not reached").
// Prints "::step i/n key label" and "::done ok|failed" lines, which scripts/serve.ts reads for the Run now button.
// Usage: npx tsx scripts/pipeline.ts [--remote] [--dry-run]
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const dry = args.includes("--dry-run");
const pass = args.filter((a) => a === "--remote");

export const STEPS: { key: string; label: string; script: string }[] = [
  { key: "ats", label: "Job boards (Greenhouse, Lever, Ashby, Comeet)", script: "scripts/collect_ats.ts" },
  { key: "pages", label: "Getro boards and careers pages (AI extraction)", script: "scripts/collect_pages.ts" },
  { key: "enrich", label: "Classify roles: function, seniority, country (AI)", script: "scripts/enrich_jobs.ts" },
  { key: "footprint", label: "Sitemaps, About pages and news in English and Hebrew (AI)", script: "scripts/collect_footprint.ts" },
  { key: "compare", label: "Compare with last run: new, closed, reposted roles", script: "scripts/compare.ts" },
  { key: "dummy", label: "Dummy history where no real history exists", script: "scripts/seed_dummy_history.ts" },
  { key: "score", label: "Score, rank and write reason lines (AI)", script: "scripts/score.ts" },
  { key: "dashboard", label: "Build the dashboard", script: "scripts/build_dashboard.ts" },
];

function run(script: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("npx", ["tsx", script, ...(script.includes("build_dashboard") ? [] : pass)], { stdio: "inherit" });
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

const started = Date.now();
for (const [i, s] of STEPS.entries()) {
  console.log(`::step ${i + 1}/${STEPS.length} ${s.key} ${s.label}`);
  const t = Date.now();
  const code = dry ? await new Promise<number>((r) => setTimeout(() => { console.log(`(dry run) would run ${s.script}`); r(0); }, 1500)) : await run(s.script);
  if (code !== 0) {
    console.log(`::done failed ${s.key}`);
    console.error(`Step "${s.label}" failed (exit ${code}). Earlier steps are saved; fix it and run again.`);
    process.exit(code);
  }
  console.log(`   ${s.key} done in ${Math.round((Date.now() - t) / 1000)} s`);
}
console.log(`::done ok`);
console.log(`Pipeline finished in ${Math.round((Date.now() - started) / 60000)} min. Open public/index.html (npm run serve).`);
