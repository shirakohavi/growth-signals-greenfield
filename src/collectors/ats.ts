// Step 3: ATS collectors (BUILD_BRIEF §5 rows 1–4). Each returns jobs in one shape.
// No Node APIs here: the HTTP function is passed in, so the same code runs locally (politeFetch) and in the Worker.
import { safeLocation, toCountry } from "../lib/country.ts";

export type AtsSource = "greenhouse" | "lever" | "ashby" | "comeet";

export interface Http {
  (url: string, opts?: { json?: boolean; respectRobots?: boolean }): Promise<{ ok: boolean; status: number; body: string; url: string; error?: string }>;
}

/** One job as collected. function/seniority are filled by the AI step (step 4). */
export interface CollectedJob {
  source: AtsSource;
  source_job_id: string;
  title: string;
  department: string | null;
  location: string | null;   // city/region name only, never a street address
  country: string | null;    // ISO 3166-1 alpha-2 when known
  is_remote: boolean | null;
  posted_date: string | null; // YYYY-MM-DD, only when the ATS gives a real "published/created" date
  source_updated: string | null; // ISO timestamp of the ATS "updated" field (NOT a posting date)
  url: string | null;
}

export interface CollectResult {
  source: AtsSource;
  status: "ok" | "empty" | "failed";
  jobs: CollectedJob[];
  error?: string;
  endpoint: string; // safe to log: tokens redacted
}

const day = (iso: string | number | null | undefined): string | null => {
  if (iso === null || iso === undefined || iso === "") return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};
const clean = (s: string | null | undefined) => (s ? s.replace(/\s+/g, " ").trim() || null : null);

async function getJson<T>(http: Http, url: string): Promise<{ data?: T; status: number; error?: string }> {
  const r = await http(url, { json: true });
  if (!r.ok) return { status: r.status, error: r.error ?? `HTTP ${r.status}` };
  try { return { status: r.status, data: JSON.parse(r.body) as T }; } catch { return { status: r.status, error: "invalid JSON" }; }
}

const result = (source: AtsSource, endpoint: string, jobs: CollectedJob[]): CollectResult =>
  ({ source, endpoint, jobs, status: jobs.length ? "ok" : "empty" });
const failed = (source: AtsSource, endpoint: string, error: string): CollectResult => ({ source, endpoint, jobs: [], status: "failed", error });

// ---------------------------------------------------------------- Greenhouse
interface GhJob {
  id: number; title: string; absolute_url?: string; updated_at?: string; first_published?: string;
  location?: { name?: string }; departments?: { name: string }[]; offices?: { name?: string; location?: string }[];
}
export async function collectGreenhouse(http: Http, board: string): Promise<CollectResult> {
  const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs`;
  const r = await getJson<{ jobs: GhJob[] }>(http, url);
  if (!r.data) return failed("greenhouse", url, r.error ?? "no data");
  return result("greenhouse", url, (r.data.jobs ?? []).map((j) => {
    const loc = clean(j.location?.name);
    const officeLoc = j.offices?.map((o) => o.location ?? o.name).find(Boolean) ?? null;
    return {
      source: "greenhouse", source_job_id: String(j.id), title: clean(j.title) ?? "(untitled)",
      department: clean(j.departments?.map((d) => d.name).join(" / ")),
      location: safeLocation(loc), country: toCountry(loc) ?? toCountry(officeLoc), is_remote: loc ? /remote/i.test(loc) : null,
      posted_date: day(j.first_published), source_updated: j.updated_at ?? null, url: j.absolute_url ?? null,
    };
  }));
}

// ---------------------------------------------------------------- Lever
interface LeverJob {
  id: string; text: string; hostedUrl?: string; createdAt?: number; updatedAt?: number; country?: string; workplaceType?: string;
  categories?: { location?: string; allLocations?: string[]; team?: string; department?: string };
}
export async function collectLever(http: Http, site: string): Promise<CollectResult> {
  const url = `https://api.lever.co/v0/postings/${encodeURIComponent(site)}?mode=json`;
  const r = await getJson<LeverJob[]>(http, url);
  if (!r.data) return failed("lever", url, r.error ?? "no data");
  return result("lever", url, r.data.map((j) => {
    const loc = clean(j.categories?.location ?? j.categories?.allLocations?.[0]);
    return {
      source: "lever", source_job_id: j.id, title: clean(j.text) ?? "(untitled)",
      department: clean([j.categories?.department, j.categories?.team].filter(Boolean).join(" / ")),
      location: safeLocation(loc), country: (j.country && /^[A-Z]{2}$/.test(j.country) ? j.country : null) ?? toCountry(loc),
      is_remote: j.workplaceType ? j.workplaceType === "remote" : loc ? /remote/i.test(loc) : null,
      posted_date: day(j.createdAt), source_updated: j.updatedAt ? new Date(j.updatedAt).toISOString() : null, url: j.hostedUrl ?? null,
    };
  }));
}

// ---------------------------------------------------------------- Ashby
interface AshbyJob {
  id: string; title: string; jobUrl?: string; publishedAt?: string; updatedAt?: string; isListed?: boolean; isRemote?: boolean;
  location?: string; department?: string; team?: string;
  address?: { postalAddress?: { addressCountry?: string; addressLocality?: string } };
  secondaryLocations?: { location?: string }[];
}
export async function collectAshby(http: Http, board: string): Promise<CollectResult> {
  const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board)}`;
  const r = await getJson<{ jobs: AshbyJob[] }>(http, url);
  if (!r.data) return failed("ashby", url, r.error ?? "no data");
  return result("ashby", url, (r.data.jobs ?? []).filter((j) => j.isListed !== false).map((j) => {
    const loc = clean(j.location);
    const ctry = j.address?.postalAddress?.addressCountry;
    return {
      source: "ashby", source_job_id: j.id, title: clean(j.title) ?? "(untitled)",
      department: clean([j.department, j.team].filter(Boolean).join(" / ")),
      location: safeLocation(loc), country: toCountry(ctry) ?? toCountry(loc), is_remote: j.isRemote ?? null,
      posted_date: day(j.publishedAt), source_updated: j.updatedAt ?? null, url: j.jobUrl ?? null,
    };
  }));
}

// ---------------------------------------------------------------- Comeet
interface ComeetPosition {
  uid: string; name: string; department?: string | null; time_updated?: string; workplace_type?: string;
  url_active_page?: string; url_comeet_hosted_page?: string;
  location?: { name?: string; city?: string; country?: string; is_remote?: boolean } | null;
}
function comeetJobs(ps: ComeetPosition[]): CollectedJob[] {
  return ps.map((p) => ({
    source: "comeet", source_job_id: p.uid, title: clean(p.name) ?? "(untitled)", department: clean(p.department),
    // Name/city only: Comeet location objects also carry street addresses and building entrance codes.
    location: safeLocation(clean(p.location?.name ?? p.location?.city)), country: p.location?.country && /^[A-Z]{2}$/.test(p.location.country) ? p.location.country : toCountry(p.location?.name),
    is_remote: p.location?.is_remote ?? (p.workplace_type ? /remote/i.test(p.workplace_type) : null),
    posted_date: null, // Comeet has no posted/created date
    source_updated: p.time_updated ?? null, url: p.url_active_page ?? p.url_comeet_hosted_page ?? null,
  }));
}

/** Comeet public hosted page: https://www.comeet.com/jobs/{slug}/{uid} embeds COMPANY_POSITIONS_DATA (no token needed). */
export async function collectComeetPage(http: Http, slugAndUid: string): Promise<CollectResult> {
  const url = `https://www.comeet.com/jobs/${slugAndUid}`;
  const r = await http(url);
  if (!r.ok) return failed("comeet", url, r.error ?? `HTTP ${r.status}`);
  const m = r.body.match(/COMPANY_POSITIONS_DATA\s*=\s*(\[[\s\S]*?\]);/);
  if (!m) return failed("comeet", url, "COMPANY_POSITIONS_DATA not found on page");
  try { return result("comeet", url, comeetJobs(JSON.parse(m[1]) as ComeetPosition[])); }
  catch { return failed("comeet", url, "positions JSON did not parse"); }
}

/** Comeet Careers API. The token is public (embedded in the company's careers page) but is read fresh each run, never stored. */
export async function collectComeetApi(http: Http, companyUid: string, token: string): Promise<CollectResult> {
  const shown = `https://www.comeet.co/careers-api/2.0/company/${companyUid}/positions?token=<from careers page>`;
  const r = await getJson<ComeetPosition[]>(http, `https://www.comeet.co/careers-api/2.0/company/${companyUid}/positions?token=${token}`);
  if (!r.data) return failed("comeet", shown, r.error ?? "no data");
  return result("comeet", shown, comeetJobs(r.data));
}
