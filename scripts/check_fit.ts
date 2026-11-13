// Recomputes fit tags (BUILD_BRIEF §8) for data/companies.csv and compares them with the pre-filled `Fit tag` column.
// Usage: npx tsx scripts/check_fit.ts [YYYY-MM-DD]   (default: today)
import { readFile, writeFile } from "node:fs/promises";
import { parseCsv, toCsv } from "../src/lib/csv.ts";
import { computeFit, type CompanyInput } from "../src/lib/fit.ts";

const today = process.argv[2] ? new Date(`${process.argv[2]}T00:00:00Z`) : new Date();
const rows = parseCsv(await readFile("data/companies.csv", "utf8"));

// Pre-filled tags carry notes in brackets ("In mandate (deep tech Series A)", "Too late (acquired)"); compare the head.
const head = (t: string) => t.replace(/\s*\(.*\)\s*$/, "").trim();

let mismatches = 0;
const out = rows.map((r) => {
  const f = computeFit(r as unknown as CompanyInput, today);
  const expected = head(r["Fit tag"] ?? "");
  const ok = expected === f.tag;
  if (!ok) mismatches++;
  console.log(`${ok ? "ok " : "XX "} ${r.Company.padEnd(18)} ${f.tag.padEnd(13)} ${f.visibility.padEnd(13)} ${f.reason}${f.flags.length ? `  [${f.flags.join("; ")}]` : ""}${ok ? "" : `   (csv: ${r["Fit tag"]})`}`);
  return { company: r.Company, category: r["Greenfield category"], fit_tag: f.tag, visibility: f.visibility, reason: f.reason, flags: f.flags.join("; "), round_closed: f.roundClosed ?? "", round_announced: f.roundAnnounced ?? "", csv_fit_tag: r["Fit tag"] };
});
await writeFile("data/fit_tags.csv", toCsv(out));
console.log(`\n${rows.length - mismatches}/${rows.length} match the pre-filled Fit tag column · wrote data/fit_tags.csv`);
process.exitCode = mismatches ? 1 : 0;
