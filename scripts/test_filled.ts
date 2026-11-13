// Tests for closed roles: "likely filled" keeps a build-out's points; "Hiring paused" only when roles look pulled.
// Run: npm run test:filled
import { scoreCompany, type ClosedJobIn, type CompanyIn, type EventIn, type JobIn, type SnapshotIn } from "../src/scoring/signals.ts";

const today = "2027-01-12";
const co: CompanyIn = { id: 1, name: "TestCo", hq_country: "IL", last_round: "Series B", round_closed: "2026-06-01", fit_tag: "In mandate",
  fit_visibility: "ranked", greenfield_status: "open", job_source_type: "greenhouse", headcount: null };
const job = (p: Partial<JobIn>): JobIn => ({ title: "Account Executive", function: "Sales", seniority: "IC", country: "US", url: null,
  posted_date: null, first_seen: "2026-12-12", is_baseline: 0, is_repost: 0, source: "greenhouse", ...p });
const closedJob = (p: Partial<ClosedJobIn>): ClosedJobIn => ({ ...job({}), closed_date: "2027-01-12", ...p });
const snap = (run_date: string, open_jobs: number): SnapshotIn => ({ run_date, open_jobs, is_dummy: 0, coverage: "full", sources_checked: null });
const snaps = [snap("2026-11-12", 10), snap("2026-12-12", 10), snap("2027-01-12", 4)];
const fresh = job({ title: "Backend Engineer", function: "R&D", country: "IL", first_seen: "2027-01-12" }); // keeps posting
const has = (r: ReturnType<typeof scoreCompany>, key: string) => r.signals.find((s) => s.key === key);

const checks: [string, boolean][] = [];
const check = (name: string, ok: boolean) => checks.push([name, ok]);

// 1. Filled: 2 US sales roles still open + 3 that closed after ~6 weeks while the company keeps posting -> build-out holds.
const filled = [1, 2, 3].map((i) => closedJob({ title: `AE ${i}`, posted_date: "2026-11-25", closed_date: "2027-01-12" }));
let r = scoreCompany(co, [job({}), job({ title: "SDR" }), fresh], [], snaps.slice(0, 2).concat(snap("2027-01-12", 7)), today, filled);
check("filled roles keep the GTM build-out (2 open + 3 filled = 5)", !!has(r, "gtm_buildout") && /5 GTM roles in US, 3 now likely filled/.test(has(r, "gtm_buildout")!.detail));
check("filled roles are counted", r.filled === 3);
check("filled roles never trigger Hiring paused", !has(r, "hiring_paused"));

// 2. Closed after only 5 days -> not "filled" (likely pulled or a mistake).
r = scoreCompany(co, [job({}), fresh], [], snaps, today, [closedJob({ posted_date: "2027-01-07" })]);
check("a role closed after 5 days is not counted as filled", r.filled === 0);

// 3. Pulled: 6 of 10 roles close in one run and nothing new is posted -> Hiring paused.
const pulled = [1, 2, 3, 4, 5, 6].map((i) => closedJob({ title: `Role ${i}`, first_seen: "2026-11-12", is_baseline: 1 }));
const old = [1, 2, 3, 4].map((i) => job({ title: `Old ${i}`, posted_date: "2026-09-01", first_seen: "2026-11-12", is_baseline: 1 }));
r = scoreCompany(co, old, [], snaps, today, pulled);
check("mass closure with no new posts -> Hiring paused", !!has(r, "hiring_paused") && r.decline_flag);
check("pulled roles are not counted as filled", r.filled === 0);

// 4. Same mass closure but the company keeps posting -> no penalty.
r = scoreCompany(co, [...old, fresh], [], snaps, today, pulled);
check("mass closure while still posting -> no Hiring paused", !has(r, "hiring_paused"));

// 5. Roles down 50%+ alone (old rule) -> no penalty without layoff/freeze news...
const down = [snap("2026-11-12", 10), snap("2027-01-12", 4)];
r = scoreCompany(co, old, [], down, today, []);
check("fewer open roles alone is not a penalty", !has(r, "hiring_paused"));
// ...but with a hiring-freeze report it is.
const freeze: EventIn = { type: "plan", value: "Company announced a hiring freeze", event_date: "2026-12-20", evidence: "direct", source_url: "https://example.com/n", is_dummy: 0 };
r = scoreCompany(co, old, [freeze], down, today, []);
check("roles down 50%+ with hiring-freeze news -> Hiring paused", !!has(r, "hiring_paused"));

const failed = checks.filter(([, ok]) => !ok);
for (const [name, ok] of checks) console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
console.log(`${checks.length - failed.length}/${checks.length} passed`);
process.exit(failed.length ? 1 : 0);
