// Tests for "one hiring wave counts once" and "company size is context only".
// Run: npm run test:grouping
import { scoreCompany, type CompanyIn, type JobIn, type SnapshotIn } from "../src/scoring/signals.ts";

const today = "2026-11-13";
const co: CompanyIn = { id: 1, name: "TestCo", hq_country: "IL", last_round: "Series B", round_closed: "2026-06-01", fit_tag: "In mandate",
  fit_visibility: "ranked", greenfield_status: "open", job_source_type: "greenhouse", headcount: null };
const job = (p: Partial<JobIn>): JobIn => ({ title: "Account Executive", function: "Sales", seniority: "IC", country: "US", url: null,
  posted_date: "2026-11-01", first_seen: "2026-11-12", is_baseline: 1, is_repost: 0, source: "greenhouse", ...p });
const snaps: SnapshotIn[] = [{ run_date: today, open_jobs: 14, is_dummy: 0, coverage: "full", sources_checked: null }];
const has = (r: ReturnType<typeof scoreCompany>, key: string) => r.signals.find((s) => s.key === key);

// One wave: 6 recent US sales roles + 4 recent R&D roles, and 4 older R&D roles (so the mix shifts to GTM).
const jobs = [
  ...[1, 2, 3, 4, 5, 6].map((i) => job({ title: `AE ${i}` })),
  ...[1, 2, 3, 4].map((i) => job({ title: `Engineer ${i}`, function: "R&D", country: "IL" })),
  ...[1, 2, 3, 4].map((i) => job({ title: `Old engineer ${i}`, function: "R&D", country: "IL", posted_date: "2026-05-01" })),
];

const checks: [string, boolean][] = [];
const check = (name: string, ok: boolean) => checks.push([name, ok]);

const r = scoreCompany(co, jobs, [], snaps, today);
const b = has(r, "gtm_buildout"), s = has(r, "speeding_up"), m = has(r, "gtm_mix"), d = has(r, "rd_buildup");
check("all four wave signals fire", !!(b && s && m && d));
check("strongest (GTM build-out) counts in full", b?.value === 20);
check("speeding up counts half (15 -> 7.5)", s?.value === 7.5 && /half: same hiring wave as GTM team build-out/.test(s.detail));
check("mix shift counts half (10 -> 5)", m?.value === 5);
check("R&D build-up counts half (5 -> 2.5)", d?.value === 2.5);
// The US first-run market hint (+15) is not added: the same US roles already earned GTM build-out (count once).
check("score = 20 + 7.5 + 5 + 2.5 = 35 (no US market hint on top of the US build-out)", r.score === 35 && !has(r, "new_market:US"));

// Size is context only: a tiny or a huge headcount gives the same score, and size is still reported.
const small = scoreCompany({ ...co, headcount: 20 }, jobs, [], snaps, today);
const big = scoreCompany({ ...co, headcount: 2000 }, jobs, [], snaps, today);
check("headcount does not change the score", small.score === r.score && big.score === r.score);
check("no size_intensity signal", !has(small, "size_intensity"));
check("size still reported for the page (14 of 20 = 70%)", small.size?.pct === 70 && big.size?.pct === 1);
check("unknown headcount -> size null", r.size === null);

const failed = checks.filter(([, ok]) => !ok);
for (const [name, ok] of checks) console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
console.log(`${checks.length - failed.length}/${checks.length} passed`);
process.exit(failed.length ? 1 : 0);
