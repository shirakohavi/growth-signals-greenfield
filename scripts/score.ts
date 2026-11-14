// Step 7: score every company (BUILD_BRIEF §9–§10), write the scores table and public/ranking.json.
// The score is plain arithmetic (src/scoring/signals.ts). Claude Haiku only writes the reason line, from the
// scored signals. Ranking: filter by fit tag, sort by score, ties -> fuller coverage; arrow = change vs last run.
// Usage: npx tsx scripts/score.ts [--remote] [--no-ai]
import { mkdir, writeFile } from "node:fs/promises";
import { aiErrorMessage, usage, writeReason } from "../src/ai/claude.ts";
import { d1ExecFile, d1Query, sq } from "../src/lib/d1.ts";
import { CONCRETE_PLAN, scoreCompany, type CompanyIn, type EventIn, type JobIn, type SnapshotIn } from "../src/scoring/signals.ts";
import { scoreSeries } from "../src/lib/score_series.ts";
import { hasAnthropicKey, loadDevVars } from "./env.ts";

loadDevVars();
const args = process.argv.slice(2);
const remote = args.includes("--remote");
const useAi = !args.includes("--no-ai") && hasAnthropicKey();
// The run date is the latest real collection (snapshot), not the clock: re-scoring the same data on a
// later day must not count as a second run (it would turn baseline presence into "new markets").
const today = d1Query<{ d: string | null }>(`SELECT MAX(run_date) AS d FROM snapshots WHERE is_dummy = 0`, remote)[0]?.d ?? new Date().toISOString().slice(0, 10);

type Co = CompanyIn & { job_source_url: string | null; ats_slug: string | null; domain: string; category: string | null; sector: string | null; greenfield_note: string | null; fit_reason: string | null; headcount: number | null; headcount_source: string | null; careers_url: string | null };

const companies = d1Query<Co>(`SELECT id, name, domain, category, sector, hq AS hq_country, last_round, round_closed, fit_tag, fit_visibility,
  greenfield_status, greenfield_note, fit_reason, job_source_type, job_source_url, ats_slug, headcount, headcount_source, careers_url FROM companies ORDER BY list_no`, remote);
const jobs = d1Query<JobIn & { company_id: number }>(`SELECT company_id, title, function, seniority, country, url, posted_date, first_seen, is_baseline, is_repost, source
  FROM jobs WHERE is_open = 1 AND is_dummy = 0`, remote);
// Closed roles (for "likely filled" vs "pulled"). closed_date = the first real run after the role was last seen.
const closedRaw = d1Query<JobIn & { company_id: number; last_seen: string }>(`SELECT company_id, title, function, seniority, country, url, posted_date, first_seen, last_seen, is_baseline, is_repost, source
  FROM jobs WHERE is_open = 0 AND is_dummy = 0`, remote);
const events = d1Query<EventIn & { company_id: number }>(`SELECT company_id, type, value, event_date, evidence, source_url, is_dummy FROM footprint`, remote);
const snaps = d1Query<SnapshotIn & { company_id: number }>(`SELECT company_id, run_date, open_jobs, is_dummy, coverage, sources_checked FROM snapshots`, remote);
const sourceState = d1Query<{ company_id: number; source: string; last_status: string; last_ok_date: string | null }>(
  `SELECT company_id, source, last_status, last_ok_date FROM source_state`, remote);
// Reuse today's reason line when a company's scored signals haven't changed (no new AI call on re-runs).
const existing = new Map(d1Query<{ company_id: number; reason: string; signals_json: string }>(
  `SELECT company_id, reason, signals_json FROM scores WHERE run_date = ${sq(today)}`, remote).map((r) => [r.company_id, r]));
const realRuns = d1Query<{ n: number }>(`SELECT COUNT(DISTINCT run_date) AS n FROM scores WHERE run_date < ${sq(today)}`, remote)[0]?.n ?? 0;
const prevScores = new Map(d1Query<{ company_id: number; score: number }>(
  `SELECT s.company_id, s.score FROM scores s WHERE s.run_date = (SELECT MAX(run_date) FROM scores x WHERE x.company_id = s.company_id AND x.run_date < ${sq(today)})`, remote,
).map((r) => [r.company_id, r.score]));

// Every past real score, for the score-over-time chart.
const pastScores = d1Query<{ company_id: number; run_date: string; score: number | null }>(
  `SELECT company_id, run_date, score FROM scores WHERE run_date < ${sq(today)}`, remote);
const by = <T extends { company_id: number }>(rows: T[]) => {
  const m = new Map<number, T[]>();
  for (const r of rows) m.set(r.company_id, [...(m.get(r.company_id) ?? []), r]);
  return m;
};
const realRunDates = [...new Set(snaps.filter((s) => !s.is_dummy).map((s) => s.run_date))].sort();
const closedJobs = closedRaw.map((j) => ({ ...j, closed_date: realRunDates.find((d) => d > j.last_seen) ?? j.last_seen }));
const closedBy = by(closedJobs);
const jobsBy = by(jobs), eventsBy = by(events), snapsBy = by(snaps), stateBy = by(sourceState), pastScoresBy = by(pastScores);
const ageDays = (d: string) => Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${d.slice(0, 10)}T00:00:00Z`)) / 86400000);

/** Public page for the job board the roles came from (not the API endpoint). */
function boardUrl(c: Co): string | null {
  const slug = c.ats_slug ?? "";
  switch (c.job_source_type) {
    case "greenhouse": return slug ? `https://job-boards.greenhouse.io/${slug}` : null;
    case "lever": return slug ? `https://jobs.lever.co/${slug}` : null;
    case "ashby": return slug ? `https://jobs.ashbyhq.com/${slug}` : null;
    case "comeet": return slug.includes("/") ? `https://www.comeet.com/jobs/${slug}` : c.careers_url;
    case "getro": return c.job_source_url ? c.job_source_url.replace(/[?#].*$/, "") : null;
    default: return c.careers_url;
  }
}

/** One headline per company, always the same template family: "<number or role> + <what> · <where>". No AI. */
function headlineOf(sigs: { key: string; detail: string }[], decline: boolean): string {
  const top = sigs.find((x) => !x.key.startsWith("layoff") && x.key !== "hiring_paused") ?? sigs[0];
  if (!top) return "No growth signals";
  const num = (re: RegExp) => top.detail.match(re)?.[1];
  switch (true) {
    case top.key === "gtm_buildout": return `${num(/^(\d+)/) ?? "4+"} go-to-market roles · ${top.detail.match(/in ([A-Z]{2})(?:,|$)/)?.[1] ?? ""}`.replace(/ · $/, "");
    case top.key === "senior_gtm": return "Senior go-to-market hire";
    case top.key.startsWith("new_market:"): return `New market · ${top.key.slice(11)}`;
    case top.key === "speeding_up": return `${num(/^(\d+)/) ?? "5+"} new roles in 90 days`;
    case top.key === "rd_buildup": return `${num(/^(\d+)/) ?? "4+"} R&D roles in 90 days`;
    case top.key === "gtm_mix": return "Hiring shifts to go-to-market";
    case top.key === "series_b_window": return "Series B window";
    case top.key === "partner_program": return "Partner program launched";
    case top.key === "plan": return /double/i.test(top.detail) ? "Plans to double headcount" : "Expansion plan announced";
    case top.key === "validation": return "Market validation";
    case top.key === "industry_pages": return "New industry pages";
    case top.key === "layoff": return "Layoffs reported";
    case top.key === "hiring_paused": return "Hiring paused";
    default: return decline ? "Layoffs reported" : "No growth signals";
  }
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

type Change = { date: string; company: string; kind: string; title: string; detail: string; url: string | null; evidence: string; dummy: boolean; country: string | null };
const feed: Change[] = [];
// Display names for the §8 fit tags (the tags themselves stay as the brief names them).
const FIT_LABEL: Record<string, string> = { "In mandate": "In Range", "Pre-Series B": "Approaching B", "Too early": "Too Early", "Too late": "Past Stage", "Portfolio": "Portfolio", "Off-thesis": "Outside Thesis" };

const rows = [];
const sql: string[] = [`-- scores ${today} (generated by scripts/score.ts)`];
const COVERAGE_RANK = { full: 0, partial: 1, low: 2 } as const;

for (const c of companies) {
  const cj = jobsBy.get(c.id) ?? [];
  const r = scoreCompany(c, cj, eventsBy.get(c.id) ?? [], snapsBy.get(c.id) ?? [], today, closedBy.get(c.id) ?? []);
  let reason = "";
  const prevToday = existing.get(c.id);
  if (prevToday && prevToday.signals_json === JSON.stringify(r.signals) && prevToday.reason) reason = prevToday.reason;
  else if (useAi) {
    try { reason = await writeReason(c.name, r.score, r.band, r.signals.map((s) => ({ name: s.name, value: s.value, date: s.date, detail: s.detail, dummy: s.dummy })), r.decline_flag); }
    catch (e) { reason = ""; console.log(`  reason line failed for ${c.name}: ${aiErrorMessage(e)}`); }
  }
  if (!reason) reason = r.signals.slice(0, 3).map((s) => `${s.name}${s.date ? ` (${s.date})` : ""}`).join("; ") || "No growth signals found in this run.";

  const prev = prevScores.get(c.id);

  // What changed: roles new this run (not baseline/repost) or posted in the last 90 days, plus dated footprint
  // events from the last 90 days. Newest first.
  const changes: Change[] = [];
  for (const j of cj) {
    const date = j.posted_date ?? (j.is_baseline || j.is_repost ? null : j.first_seen);
    if (!date || j.is_repost || ageDays(date) > 90) continue;
    changes.push({ date, company: c.name, kind: "role", title: `New role${j.country ? ` in ${j.country}` : ""}`, detail: `${j.title}${j.function ? ` · ${j.function}` : ""}`, url: j.url, evidence: "direct", dummy: false, country: j.country });
  }
  // A genuinely new market (a country whose first role appeared after the company's first run) is a highlight.
  // Only these score as direct evidence; first-run markets are indirect.
  for (const s of r.signals) {
    if (!s.key.startsWith("new_market:") || s.evidence < 1 || !s.date) continue;
    const iso = s.key.slice(11);
    changes.push({ date: s.date, company: c.name, kind: "market", title: `New market in ${iso}`, detail: s.detail.replace(/^\d+ open GTM role\(s\) in [A-Z]{2}, e\.g\. /, "First sales role there: "), url: s.source_url, evidence: "direct", dummy: s.dummy, country: iso });
  }
  const KIND: Record<string, string> = { new_page: "page", round: "round", office: "office", plan: "plan", validation: "validation", layoff: "layoff" };
  for (const e of eventsBy.get(c.id) ?? []) {
    // Drawer timeline keeps a year of dated events (the This week feed below keeps 90 days).
    if (!e.event_date || !KIND[e.type] || ageDays(e.event_date) > 365 || ageDays(e.event_date) < 0) continue;
    // Same rule as scoring: use-of-funds boilerplate is not a plan worth showing.
    if (e.type === "plan" && !CONCRETE_PLAN.test(e.value)) continue;
    const title = { page: /^partner/.test(e.value) ? "Partner page" : /^industry/.test(e.value) ? "Industry page" : "New page", round: "Funding", office: "Office / team", plan: "Plan", validation: "Validation", layoff: "Layoffs" }[KIND[e.type]]!;
    changes.push({ date: e.event_date, company: c.name, kind: KIND[e.type], title, detail: e.value.replace(/\s*\(sitemap lastmod [^)]*\)/, "").replace(/^(partner|industry|country) page /, ""), url: e.source_url, evidence: e.evidence, dummy: !!e.is_dummy, country: null });
  }
  changes.sort((a, b) => b.date.localeCompare(a.date));
  // Several outlets reporting one story become one line: same kind of news within 10 days -> "· N reports".
  const merged: (Change & { reports?: number })[] = [];
  for (const ch of changes) {
    const prev = merged.find((m) => ch.kind !== "role" && ch.kind !== "page" && ch.kind !== "market" && m.kind === ch.kind && Math.abs(Date.parse(m.date) - Date.parse(ch.date)) <= 10 * 86400000);
    if (prev) { prev.reports = (prev.reports ?? 1) + 1; continue; }
    merged.push({ ...ch });
  }
  for (const m of merged) if (m.reports) m.title = `${m.title} · ${m.reports} reports`;
  changes.length = 0;
  changes.push(...merged);
  feed.push(...changes.filter((ch) => ageDays(ch.date) <= 90));

  const latestReal = (snapsBy.get(c.id) ?? []).filter((s) => !s.is_dummy).sort((a, b) => b.run_date.localeCompare(a.run_date))[0];
  const sources: Record<string, string> = {};
  try { Object.assign(sources, JSON.parse(latestReal?.sources_checked ?? "{}")); } catch { /* ignore */ }
  for (const st of stateBy.get(c.id) ?? []) sources[st.source] = st.last_status;
  const count = (f: (j: JobIn) => boolean) => cj.filter(f).length;
  const byKey = (k: (j: JobIn) => string | null) => Object.entries(cj.reduce((a, j) => { const v = k(j) ?? "unknown"; a[v] = (a[v] ?? 0) + 1; return a; }, {} as Record<string, number>)).sort((a, b) => b[1] - a[1]);
  rows.push({
    name: c.name, domain: c.domain, category: c.category, sector: c.sector,
    fit_tag: c.fit_tag, visibility: c.fit_visibility, fit_reason: c.fit_reason,
    headline: headlineOf(r.signals, r.decline_flag),
    // "Series B · Nov 2026 → In mandate": what the fit status is based on (§8, src/lib/fit.ts).
    fit: FIT_LABEL[c.fit_tag ?? ""] ?? c.fit_tag,
    // "Series B · Aug 25": the latest round from the company list (data/companies.csv), not scraped.
    round_label: `${(c.last_round ?? "Unknown").replace(/\s*\(.*\)/, "")}${c.round_closed ? ` · ${MONTHS[Number(c.round_closed.slice(5, 7)) - 1]} ${c.round_closed.slice(2, 4)}` : ""}`,
    fit_explain: `${c.last_round ?? "Round unknown"}${c.round_closed ? ` · ${MONTHS[Number(c.round_closed.slice(5, 7)) - 1]} ${c.round_closed.slice(0, 4)}` : ""} → ${FIT_LABEL[c.fit_tag ?? ""] ?? c.fit_tag ?? ""}${/deep tech/i.test(c.fit_reason ?? "") ? " (deep tech rule)" : ""}`,
    // Who to contact (matches the bands): "now" = score 60+ and In Range; "warm" = score 40+ and In Range / Approaching B.
    reach: r.score >= 60 && c.fit_tag === "In mandate" ? "now" : r.score >= 40 && ["In mandate", "Pre-Series B"].includes(c.fit_tag ?? "") ? "warm" : null,
    portfolio: c.greenfield_status === "portfolio",
    score: r.score, band: r.band, change: prev === undefined ? null : r.score - prev,
    coverage: r.coverage, decline_flag: r.decline_flag, reason,
    open_jobs: cj.length, gtm_jobs: count((j) => ["Sales", "Marketing", "Customer success", "Partnerships"].includes(j.function ?? "")),
    jobs_by_country: Object.fromEntries(byKey((j) => j.country)),
    gtm_by_country: Object.fromEntries(Object.entries(cj.filter((j) => ["Sales", "Marketing", "Customer success", "Partnerships"].includes(j.function ?? "")).reduce((a, j) => { const v = j.country ?? "unknown"; a[v] = (a[v] ?? 0) + 1; return a; }, {} as Record<string, number>)).sort((a, b) => b[1] - a[1])),
    jobs_by_function: Object.fromEntries(byKey((j) => j.function)),
    size: r.size, filled: r.filled,
    gtm_share: cj.length ? Math.round((cj.filter((j) => ["Sales", "Marketing", "Customer success", "Partnerships"].includes(j.function ?? "")).length / cj.length) * 100) : null,
    headcount: c.headcount, headcount_source: c.headcount_source, job_source: c.job_source_type, careers_url: c.careers_url,
    slug: c.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
    links: {
      website: `https://${c.domain}`,
      careers: c.careers_url,
      board: boardUrl(c),
      linkedin_jobs: `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(c.name)}`, // link only, never scraped
    },
    series: (snapsBy.get(c.id) ?? []).filter((s) => s.open_jobs !== null).sort((a, b) => a.run_date.localeCompare(b.run_date)).map((s) => ({ date: s.run_date, open: s.open_jobs, dummy: !!s.is_dummy })),
    score_series: scoreSeries(pastScoresBy.get(c.id) ?? [], snapsBy.get(c.id) ?? [], { date: today, score: r.score, open: cj.length }),
    sources,
    changes: changes.slice(0, 60),
    // Every open role, newest first, each linking to its own posting.
    roles: cj.map((j) => ({ title: j.title, function: j.function, seniority: j.seniority, country: j.country, url: j.url,
      posted: j.posted_date, new: !j.is_baseline && !j.is_repost && j.first_seen === today }))
      .sort((a, b) => (b.posted ?? "").localeCompare(a.posted ?? "")).slice(0, 200),
    signals: r.signals, context: r.context.slice(0, 8),
    uses_dummy: r.signals.some((s) => s.dummy),
  });
  sql.push(`INSERT INTO scores (company_id, run_date, score, band, fit_tag, coverage, decline_flag, reason, signals_json) VALUES (${c.id}, ${sq(today)}, ${r.score}, ${sq(r.band)}, ${sq(c.fit_tag)}, ${sq(r.coverage)}, ${r.decline_flag ? 1 : 0}, ${sq(reason)}, ${sq(JSON.stringify(r.signals))})
  ON CONFLICT(company_id, run_date) DO UPDATE SET score = excluded.score, band = excluded.band, fit_tag = excluded.fit_tag, coverage = excluded.coverage,
    decline_flag = excluded.decline_flag, reason = excluded.reason, signals_json = excluded.signals_json;`);
}

// Ranking: ranked (In mandate) and ranked_marked (Pre-Series B) by score; off-thesis last; watchlist; hidden at the end.
const GROUP = { ranked: 0, ranked_marked: 0, ranked_last: 1, watchlist: 2, hidden: 3 } as Record<string, number>;
rows.sort((a, b) => (GROUP[a.visibility ?? "hidden"] - GROUP[b.visibility ?? "hidden"]) || b.score - a.score || COVERAGE_RANK[a.coverage] - COVERAGE_RANK[b.coverage]);
let rank = 0;
// Safeguard: a Greenfield portfolio company, if one is ever added to the list, is left out of the dashboard.
const portfolioNames = new Set(rows.filter((r) => r.portfolio).map((r) => r.name));
rows.splice(0, rows.length, ...rows.filter((r) => !r.portfolio));
feed.splice(0, feed.length, ...feed.filter((f) => !portfolioNames.has(f.company)));
const ranked = rows.map((r) => ({ rank: GROUP[r.visibility ?? "hidden"] <= 1 ? ++rank : null, ...r }));

await mkdir("data/runs", { recursive: true });
const path = `data/runs/scores-${today}.sql`;
await writeFile(path, sql.join("\n") + "\n");
d1ExecFile(path, remote);
await mkdir("public", { recursive: true });
await writeFile("public/ranking.json", JSON.stringify({
  generated_at: new Date().toISOString(), run_date: today,
  note: "Signals marked dummy come from seeded history (is_dummy=1), not real past runs.",
  // Rising: top by score until 2+ real runs exist, then biggest score increase since the last run.
  rising_mode: realRuns >= 1 ? "change" : "score",
  totals: { ranked: ranked.filter((r) => r.rank !== null).length, open_roles: jobs.length, signals: events.length },
  feed: feed.sort((a, b) => b.date.localeCompare(a.date)),
  companies: ranked,
}, null, 2));

console.log("rank  company             score  band                 fit tag        cov      reason");
for (const r of ranked) console.log(`${String(r.rank ?? "-").padStart(4)}  ${r.name.padEnd(18)} ${String(r.score).padStart(5)}  ${r.band.padEnd(20)} ${(r.fit_tag ?? "").padEnd(14)} ${r.coverage.padEnd(8)} ${r.decline_flag ? "⚠ " : ""}${r.reason.slice(0, 90)}`);
console.log(`\nwrote public/ranking.json · AI calls ${usage.calls} (${usage.input} in / ${usage.output} out tokens)`);
process.exit(0);
