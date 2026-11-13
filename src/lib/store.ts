// SQL for saving one company's collection result in D1, following BUILD_BRIEF §7. Shared by every collector.
//   - same job = same (company, source, source_job_id); first_seen is set once
//   - jobs missing from a successful fetch close; a failed fetch keeps the last data
//   - undated roles seen on the company's first real run are the baseline (never "new")
import { sq } from "./d1.ts";

export type JobSource = "greenhouse" | "lever" | "ashby" | "comeet" | "getro" | "careers_page" | "aggregator";

export interface StoredJob {
  source: JobSource;
  source_job_id: string;
  title: string;
  department?: string | null;
  location?: string | null;     // city / region / country only (see safeLocation)
  country?: string | null;
  is_remote?: boolean | null;
  posted_date?: string | null;  // a real published/created date only
  source_updated?: string | null;
  url?: string | null;
  function?: string | null;     // set when the AI extracted it together with the job
  seniority?: string | null;
}

export interface SourceResult {
  source: JobSource;
  status: "ok" | "empty" | "failed";
  jobs: StoredJob[];
  error?: string;
}

export function sqlForResult(companyId: number, r: SourceResult, runDate: string, notReached: boolean): string[] {
  const cid = String(companyId);
  const out: string[] = [];
  const status = r.status === "failed" ? (notReached ? "not_reached" : "failed") : r.status;
  out.push(
    `INSERT INTO source_state (company_id, source, last_status, last_ok_date, last_error) VALUES (${cid}, ${sq(r.source)}, ${sq(status)}, ${r.status === "failed" ? "NULL" : sq(runDate)}, ${sq(r.error ?? null)})
  ON CONFLICT(company_id, source) DO UPDATE SET last_status = excluded.last_status, last_error = excluded.last_error,
    last_ok_date = COALESCE(excluded.last_ok_date, source_state.last_ok_date), updated_at = datetime('now');`,
  );
  const sourcesJson = JSON.stringify({ [r.source]: r.status });
  if (r.status === "failed") {
    out.push(`INSERT INTO snapshots (company_id, run_date, sources_checked, coverage, open_jobs, is_dummy) VALUES (${cid}, ${sq(runDate)}, ${sq(sourcesJson)}, 'low', NULL, 0)
  ON CONFLICT(company_id, run_date, is_dummy) DO UPDATE SET sources_checked = json_patch(COALESCE(snapshots.sources_checked, '{}'), excluded.sources_checked);`);
    return out;
  }
  const firstRun = `NOT EXISTS (SELECT 1 FROM snapshots WHERE company_id = ${cid} AND is_dummy = 0 AND run_date < ${sq(runDate)})`;
  // Close everything open from this source, then re-open what we saw: missing jobs end up closed.
  out.push(`UPDATE jobs SET is_open = 0 WHERE company_id = ${cid} AND source = ${sq(r.source)} AND is_open = 1;`);
  for (const j of r.jobs) {
    out.push(`INSERT INTO jobs (company_id, source, source_job_id, title, department, location, country, is_remote, url, posted_date, source_updated, function, seniority, first_seen, last_seen, is_open, is_baseline, is_dummy)
  VALUES (${cid}, ${sq(j.source)}, ${sq(j.source_job_id)}, ${sq(j.title)}, ${sq(j.department ?? null)}, ${sq(j.location ?? null)}, ${sq(j.country ?? null)}, ${sq(j.is_remote ?? null)}, ${sq(j.url ?? null)}, ${sq(j.posted_date ?? null)}, ${sq(j.source_updated ?? null)}, ${sq(j.function ?? null)}, ${sq(j.seniority ?? null)}, ${sq(runDate)}, ${sq(runDate)}, 1,
          CASE WHEN ${sq(j.posted_date ?? null)} IS NULL AND ${firstRun} THEN 1 ELSE 0 END, 0)
  ON CONFLICT(company_id, source, source_job_id) DO UPDATE SET
    title = excluded.title, department = excluded.department, location = COALESCE(excluded.location, jobs.location),
    country = COALESCE(excluded.country, jobs.country), is_remote = excluded.is_remote, url = excluded.url,
    posted_date = COALESCE(jobs.posted_date, excluded.posted_date), source_updated = excluded.source_updated,
    function = COALESCE(excluded.function, jobs.function), seniority = COALESCE(excluded.seniority, jobs.seniority),
    last_seen = excluded.last_seen, is_open = 1;`);
  }
  // open_jobs sums every source seen for the company today.
  out.push(`INSERT INTO snapshots (company_id, run_date, sources_checked, coverage, open_jobs, is_dummy) VALUES (${cid}, ${sq(runDate)}, ${sq(sourcesJson)}, ${sq(r.status === "ok" ? "full" : "partial")}, ${r.jobs.length}, 0)
  ON CONFLICT(company_id, run_date, is_dummy) DO UPDATE SET sources_checked = json_patch(COALESCE(snapshots.sources_checked, '{}'), excluded.sources_checked),
    coverage = excluded.coverage, open_jobs = (SELECT COUNT(*) FROM jobs WHERE company_id = ${cid} AND is_open = 1);`);
  return out;
}
