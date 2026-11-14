// Tests for "New market entry" across runs: countries already present at the first run are not new markets.
// Run: npx tsx scripts/test_markets.ts
import { scoreCompany, type CompanyIn, type JobIn, type SnapshotIn } from "../src/scoring/signals.ts";

const co: CompanyIn = { id: 1, name: "TestCo", hq_country: "IL", last_round: "Series B", round_closed: "2026-06-01", fit_tag: "In mandate",
  fit_visibility: "ranked", greenfield_status: "open", job_source_type: "greenhouse", headcount: null };
const job = (p: Partial<JobIn>): JobIn => ({ title: "Account Executive", function: "Sales", seniority: "IC", country: "US", url: null,
  posted_date: null, first_seen: "2026-11-12", is_baseline: 1, is_repost: 0, source: "greenhouse", ...p });
const snap = (d: string): SnapshotIn => ({ run_date: d, open_jobs: 5, is_dummy: 0, coverage: "full", sources_checked: null });
const markets = (r: ReturnType<typeof scoreCompany>) => r.signals.filter((s) => s.key.startsWith("new_market:"));

const checks: [string, boolean][] = [];
const check = (name: string, ok: boolean) => checks.push([name, ok]);

// Roles in five countries, all seen at the first run (12 Nov).
const base = ["US", "GB", "DE", "FR", "JP"].map((c) => job({ country: c, title: `AE ${c}` }));

// First run: only the strongest market counts, indirect (25 × 60% = 15).
const r1 = scoreCompany(co, base, [], [snap("2026-11-12")], "2026-11-12");
check("first run: one market, worth 15", markets(r1).length === 1 && markets(r1)[0].value === 15);

// Second run two days later, same countries: still one market at 15, the rest are presence (no jump to 100).
const r2 = scoreCompany(co, base, [], [snap("2026-11-12"), snap("2026-11-14")], "2026-11-14");
check("second run, same countries: still one market at 15", markets(r2).length === 1 && markets(r2)[0].value === 15);
check("other countries kept as presence context", r2.context.filter((c) => c.type === "presence").length === 4);

// Second run with a country that first appears after the first run: it counts in full (+25), on top.
const withNew = [...base, job({ country: "KR", title: "AE Korea", first_seen: "2026-11-14", is_baseline: 0 })];
const r3 = scoreCompany(co, withNew, [], [snap("2026-11-12"), snap("2026-11-14")], "2026-11-14");
const kr = markets(r3).find((s) => s.key === "new_market:KR");
check("country first seen after the first run counts +25", kr?.value === 25);
check("plus the first-run market at 15 (two markets in all)", markets(r3).length === 2);

// More than 90 days after the first run, old countries stop counting; only new ones do.
const r4 = scoreCompany(co, withNew.map((j) => j.country === "KR" ? { ...j, first_seen: "2027-02-20" } : j), [], [snap("2026-11-12"), snap("2027-02-20")], "2027-02-20");
check("after 90 days: only the newly entered country counts", markets(r4).length === 1 && markets(r4)[0].key === "new_market:KR");

let failed = 0;
for (const [name, ok] of checks) { console.log(`${ok ? "ok  " : "FAIL"} ${name}`); if (!ok) failed++; }
console.log(`${checks.length - failed}/${checks.length} passed`);
if (failed) process.exit(1);
