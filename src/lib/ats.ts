// ATS detection (from page HTML / network URLs) and public job-board API probes.
import { fetchJson, politeFetch } from "./fetch.ts";

export type AtsType =
  | "greenhouse" | "lever" | "ashby" | "comeet" | "workable"
  | "bamboohr" | "breezy" | "teamtailor" | "recruitee" | "pinpoint" | "hibob" | "getro";

export interface AtsHit {
  type: AtsType;
  slug: string;
  extra?: string; // e.g. Comeet company UID
  evidenceUrl: string;
}

const PATTERNS: { type: AtsType; re: RegExp }[] = [
  { type: "greenhouse", re: /(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/(?:embed\/job_board(?:\/js)?\?for=)?([a-z0-9_-]+)/gi },
  { type: "greenhouse", re: /boards-api\.greenhouse\.io\/v1\/boards\/([a-z0-9_-]+)/gi },
  { type: "lever", re: /jobs\.(?:eu\.)?lever\.co\/([a-z0-9_.-]+)/gi },
  { type: "lever", re: /api\.(?:eu\.)?lever\.co\/v0\/postings\/([a-z0-9_.-]+)/gi },
  { type: "ashby", re: /jobs\.ashbyhq\.com\/([a-z0-9_.%-]+)/gi },
  { type: "ashby", re: /api\.ashbyhq\.com\/posting-api\/job-board\/([a-z0-9_.%-]+)/gi },
  { type: "comeet", re: /comeet\.(?:com|co)\/jobs\/([a-z0-9_.-]+)\/([0-9A-F]{2}\.[0-9A-F]{3})/gi },
  { type: "workable", re: /apply\.workable\.com\/([a-z0-9_-]+)/gi },
  { type: "bamboohr", re: /([a-z0-9-]+)\.bamboohr\.com\/(?:careers|jobs)/gi },
  { type: "breezy", re: /([a-z0-9-]+)\.breezy\.hr/gi },
  { type: "teamtailor", re: /([a-z0-9-]+)\.teamtailor\.com/gi },
  { type: "recruitee", re: /([a-z0-9-]+)\.recruitee\.com/gi },
  { type: "pinpoint", re: /([a-z0-9-]+)\.pinpointhq\.com/gi },
  { type: "hibob", re: /app\.hibob\.com\/(?:api\/)?(?:careers|job-ad)[^"' ]*?([a-z0-9-]{3,})?/gi },
];

const IGNORE_SLUGS = new Set(["embed", "js", "v1", "api", "www", "jobs", "careers", "static", "assets", "cdn", "app"]);

/** Find ATS references in any blob of text (HTML, script bodies, a list of network URLs). */
export function detectAts(text: string, evidenceUrl: string): AtsHit[] {
  const hits = new Map<string, AtsHit>();
  // Comeet careers-website embed: config with "company-uid"/"comeet_uid" + public "token"/"comeet_token".
  // Seen forms: {"company-uid":"99.00C","token":"…"}, {"comeet_uid":…,"comeet_token":…}, const COMPANY_UID = "…"; const TOKEN = "…"
  const uid = text.match(/["']?(?:company-uid|comeet_uid|company_uid)["']?\s*[:=]\s*["']([0-9A-F]{2}\.[0-9A-F]{3})["']/i)?.[1];
  const token = text.match(/["']?(?:comeet_token|token)["']?\s*[:=]\s*["']([0-9A-F]{16,})["']/i)?.[1];
  if (uid && token) hits.set(`comeet:${uid}`, { type: "comeet", slug: uid, extra: token, evidenceUrl });
  // The page may call the Comeet API itself (seen in rendered network requests, e.g. Classiq).
  for (const m of text.matchAll(/comeet\.co(?:m)?\/careers-api\/2\.0\/company\/([0-9A-F]{2}\.[0-9A-F]{3})\/positions\?token=([0-9A-F]{16,})/gi)) {
    const id = m[1].toUpperCase();
    if (!hits.has(`comeet:${id}`)) hits.set(`comeet:${id}`, { type: "comeet", slug: id, extra: m[2], evidenceUrl });
  }
  for (const { type, re } of PATTERNS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const slug = decodeURIComponent((m[1] ?? "").toLowerCase()).replace(/[.?]+$/, "");
      if (type !== "hibob" && (!slug || IGNORE_SLUGS.has(slug))) continue;
      const key = `${type}:${slug}`;
      if (!hits.has(key)) hits.set(key, { type, slug, extra: m[2], evidenceUrl });
    }
  }
  return [...hits.values()];
}

export interface BoardProbe {
  type: AtsType;
  slug: string;
  status: "ok" | "empty" | "failed" | "not_found";
  apiUrl: string;
  boardName?: string;
  openJobs?: number;
  sampleText?: string; // a bit of job content, used to check identity
  sampleTitles?: string[];
}

interface GhJobs { jobs: { title: string; content?: string; location?: { name: string } }[] }
interface LeverPosting { text: string; descriptionPlain?: string; categories?: { location?: string } }
interface AshbyBoard { jobs: { title: string; descriptionPlain?: string; location?: string }[] }
interface WorkableAccount { name?: string; jobs?: { title: string; country?: string }[] }

function status(n: number | undefined): BoardProbe["status"] {
  return n && n > 0 ? "ok" : "empty";
}

export async function probeBoard(type: AtsType, slug: string): Promise<BoardProbe> {
  switch (type) {
    case "greenhouse": {
      const apiUrl = `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`;
      const board = await fetchJson<{ name?: string }>(`https://boards-api.greenhouse.io/v1/boards/${slug}`);
      if (board.status === 404) return { type, slug, status: "not_found", apiUrl };
      const r = await fetchJson<GhJobs>(apiUrl);
      if (!r.data) return { type, slug, status: r.status === 404 ? "not_found" : "failed", apiUrl };
      const jobs = r.data.jobs ?? [];
      return {
        type, slug, apiUrl, boardName: board.data?.name, openJobs: jobs.length, status: status(jobs.length),
        sampleTitles: jobs.slice(0, 5).map((j) => j.title),
        sampleText: jobs.slice(0, 3).map((j) => j.content ?? "").join(" ").slice(0, 6000),
      };
    }
    case "lever": {
      const apiUrl = `https://api.lever.co/v0/postings/${slug}?mode=json`;
      const r = await fetchJson<LeverPosting[]>(apiUrl);
      if (!r.data) return { type, slug, status: r.status === 404 ? "not_found" : "failed", apiUrl };
      return {
        type, slug, apiUrl, openJobs: r.data.length, status: status(r.data.length),
        sampleTitles: r.data.slice(0, 5).map((j) => j.text),
        sampleText: r.data.slice(0, 3).map((j) => j.descriptionPlain ?? "").join(" ").slice(0, 6000),
      };
    }
    case "ashby": {
      const apiUrl = `https://api.ashbyhq.com/posting-api/job-board/${slug}`;
      const r = await fetchJson<AshbyBoard>(apiUrl);
      if (!r.data) return { type, slug, status: r.status === 404 ? "not_found" : "failed", apiUrl };
      const jobs = r.data.jobs ?? [];
      return {
        type, slug, apiUrl, openJobs: jobs.length, status: status(jobs.length),
        sampleTitles: jobs.slice(0, 5).map((j) => j.title),
        sampleText: jobs.slice(0, 3).map((j) => j.descriptionPlain ?? "").join(" ").slice(0, 6000),
      };
    }
    case "workable": {
      const apiUrl = `https://apply.workable.com/api/v1/widget/accounts/${slug}`;
      const r = await fetchJson<WorkableAccount>(apiUrl);
      if (!r.data) return { type, slug, status: r.status === 404 ? "not_found" : "failed", apiUrl };
      const jobs = r.data.jobs ?? [];
      return {
        type, slug, apiUrl, boardName: r.data.name, openJobs: jobs.length, status: status(jobs.length),
        sampleTitles: jobs.slice(0, 5).map((j) => j.title),
      };
    }
    case "comeet": {
      // Public careers page: https://www.comeet.com/jobs/{slug}/{UID}. It embeds the positions list as JSON
      // (COMPANY_POSITIONS_DATA). The token-based positions API is verified in step 3.
      return probeComeetPage(slug, undefined);
    }
    default:
      return { type, slug, status: "failed", apiUrl: "" };
  }
}

interface ComeetPosition { name: string; department?: string; location?: { country?: string }; time_updated?: string; company_name?: string }

/** Comeet Careers API (verified 10 Nov 2026): uid + token are embedded in the company's careers page. */
export async function probeComeetApi(uid: string, token: string): Promise<BoardProbe> {
  const apiUrl = `https://www.comeet.co/careers-api/2.0/company/${uid}/positions?token=${token}`;
  const r = await fetchJson<ComeetPosition[]>(apiUrl);
  const shownUrl = `https://www.comeet.co/careers-api/2.0/company/${uid}/positions?token=<from careers page>`;
  if (!r.data) return { type: "comeet", slug: uid, status: r.status === 404 ? "not_found" : "failed", apiUrl: shownUrl };
  return {
    type: "comeet", slug: uid, apiUrl: shownUrl, boardName: r.data[0]?.company_name, openJobs: r.data.length,
    status: status(r.data.length), sampleTitles: r.data.slice(0, 5).map((p) => p.name),
  };
}

export async function probeComeetPage(slug: string, uid: string | undefined): Promise<BoardProbe> {
  const pageUrl = uid ? `https://www.comeet.com/jobs/${slug}/${uid}` : `https://www.comeet.com/jobs/${slug}`;
  const r = await politeFetch(pageUrl);
  if (!r.ok) return { type: "comeet", slug, status: r.status === 404 ? "not_found" : "failed", apiUrl: pageUrl };
  const m = r.body.match(/COMPANY_POSITIONS_DATA\s*=\s*(\[[\s\S]*?\]);/);
  let titles: string[] = [];
  if (m) {
    try { titles = (JSON.parse(m[1]) as { name: string }[]).map((p) => p.name); } catch { /* ignore */ }
  }
  const nameMatch = r.body.match(/COMPANY_DATA\s*=\s*\{[\s\S]*?"name"\s*:\s*"([^"]+)"/);
  return {
    type: "comeet", slug, apiUrl: r.url, boardName: nameMatch?.[1], openJobs: m ? titles.length : undefined,
    status: m ? status(titles.length) : "ok", sampleTitles: titles.slice(0, 5),
  };
}

/** Slug guesses for a company: name variants + domain stem. */
export function slugGuesses(name: string, domain: string): string[] {
  const n = name.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
  const stem = domain.toLowerCase().split(".")[0];
  const base = n.replace(/\s+(security|labs|ai|inc)$/g, "");
  return [...new Set([n.replace(/\s+/g, ""), n.replace(/\s+/g, "-"), stem, stem.replace(/-/g, ""), base.replace(/\s+/g, ""), `${base.replace(/\s+/g, "")}security`])]
    .filter((s) => s.length >= 3);
}

/** Does a probed board plausibly belong to this company (not another company with the same name)? */
export function identityCheck(p: BoardProbe, name: string, domain: string): "confirmed" | "unverified" | "mismatch" {
  const stem = domain.split(".")[0].toLowerCase();
  const text = `${p.boardName ?? ""} ${p.sampleText ?? ""}`.toLowerCase();
  if (text.includes(domain.toLowerCase()) || (stem.length > 5 && text.includes(stem))) return "confirmed";
  const nm = name.toLowerCase().split(" ")[0];
  if (p.boardName && !p.boardName.toLowerCase().includes(nm)) return "mismatch";
  // Name alone is never enough (brief §5: Grain, Ocean, Jazz, Slice collide with other companies).
  return "unverified";
}

/** Comeet position UIDs in job links (e.g. /careers/co/tel-aviv/FD.669/..., /careers/ai-researcher-c1.374).
 *  Used when a site renders Comeet positions itself without exposing the API token. */
export function comeetPositionIds(hrefs: string[]): string[] {
  const ids = new Set<string>();
  for (const h of hrefs) {
    const m = h.match(/\/careers?\/(?:co\/[^/]+\/([0-9A-F]{2}\.[0-9A-F]{3})\/|[a-z0-9-]+-([0-9a-f]{2}\.[0-9a-f]{3})(?:[/?#]|$))/i);
    const id = m?.[1] ?? m?.[2];
    if (id) ids.add(id.toUpperCase());
  }
  return [...ids];
}
