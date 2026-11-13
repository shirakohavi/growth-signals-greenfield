// Builds data/job_sources_report.md from data/job_sources.json (+ companies.csv for fit context).
import { readFile, writeFile } from "node:fs/promises";
import { parseCsv } from "../src/lib/csv.ts";
import { computeFit, type CompanyInput } from "../src/lib/fit.ts";

interface Row {
  company: string; domain: string; careers_url: string; job_source_type: string; job_source_url: string;
  open_jobs: string; detection: string; confidence: string; needs_rendering: string; notes: string;
}

const rows: Row[] = JSON.parse(await readFile("data/job_sources.json", "utf8"));
const companies = new Map(parseCsv(await readFile("data/companies.csv", "utf8")).map((c) => [c.Company, c]));

const ATS = new Set(["greenhouse", "lever", "ashby", "comeet", "workable"]);
const tier = (r: Row) =>
  ATS.has(r.job_source_type) ? "ATS API (structured, dated)" :
  r.job_source_type === "getro" ? "Investor Getro board" :
  r.job_source_type === "careers_page" ? "Own careers page (render + AI)" :
  r.job_source_type === "hiring_statement" ? "Hiring statement, no listings (About page / careers@)" : "Nothing found";

const byType = new Map<string, Row[]>();
for (const r of rows) byType.set(r.job_source_type, [...(byType.get(r.job_source_type) ?? []), r]);
const byTier = new Map<string, Row[]>();
for (const r of rows) byTier.set(tier(r), [...(byTier.get(tier(r)) ?? []), r]);

const num = (s: string) => (/^\d+$/.test(s) ? Number(s) : null);
const totalJobs = rows.reduce((a, r) => a + (num(r.open_jobs) ?? 0), 0);

let md = `# Job-source report (step 1)\n\nRun: ${new Date().toISOString().slice(0, 10)} · ${rows.length} companies · ~${totalJobs} open roles found\n\n`;
md += `## By coverage tier\n\n| Tier | Companies | Count |\n|---|---|---|\n`;
for (const t of ["ATS API (structured, dated)", "Investor Getro board", "Own careers page (render + AI)", "Hiring statement, no listings (About page / careers@)", "Nothing found"]) {
  const rs = byTier.get(t) ?? [];
  md += `| ${t} | ${rs.map((r) => r.company).join(", ")} | **${rs.length}** |\n`;
}
md += `\n## By source type\n\n| Source type | Count | Companies (open roles) |\n|---|---|---|\n`;
for (const [t, rs] of [...byType.entries()].sort((a, b) => b[1].length - a[1].length)) {
  md += `| ${t} | ${rs.length} | ${rs.map((r) => `${r.company} (${r.open_jobs || "–"})`).join(", ")} |\n`;
}
// Fit tags (BUILD_BRIEF §8), recomputed from round data.
const fits = new Map([...companies.values()].map((c) => [c.Company, computeFit(c as unknown as CompanyInput)]));
md += `\n## Fit tags (§8)\n\n| Fit tag | Count | Companies |\n|---|---|---|\n`;
for (const t of ["In mandate", "Pre-Series B", "Too early", "Too late", "Portfolio", "Off-thesis"]) {
  const cs = [...fits.entries()].filter(([, f]) => f.tag === t).map(([n]) => n);
  if (cs.length) md += `| ${t} | ${cs.length} | ${cs.join(", ")} |\n`;
}
const mism = [...companies.values()].filter((c) => fits.get(c.Company)!.tag !== (c["Fit tag"] ?? "").replace(/\s*\(.*\)\s*$/, "").trim());
if (mism.length) md += `\nDiffers from the pre-filled column: ${mism.map((c) => `${c.Company} (computed ${fits.get(c.Company)!.tag}, csv "${c["Fit tag"]}")`).join("; ")}\n`;
md += `\n## All companies\n\n| # | Company | Category | Fit tag | Domain | Source | Open roles | Confidence | Status in list | Notes |\n|---|---|---|---|---|---|---|---|---|---|\n`;
rows.forEach((r, i) => {
  const c = companies.get(r.company);
  const gf = c?.["Greenfield status"] ?? "";
  const status = /PORTFOLIO/i.test(gf) ? "portfolio (hidden)" : /conflict/i.test(gf) ? "possible conflict" : "";
  const f = fits.get(r.company);
  md += `| ${i + 1} | ${r.company} | ${c?.["Greenfield category"] ?? ""} | ${f?.tag ?? ""}${f?.flags.some((x) => x.startsWith("possible conflict")) ? " ⚑" : ""} | ${r.domain} | ${r.job_source_type}${r.needs_rendering === "yes" ? " (JS)" : ""} | ${r.open_jobs || "–"} | ${r.confidence} | ${status} | ${r.notes.replace(/\|/g, "/").slice(0, 220)} |\n`;
});
await writeFile("data/job_sources_report.md", md);
console.log(md.split("## All companies")[0]);
