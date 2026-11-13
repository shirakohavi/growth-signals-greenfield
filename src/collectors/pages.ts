// Step 4 collectors that need a rendered page (Playwright locally; Browser Rendering in the Worker later):
//   - investor Getro boards (BUILD_BRIEF §5 row 5)
//   - the company's own careers page (row 6): Comeet position IDs from links when present, else AI extraction
import { createHash } from "node:crypto";
import { comeetPositionIds } from "../lib/ats.ts";
import { safeLocation, toCountry } from "../lib/country.ts";
import { render } from "../lib/render.ts";
import type { SourceResult, StoredJob } from "../lib/store.ts";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");

/** Stable id for a scraped role with no ATS id: normalised title + location. */
export const scrapedJobId = (title: string, location: string | null) =>
  hash(`${title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}|${(location ?? "").toLowerCase().trim()}`).slice(0, 16);

function daysAgo(runDate: string, n: number): string {
  const d = new Date(`${runDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/** Getro "Posted:" text -> date. "Today", "Yesterday", "15 days", "2 months", "1 year". Months/years are approximate. */
export function getroPosted(text: string | undefined, runDate: string): string | null {
  if (!text) return null;
  const t = text.trim().toLowerCase();
  if (t === "today") return runDate;
  if (t === "yesterday") return daysAgo(runDate, 1);
  const m = t.match(/(\d+)\+?\s*(day|week|month|year)s?/); // "6+ months" = at least 6 months
  if (!m) return null;
  const n = Number(m[1]);
  return daysAgo(runDate, m[2] === "day" ? n : m[2] === "week" ? n * 7 : m[2] === "month" ? n * 30 : n * 365);
}

// ------------------------------------------------------------------ Getro
export async function collectGetro(boardUrl: string, runDate: string): Promise<SourceResult & { shown?: number }> {
  const url = boardUrl.replace(/#.*$/, "").replace(/\?.*$/, "");
  const r = await render(url, 3000);
  if (!r.ok) return { source: "getro", status: "failed", jobs: [], error: "render failed" };
  if (/can.t find that page/i.test(r.text)) return { source: "getro", status: "failed", jobs: [], error: "Getro company page not found" };
  const lines = r.text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const shown = Number(r.text.match(/Showing\s+(\d+)\s+jobs?/i)?.[1] ?? NaN);
  const seen = new Set<string>();
  const jobs: StoredJob[] = [];
  for (const l of r.links) {
    const m = l.href.match(/\/companies\/[^/]+\/jobs\/(\d+)-[^#?]*/);
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    const title = l.text.replace(/\s+/g, " ").trim();
    // Card text: "<title>" "Location:" "<loc>" "Posted:" "<age>"
    const i = lines.findIndex((x, k) => x === title && lines[k + 1] === "Location:");
    const loc = i >= 0 ? lines[i + 2] : null;
    const posted = i >= 0 && lines[i + 3] === "Posted:" ? lines[i + 4] : undefined;
    jobs.push({
      source: "getro", source_job_id: m[1], title, location: safeLocation(loc), country: toCountry(loc),
      is_remote: loc ? /remote/i.test(loc) : null, posted_date: getroPosted(posted, runDate), url: l.href.replace(/#.*$/, ""),
    });
  }
  const res: SourceResult & { shown?: number } = { source: "getro", status: jobs.length ? "ok" : "empty", jobs, shown: Number.isNaN(shown) ? undefined : shown };
  if (res.shown !== undefined && res.shown > jobs.length) res.error = `page says ${res.shown} jobs, ${jobs.length} links rendered (pagination)`;
  return res;
}

// ------------------------------------------------------------------ own careers page
export interface PageLink { lid: string; href: string; text: string; comeetId: string | null }

export interface CareersPageRender {
  ok: boolean;
  url: string;
  text: string;          // visible text, used for AI extraction
  links: PageLink[];     // candidate job links, given to the AI so each role maps to a stable link/id
  contentHash: string;   // hash of text + links: unchanged page -> skip the AI call
  comeetIds: number;     // Comeet position ids seen in links (cross-check for the AI count)
  error?: string;
}

const JOBISH = /job|career|position|opening|role|vacanc|apply|comeet|lever\.co|greenhouse|ashby|workable/i;

export async function renderCareersPage(careersUrl: string): Promise<CareersPageRender> {
  const r = await render(careersUrl, 3000);
  if (!r.ok) return { ok: false, url: careersUrl, text: "", links: [], contentHash: "", comeetIds: 0, error: "render failed" };
  // Drop cookie banners and long boilerplate lines; keep the page order.
  const text = r.text.split(/\n+/).map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l && l.length < 300 && !/cookie|privacy policy|all rights reserved|©/i.test(l))
    .join("\n").slice(0, 60000);
  const base = r.url.replace(/[#?].*$/, "").replace(/\/$/, "");
  const seen = new Set<string>();
  const links: PageLink[] = [];
  for (const l of r.links) {
    const href = l.href.replace(/#.*$/, "");
    if (seen.has(href) || href.replace(/\/$/, "") === base || !/^https?:/.test(href)) continue;
    const comeetId = comeetPositionIds([href])[0] ?? null;
    if (!comeetId && !JOBISH.test(href)) continue;
    if (/linkedin\.com|facebook|twitter|x\.com|instagram|youtube|\/blog\/|privacy|terms/i.test(href)) continue;
    seen.add(href);
    links.push({ lid: comeetId ?? `L${links.length + 1}`, href, text: l.text.replace(/\s+/g, " ").trim().slice(0, 160), comeetId });
    if (links.length >= 150) break;
  }
  const comeetIds = links.filter((l) => l.comeetId).length;
  return { ok: true, url: r.url, text, links, contentHash: hash(text + "\n" + links.map((l) => l.lid + l.href).join("\n")), comeetIds };
}
