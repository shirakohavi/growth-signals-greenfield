// Fit tags (BUILD_BRIEF §8): decide who is shown. Not part of the score.
// Recomputed from the round data; the pre-filled `Fit tag` column is only used to check this logic.

export const GREENFIELD_CATEGORIES = ["Cybersecurity", "AI infrastructure", "Deep tech", "Vertical AI", "Fintech"] as const;

export type FitTag = "In mandate" | "Pre-Series B" | "Too early" | "Too late" | "Portfolio" | "Off-thesis";
export type Visibility = "ranked" | "ranked_marked" | "watchlist" | "hidden" | "ranked_last";

export interface FitResult {
  tag: FitTag;
  visibility: Visibility;
  flags: string[];         // e.g. "possible conflict: …", "deep tech Series A", "Series A > 24 months ago"
  reason: string;
  roundClosed?: string;    // YYYY-MM
  roundAnnounced?: string; // YYYY-MM
}

export interface CompanyInput {
  Company: string;
  "Greenfield category": string;
  "Latest round": string;
  "Round date": string;
  "Greenfield status": string;
  "Why included"?: string;
  "Amount ($M)"?: string;
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** "Aug 2025 (announced Oct 2026)" -> closed 2025-08, announced 2026-10. Year-only -> month undefined. */
export function parseRoundDate(s: string): { closed?: { y: number; m?: number }; announced?: { y: number; m?: number } } {
  const parts = [...s.matchAll(/(?:([A-Za-z]{3})[a-z]*\.?\s+)?(\d{4})/g)].map((m) => ({ y: Number(m[2]), m: m[1] ? MONTHS[m[1].toLowerCase()] : undefined }));
  const announcedIdx = s.search(/announced/i);
  if (parts.length > 1 && announcedIdx >= 0) return { closed: parts[0], announced: parts[1] };
  return { closed: parts[0], announced: parts[0] };
}

const ym = (d?: { y: number; m?: number }) => (d ? `${d.y}-${String(d.m ?? 1).padStart(2, "0")}` : undefined);

function monthsBetween(d: { y: number; m?: number }, today: Date): number {
  return (today.getUTCFullYear() - d.y) * 12 + (today.getUTCMonth() + 1 - (d.m ?? 6));
}

/** Series letter as a number: A=1, B=2, … ; "Growth" counts as B/C-equivalent; "Later stage" as D+. */
function stageRank(round: string): number | null {
  const m = round.match(/series\s+([a-z])/i);
  if (m) return m[1].toUpperCase().charCodeAt(0) - 64;
  if (/later stage|late stage|pre-ipo|ipo/i.test(round)) return 4;
  if (/growth/i.test(round)) return 3;
  if (/seed/i.test(round)) return 0;
  return null;
}

/** "$5B valuation", "valuation of $1.2B", "Acquired for ~$1B" (the latter is handled as acquired). */
function valuationBillions(text: string): number | null {
  const m = text.match(/\$\s*(\d+(?:\.\d+)?)\s*(?:B|bn|billion)\b[^.;]{0,20}valuation/i) ?? text.match(/valuation[^.;]{0,20}\$\s*(\d+(?:\.\d+)?)\s*(?:B|bn|billion)\b/i);
  return m ? Number(m[1]) : null;
}

export function computeFit(c: CompanyInput, today = new Date()): FitResult {
  const flags: string[] = [];
  const status = c["Greenfield status"] ?? "";
  const why = c["Why included"] ?? "";
  const category = (c["Greenfield category"] ?? "").trim();
  const round = c["Latest round"] ?? "";
  const dates = parseRoundDate(c["Round date"] ?? "");
  const base = { roundClosed: ym(dates.closed), roundAnnounced: ym(dates.announced) };

  if (/possible conflict/i.test(status)) flags.push(`possible conflict: ${status.replace(/^possible conflict\s*-\s*/i, "")}`);

  if (/^portfolio/i.test(status)) return { ...base, tag: "Portfolio", visibility: "hidden", flags: [...flags, "monitor"], reason: "Greenfield portfolio company" };

  const rank = stageRank(round);
  const acquired = /\bacquired\b/i.test(`${why} ${status}`);
  const valuation = valuationBillions(why);
  if (acquired) return { ...base, tag: "Too late", visibility: "hidden", flags, reason: "acquired" };
  if (rank !== null && rank >= 4) return { ...base, tag: "Too late", visibility: "hidden", flags, reason: `${round} (Series D+ / later stage)` };
  if (valuation !== null && valuation >= 1) return { ...base, tag: "Too late", visibility: "hidden", flags, reason: `$${valuation}B valuation` };

  const inThesis = (GREENFIELD_CATEGORIES as readonly string[]).includes(category);
  if (!inThesis) return { ...base, tag: "Off-thesis", visibility: "ranked_last", flags: [...flags, `outside Greenfield's five categories (${category || "none"})`], reason: "off-thesis sector" };

  if (rank === 2 || rank === 3) return { ...base, tag: "In mandate", visibility: "ranked", flags, reason: /growth/i.test(round) ? "growth round (B/C stage)" : round };

  if (rank === 1) {
    if (category === "Deep tech") return { ...base, tag: "In mandate", visibility: "ranked", flags: [...flags, "deep tech Series A"], reason: "Series A in deep tech" };
    if (!dates.closed) return { ...base, tag: "Too early", visibility: "watchlist", flags: [...flags, "Series A date unknown"], reason: "Series A, closing date unknown" };
    const age = monthsBetween(dates.closed, today);
    if (age < 12) return { ...base, tag: "Too early", visibility: "watchlist", flags, reason: `Series A closed ${age} months ago` };
    if (age > 24) flags.push("Series A > 24 months ago");
    return { ...base, tag: "Pre-Series B", visibility: "ranked_marked", flags, reason: `Series A closed ${age} months ago` };
  }

  return { ...base, tag: "Too early", visibility: "watchlist", flags: [...flags, `unrecognised round "${round}"`], reason: "stage unknown or seed" };
}

/**
 * Time-based stage moves, recomputed on every run (the rest of the stage comes from the researched list).
 * Only Series A outside deep tech changes with time: under 12 months Too early, then Pre-Series B
 * (Approaching B). Returns null when nothing changes. A newer round reported in the news does NOT
 * change the stage here: rounds go into the list after a person confirms them (BUILD_BRIEF §8).
 */
export function refreshTimeFit(
  c: { last_round: string | null; round_closed: string | null; category: string | null; fit_tag: string | null },
  today: Date,
): { tag: FitTag; visibility: Visibility; reason: string } | null {
  if (!c.fit_tag || !["Too early", "Pre-Series B"].includes(c.fit_tag)) return null;
  if (stageRank(c.last_round ?? "") !== 1 || c.category === "Deep tech" || !c.round_closed) return null;
  const [y, m] = c.round_closed.split("-").map(Number);
  const age = monthsBetween({ y, m }, today);
  const tag: FitTag = age < 12 ? "Too early" : "Pre-Series B";
  if (tag === c.fit_tag) return null;
  return { tag, visibility: tag === "Too early" ? "watchlist" : "ranked_marked", reason: `Series A closed ${age} months ago` };
}

