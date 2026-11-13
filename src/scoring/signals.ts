// Step 7: the 13 signals (BUILD_BRIEF §9) and the score (§10). Plain arithmetic, no AI. Pure: no I/O.
//
// Interpretation notes (checked against the §14 test cases; see AI_LOG):
//  - Open job posts are direct evidence at 100% while open, dated or not (§10 "Age: open job posts = 100%").
//    "Posted in the last 90 days" rules need a date: posted_date, else first_seen when the role is not baseline.
//  - Non-job signals need an event date to be scored (their age can't be checked otherwise). Undated facts are
//    kept as context, not points.
//  - "Announced expansion plan" needs a concrete plan (headcount target, office/country, numbers), not
//    use-of-funds boilerplate from a round announcement.
//  - Each signal counts once (strongest instance), except New market entry: once per country.
//  - One hiring wave counts once: of GTM build-out, Hiring speeding up, Mix shifting toward GTM and R&D build-up,
//    the strongest counts in full and the rest count half.
//  - Company size (open roles / headcount) is shown as context only; it does not change the score.

/** Signals that all measure the same hiring wave: the strongest counts in full, the others count half. */
const HIRING_WAVE = new Set(["gtm_buildout", "speeding_up", "gtm_mix", "rd_buildup"]);
export const GTM = new Set(["Sales", "Marketing", "Customer success", "Partnerships"]);

export interface CompanyIn {
  id: number; name: string; hq_country: string; last_round: string | null; round_closed: string | null;
  fit_tag: string | null; fit_visibility: string | null; greenfield_status: string; job_source_type: string;
  headcount?: number | null; // approximate employees, from news (companies.headcount); null = size unknown
}
export interface JobIn {
  title: string; function: string | null; seniority: string | null; country: string | null; url: string | null;
  posted_date: string | null; first_seen: string; is_baseline: number; is_repost: number; source: string;
}
/** A role that closed: closed_date = the first real run that no longer saw it. */
export type ClosedJobIn = JobIn & { closed_date: string };
export interface EventIn {
  type: string; value: string; event_date: string | null; evidence: "direct" | "indirect"; source_url: string | null; is_dummy: number;
}
export interface SnapshotIn { run_date: string; open_jobs: number | null; is_dummy: number; coverage: string | null; sources_checked: string | null }

export interface Signal {
  key: string;            // e.g. "new_market:US"
  name: string;           // §9 name
  points: number;         // base points
  age: number;            // 0..1
  evidence: number;       // 1 or 0.6
  value: number;          // points × age × evidence, rounded to 0.1
  date: string | null;
  detail: string;         // what was seen (no people's names)
  source_url: string | null;
  dummy: boolean;         // computed from dummy history
}

export interface ScoreOut {
  score: number;
  band: string;
  coverage: "full" | "partial" | "low";
  decline_flag: boolean;
  signals: Signal[];
  context: { type: string; value: string; source_url: string | null }[]; // undated facts, shown not scored
  // Size adjustment: open roles as a share of headcount. null when headcount is unknown (no adjustment).
  size: { headcount: number; open: number; pct: number } | null; // context only, not scored
  filled: number; // closed roles that look filled (see likelyFilled), last 90 days
}

const day = (s: string) => Date.parse(`${s.slice(0, 10)}T00:00:00Z`);
const ageDays = (date: string, today: string) => Math.round((day(today) - day(date)) / 86400000);
const EVIDENCE = { direct: 1, indirect: 0.6 } as const;

/** Positive non-job signals: 0–30 days 100%, 31–90 50%, older dropped. */
const agePositive = (d: number) => (d <= 30 ? 1 : d <= 90 ? 0.5 : 0);
/** Announced plans and negative signals: 0–90 days 100%, up to 12 months 50%. */
const agePlanOrNegative = (d: number) => (d <= 90 ? 1 : d <= 365 ? 0.5 : 0);

export const CONCRETE_PLAN = /\b(double|triple|quadruple|\d+\s*%|\d+\s*(new\s+)?(employees|people|hires|engineers|roles|positions|staff|workers)|headcount|office|hub|headquarters|factory|plant|site in|in (the )?(u\.?s\.?|united states|america|europe|uk|germany|france|india|japan|apac|emea|latam|asia)|new york|boston|london|berlin|tokyo|singapore|florida|texas|california)\b/i;
const SENIOR_GTM = /\b(vp|vice president|svp|evp|head of|chief|cro|cmo|general manager|gm|country manager)\b/i;

export function bandOf(score: number): string {
  return score >= 60 ? "Exceptional" : score >= 40 ? "Strong growth story" : score >= 20 ? "Some activity" : "Quiet";
}

function sig(key: string, name: string, points: number, age: number, evidence: number, date: string | null, detail: string, source_url: string | null, dummy = false): Signal {
  return { key, name, points, age, evidence, value: Math.round(points * age * evidence * 10) / 10, date, detail, source_url, dummy };
}

/** Best (highest value) signal per key. */
function keepBest(list: Signal[]): Signal[] {
  const best = new Map<string, Signal>();
  for (const s of list) {
    const cur = best.get(s.key);
    if (!cur || Math.abs(s.value) > Math.abs(cur.value)) best.set(s.key, s);
  }
  return [...best.values()];
}

export function scoreCompany(c: CompanyIn, jobs: JobIn[], events: EventIn[], snaps: SnapshotIn[], today: string, closed: ClosedJobIn[] = []): ScoreOut {
  const out: Signal[] = [];
  const context: ScoreOut["context"] = [];
  const postedOf = (j: JobIn) => j.posted_date ?? (j.is_baseline || j.is_repost ? null : j.first_seen);
  const recent = (j: JobIn) => { const p = postedOf(j); return p !== null && ageDays(p, today) <= 90 && !j.is_repost; };
  const gtmJobs = jobs.filter((j) => GTM.has(j.function ?? ""));
  const newIn60 = jobs.some((j) => { const p = postedOf(j); return p !== null && ageDays(p, today) <= 60 && !j.is_repost; });

  // ---- Closed roles: filled or pulled? We can't see hires, so we read how roles close.
  // Pulled = a mass closure: 3+ roles and half or more of the roles open at the previous real run, closed in one run.
  // Likely filled = closed in the last 90 days, not in a mass closure, while the company keeps posting, after a
  // normal time open (3–16 weeks; when the start date is unknown, e.g. a baseline role, that check is skipped).
  const realSnaps = snaps.filter((s) => !s.is_dummy).sort((a, b) => a.run_date.localeCompare(b.run_date));
  const massRuns = new Set<string>();
  for (const [d, n] of closed.reduce((m, j) => m.set(j.closed_date, (m.get(j.closed_date) ?? 0) + 1), new Map<string, number>())) {
    const before = realSnaps.filter((s) => s.run_date < d).pop()?.open_jobs ?? null;
    if (n >= 3 && before && n >= before * 0.5) massRuns.add(d);
  }
  const likelyFilled = closed.filter((j) => {
    if (ageDays(j.closed_date, today) > 90 || massRuns.has(j.closed_date) || !newIn60) return false;
    const start = j.posted_date ?? (j.is_baseline ? null : j.first_seen);
    if (!start) return true;
    const open = ageDays(start, j.closed_date);
    return open >= 21 && open <= 112;
  });
  const filledGtm = likelyFilled.filter((j) => GTM.has(j.function ?? ""));

  // ---- New market entry (+25): GTM role, office or local team in a country with none before. Once per country.
  // "None before" = no evidence of presence older than 12 months in our data. With no history yet, presence
  // has an unknown start date -> indirect (60%).
  const home = new Set([c.hq_country]);
  const markets = new Map<string, { date: string | null; detail: string; url: string | null; evidence: "direct" | "indirect"; dummy: boolean }>();
  for (const j of gtmJobs) {
    if (!j.country || home.has(j.country)) continue;
    const p = postedOf(j);
    const prev = markets.get(j.country);
    const dated = p !== null && ageDays(p, today) <= 90;
    if (!prev || (dated && !prev.date)) {
      markets.set(j.country, { date: dated ? p : null, detail: `${gtmJobs.filter((x) => x.country === j.country).length} open GTM role(s) in ${j.country}, e.g. "${j.title}"`, url: j.url, evidence: dated ? "direct" : "indirect", dummy: false });
    }
  }
  for (const e of events.filter((e) => e.type === "office")) {
    const m = e.value.match(/\b(united states|u\.s\.|usa|us|uk|united kingdom|germany|france|japan|india|singapore|canada|brazil|mexico|spain|italy|netherlands|australia)\b/i);
    if (!m) continue;
    const iso = ({ "united states": "US", "u.s.": "US", usa: "US", us: "US", uk: "GB", "united kingdom": "GB", germany: "DE", france: "FR", japan: "JP", india: "IN", singapore: "SG", canada: "CA", brazil: "BR", mexico: "MX", spain: "ES", italy: "IT", netherlands: "NL", australia: "AU" } as Record<string, string>)[m[1].toLowerCase()];
    if (!iso || home.has(iso) || markets.has(iso)) continue;
    const old = e.event_date && ageDays(e.event_date, today) > 365;
    if (old) continue; // presence older than 12 months: not new
    markets.set(iso, { date: e.event_date, detail: e.value, url: e.source_url, evidence: e.event_date && ageDays(e.event_date, today) <= 90 ? e.evidence : "indirect", dummy: !!e.is_dummy });
  }
  // Without real history we can't tell a NEW country from one the company has sold in for years, so on a
  // company's baseline run only the strongest market counts (indirect); other countries are shown as presence.
  // From the second real run, a country is new when it first appears after the first run (direct, each counted).
  const hasRealHistory = snaps.some((s) => !s.is_dummy && s.run_date < today);
  const entries = [...markets].map(([iso, m]) => {
    const age = m.date ? agePositive(ageDays(m.date, today)) || 1 : 1; // presence still visible today
    const evidence = hasRealHistory ? EVIDENCE[m.evidence] : EVIDENCE.indirect;
    return sig(`new_market:${iso}`, `New market entry (${iso})`, 25, age, evidence, m.date, m.detail, m.url, m.dummy);
  }).sort((a, b) => b.value - a.value || (b.date ?? "").localeCompare(a.date ?? "") || gtmJobs.filter((j) => j.country === b.key.slice(11)).length - gtmJobs.filter((j) => j.country === a.key.slice(11)).length);
  if (hasRealHistory) out.push(...entries);
  else if (entries.length) {
    out.push(entries[0]);
    for (const e of entries.slice(1)) context.push({ type: "presence", value: `${e.name.replace("New market entry", "Presence")}: ${e.detail}`, source_url: e.source_url });
  }

  // ---- GTM team build-out (+20): 4+ GTM roles in one country (open now; posted in the last 90 days when dated).
  // Roles that closed and look filled keep counting for 90 days: a team that got hired is still a build-out.
  const byCountry = new Map<string, { open: JobIn[]; filled: number }>();
  const slot = (k: string) => byCountry.get(k) ?? byCountry.set(k, { open: [], filled: 0 }).get(k)!;
  for (const j of gtmJobs) {
    if (!j.country) continue;
    const p = postedOf(j);
    if (p && ageDays(p, today) > 90) continue; // dated and older than 90 days: not a build-out now
    slot(j.country).open.push(j);
  }
  for (const j of filledGtm) if (j.country) slot(j.country).filled++;
  for (const [ctry, x] of byCountry) {
    const n = x.open.length + x.filled;
    if (n >= 4) out.push(sig("gtm_buildout", "GTM team build-out", 20, 1, 1, null,
      x.filled ? `${n} GTM roles in ${ctry}, ${x.filled} now likely filled` : `${n} open GTM roles in ${ctry}`, x.open[0]?.url ?? null));
  }

  // ---- Senior GTM hire (+20): VP/Head/Chief in Sales, Revenue, CS, Partnerships, Marketing (open post).
  const senior = gtmJobs.filter((j) => j.seniority === "VP+" && SENIOR_GTM.test(j.title));
  if (senior.length) out.push(sig("senior_gtm", "Senior GTM hire", 20, 1, 1, postedOf(senior[0]), senior.slice(0, 3).map((j) => j.title).join("; "), senior[0].url));

  // ---- Hiring speeding up (+15): 5+ roles posted in the last 90 days, making up 30%+ of open roles.
  const recentJobs = jobs.filter(recent);
  if (recentJobs.length >= 5 && recentJobs.length / Math.max(1, jobs.length) >= 0.3) {
    out.push(sig("speeding_up", "Hiring speeding up", 15, 1, 1, null, `${recentJobs.length} of ${jobs.length} open roles posted in the last 90 days`, recentJobs[0].url));
  }

  // ---- Series B window (+10): Series A closed 12–24 months ago. A state: never ages.
  if (c.last_round && /series a/i.test(c.last_round) && c.round_closed) {
    const months = ageDays(c.round_closed, today) / 30.44;
    // No signal date: the window is a state, and the round's close date is not "when the window opened".
    if (months >= 12 && months <= 24) out.push(sig("series_b_window", "Series B window", 10, 1, 1, null, `Series A closed ${Math.round(months)} months ago (${c.round_closed.slice(0, 7)}): in the usual Series B window`, null));
  }

  // ---- Event-based signals (need a date).
  for (const e of events) {
    if (!e.event_date) {
      if (["validation", "plan", "layoff", "round", "office"].includes(e.type)) context.push({ type: e.type, value: e.value, source_url: e.source_url });
      continue;
    }
    const d = ageDays(e.event_date, today);
    const ev = EVIDENCE[e.evidence] ?? 1;
    const dummy = !!e.is_dummy;
    if (e.type === "new_page" && /^partner page/.test(e.value)) out.push(sig("partner_program", "Partner or channel program", 10, agePositive(d), ev, e.event_date, e.value, e.source_url, dummy));
    else if (e.type === "new_page" && /^industry page/.test(e.value)) out.push(sig("industry_pages", "New industry pages", 5, agePositive(d), ev, e.event_date, e.value, e.source_url, dummy));
    else if (e.type === "plan" && CONCRETE_PLAN.test(e.value)) out.push(sig("plan", "Announced expansion plan", 10, agePlanOrNegative(d), ev, e.event_date, e.value, e.source_url, dummy));
    else if (e.type === "validation") out.push(sig("validation", "Market validation", 5, agePositive(d), ev, e.event_date, e.value, e.source_url, dummy));
    else if (e.type === "layoff") out.push(sig("layoff", "Layoffs reported", -25, agePlanOrNegative(d), ev, e.event_date, e.value, e.source_url, dummy));
  }

  // ---- Mix shifting toward GTM (+10): GTM share of recent postings 15+ points above older open roles.
  const older = jobs.filter((j) => { const p = postedOf(j); return p !== null && ageDays(p, today) > 90; });
  if (recentJobs.length >= 4 && older.length >= 4) {
    const share = (l: JobIn[]) => l.filter((j) => GTM.has(j.function ?? "")).length / l.length;
    const diff = (share(recentJobs) - share(older)) * 100;
    if (diff >= 15) out.push(sig("gtm_mix", "Mix shifting toward GTM", 10, 1, 1, null, `GTM share ${Math.round(share(recentJobs) * 100)}% of recent vs ${Math.round(share(older) * 100)}% of older roles`, null));
  }

  // ---- R&D build-up (+5): 4+ R&D roles posted in the last 90 days.
  const rd = recentJobs.filter((j) => j.function === "R&D");
  if (rd.length >= 4) out.push(sig("rd_buildup", "R&D build-up", 5, 1, 1, null, `${rd.length} R&D roles posted in the last 90 days`, rd[0].url));

  // ---- Hiring paused (−15): only when roles look pulled, not filled. Fewer open roles alone is never a penalty.
  //  (a) a mass closure in the last 60 days and no new postings since; or
  //  (b) open roles down 50%+ vs ~60 days ago AND layoff or hiring-freeze news in the last 90 days.
  const now = snaps.find((s) => s.run_date === today && !s.is_dummy)?.open_jobs ?? null;
  const past = snaps.filter((s) => ageDays(s.run_date, today) >= 50 && s.open_jobs !== null).sort((a, b) => b.run_date.localeCompare(a.run_date))[0];
  const recentMass = [...massRuns].filter((d) => ageDays(d, today) <= 60).sort().pop();
  const freezeNews = events.find((e) => e.event_date && ageDays(e.event_date, today) <= 90 && (e.type === "layoff" || /hiring freeze|freez(e|es|ing) hiring/i.test(e.value)));
  if (recentMass && !newIn60) {
    const n = closed.filter((j) => j.closed_date === recentMass).length;
    out.push(sig("hiring_paused", "Hiring paused", -15, 1, 1, recentMass, `${n} roles closed at once on ${recentMass}, no new postings since`, null));
  } else if (now !== null && past?.open_jobs && now <= past.open_jobs * 0.5 && freezeNews) {
    out.push(sig("hiring_paused", "Hiring paused", -15, 1, 1, null, `open roles ${past.open_jobs} → ${now}, with layoff or freeze news`, freezeNews.source_url, !!past.is_dummy));
  }

  // ---- Size: open roles as a share of headcount (from news). Context only; not scored, because only some
  // companies publish a headcount and it is often months old. Unknown headcount -> null ("size unknown").
  const size: ScoreOut["size"] = c.headcount && c.headcount > 0
    ? { headcount: c.headcount, open: jobs.length, pct: Math.round((jobs.length / c.headcount) * 100) } : null;

  const signals = keepBest(out.filter((s) => s.value !== 0)).sort((a, b) => b.value - a.value);
  // One hiring wave counts once: the strongest wave signal stays full, the others count half.
  const wave = signals.filter((s) => HIRING_WAVE.has(s.key) && s.value > 0);
  for (const s of wave.slice(1)) { s.value = Math.round(s.value * 5) / 10; s.detail += ` (half: same hiring wave as ${wave[0].name})`; }
  signals.sort((a, b) => b.value - a.value);
  const sum = signals.reduce((a, s) => a + s.value, 0);
  const score = Math.max(0, Math.min(100, Math.round(sum)));
  const decline_flag = signals.some((s) => s.points < 0);

  // Coverage: full = job data + history; partial = website/news only or no listings; low = little found.
  const hasJobData = ["greenhouse", "lever", "ashby", "comeet", "getro", "careers_page"].includes(c.job_source_type);
  const hasHistory = snaps.some((s) => s.run_date < today);
  const coverage: ScoreOut["coverage"] = hasJobData && hasHistory ? "full" : hasJobData || events.length >= 3 ? "partial" : "low";
  return { score, band: bandOf(score), coverage, decline_flag, signals, context, size, filled: likelyFilled.length };
}
