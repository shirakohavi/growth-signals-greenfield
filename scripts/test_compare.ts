// Tests for the §7 comparison rules (src/lib/compare.ts). Run: npm run test:compare
import { isRepost, matchRenamed, titleSimilarity, type JobRow } from "../src/lib/compare.ts";

let id = 0;
const job = (p: Partial<JobRow>): JobRow => ({
  id: ++id, source: "careers_page", source_job_id: (id.toString(16) + "a".repeat(16)).slice(0, 16), title: "Engineer",
  function: "R&D", seniority: "IC", country: "IL", posted_date: null, first_seen: "2026-11-12", last_seen: "2026-11-12", is_open: 1, ...p,
});

const checks: [string, boolean][] = [];
const check = (name: string, ok: boolean) => checks.push([name, ok]);

// Title similarity
check("similar titles score >= 0.5", titleSimilarity("Backend Engineer", "Senior Backend Engineer") >= 0.5);
check("different roles score < 0.5", titleSimilarity("Backend Engineer", "Account Executive") < 0.5);

// Renamed role on a careers page (hash ids): same function/country/seniority + similar title -> same job
const oldBackend = job({ title: "Backend Engineer", last_seen: "2026-11-05", is_open: 0 });
const newBackend = job({ title: "Senior Backend Engineer (Python)" });
let pairs = matchRenamed([newBackend], [oldBackend]);
check("renamed careers-page role is matched to the old row", pairs.length === 1 && pairs[0][1].id === oldBackend.id);

// Different country -> not the same job
pairs = matchRenamed([job({ title: "Backend Engineer", country: "US" })], [job({ title: "Backend Engineer", is_open: 0 })]);
check("same title but different country is NOT matched", pairs.length === 0);

// Different seniority -> not the same job
pairs = matchRenamed([job({ title: "Backend Team Lead", seniority: "Manager" })], [job({ title: "Backend Engineer", is_open: 0 })]);
check("different seniority is NOT matched", pairs.length === 0);

// ATS jobs keep their id on rename, so the no-ID rule never touches them
pairs = matchRenamed([job({ source: "greenhouse", source_job_id: "123", title: "Backend Engineer" })], [job({ source: "greenhouse", source_job_id: "99", title: "Backend Engineer", is_open: 0 })]);
check("ATS jobs (stable ids) are never merged by title", pairs.length === 0);

// One old role matches only one new role
const old1 = job({ title: "Account Executive", function: "Sales", country: "US", is_open: 0 });
pairs = matchRenamed([job({ title: "Account Executive East", function: "Sales", country: "US" }), job({ title: "Account Executive West", function: "Sales", country: "US" })], [old1]);
check("an old role is matched at most once", pairs.length === 1);

// Best match wins, not list order (found in the 12 Nov simulation with Faye's two National Accounts roles)
const oldTI = job({ title: "National Accounts Director - TI", function: "Sales", seniority: "Manager", country: "US", is_open: 0 });
const nonTI = job({ title: "Director, National Accounts (non-TI)", function: "Sales", seniority: "Manager", country: "US" });
const ti = job({ title: "Director, National Accounts (TI)", function: "Sales", seniority: "Manager", country: "US" });
pairs = matchRenamed([nonTI, ti], [oldTI]);
check("renamed role pairs with its best match, not the first similar one", pairs.length === 1 && pairs[0][0].id === ti.id);

// Reposts
check("no previous run -> never a repost (first run is baseline)", !isRepost(job({ posted_date: "2025-01-01" }), null, []));
check("posted long before the previous run -> repost", isRepost(job({ posted_date: "2026-09-01" }), "2026-11-05", []));
check("posted after the previous run -> genuinely new", !isRepost(job({ posted_date: "2026-11-10" }), "2026-11-05", []));
check("same title+country closed earlier -> repost", isRepost(job({ title: "Data Engineer" }), "2026-11-05", [job({ title: "data engineer ", is_open: 0 })]));
check("same title, other country -> new", !isRepost(job({ title: "Data Engineer", country: "US" }), "2026-11-05", [job({ title: "Data Engineer", is_open: 0 })]));

let failed = 0;
for (const [name, ok] of checks) { if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}`); }
console.log(`\n${checks.length - failed}/${checks.length} passed`);
process.exitCode = failed ? 1 : 0;
