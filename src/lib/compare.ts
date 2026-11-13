// Run-to-run comparison rules (BUILD_BRIEF §7). Pure functions, no I/O: tested in scripts/test_compare.ts.

export interface JobRow {
  id: number;
  source: string;
  source_job_id: string;
  title: string;
  function: string | null;
  seniority: string | null;
  country: string | null;
  posted_date: string | null;
  first_seen: string;
  last_seen: string;
  is_open: number;
}

const STOP = new Set(["the", "a", "an", "of", "and", "for", "to", "in", "at", "with", "-", "&", "remote", "hybrid", "sr", "jr"]);
const tokens = (t: string) =>
  new Set(t.toLowerCase().replace(/senior/g, "sr").replace(/[^a-z0-9+#]+/g, " ").split(" ").filter((w) => w && !STOP.has(w)));

/** Jaccard similarity of title words (0..1). "Backend Engineer" vs "Senior Backend Engineer" = 0.67. */
export function titleSimilarity(a: string, b: string): number {
  const x = tokens(a), y = tokens(b);
  if (!x.size || !y.size) return 0;
  let inter = 0;
  for (const w of x) if (y.has(w)) inter++;
  return inter / (x.size + y.size - inter);
}

/** Scraped roles (careers pages) carry a hash id, not an ATS id: renames change it. */
export const hasStableId = (j: Pick<JobRow, "source" | "source_job_id">) =>
  !(j.source === "careers_page" && /^[0-9a-f]{16}$/.test(j.source_job_id));

/**
 * No-ID rename rule: a role new this run and a role that disappeared this run are the same job when
 * function + country + seniority match and the titles are similar. Each old role matches at most once.
 * Returns pairs [newRow, oldRow].
 */
export function matchRenamed(newRows: JobRow[], goneRows: JobRow[], minSimilarity = 0.5): [JobRow, JobRow][] {
  // Score every eligible pair, then assign best-first, so "(TI)" pairs with "TI" rather than with "(non-TI)"
  // just because "(non-TI)" came first in the list.
  const scored: { n: JobRow; o: JobRow; sim: number }[] = [];
  for (const n of newRows) {
    if (hasStableId(n)) continue;
    for (const o of goneRows) {
      if (o.source !== n.source || hasStableId(o)) continue;
      if (o.function !== n.function || o.seniority !== n.seniority || (o.country ?? "") !== (n.country ?? "")) continue;
      const sim = titleSimilarity(n.title, o.title);
      if (sim >= minSimilarity) scored.push({ n, o, sim });
    }
  }
  scored.sort((a, b) => b.sim - a.sim);
  const usedNew = new Set<number>();
  const usedOld = new Set<number>();
  const pairs: [JobRow, JobRow][] = [];
  for (const { n, o } of scored) {
    if (usedNew.has(n.id) || usedOld.has(o.id)) continue;
    usedNew.add(n.id);
    usedOld.add(o.id);
    pairs.push([n, o]);
  }
  return pairs;
}

/**
 * Repost rule: a role first seen this run is not new hiring if
 *  - its posted_date is well before our previous run (we were already watching, so it isn't new), or
 *  - the same title + country closed earlier at this company (the role came back with a new id).
 * Only applies when the company had a previous real run (otherwise everything is baseline/first sighting).
 */
export function isRepost(n: JobRow, previousRunDate: string | null, closedBefore: JobRow[], graceDays = 7): boolean {
  if (!previousRunDate) return false;
  if (n.posted_date) {
    const cutoff = new Date(`${previousRunDate}T00:00:00Z`);
    cutoff.setUTCDate(cutoff.getUTCDate() - graceDays);
    if (n.posted_date < cutoff.toISOString().slice(0, 10)) return true;
  }
  const t = n.title.toLowerCase().trim();
  return closedBefore.some((o) => o.id !== n.id && o.title.toLowerCase().trim() === t && (o.country ?? "") === (n.country ?? ""));
}
