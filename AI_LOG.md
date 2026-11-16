# AI log

How AI was used to build Growth Signals, step by step. "I" is me (the candidate); "Claude Code" is the coding agent.

## Summary

**Tools**

| Tool | Used for |
|---|---|
| Claude (chat) | Product thinking: the PRD and the first version of `BUILD_BRIEF.md` |
| Claude Code | All code, data checks, test writing, debugging and the dashboard, working from the brief one build step at a time |
| Claude Haiku 5.5 (API, in the pipeline) | Four jobs: extracting roles from careers pages; classifying every role (function, seniority, country); triaging and reading news / About pages into dated events; writing the reason line from the scored signals |
| Claude Code design skills + Claude in Chrome | The dashboard's UI/UX rounds, and reading greenfield-growth.com's styles to match them |

**My part**
- **Product and signal design.** I chose Option B and defined the user (a Greenfield partner or associate) and the decision ("who should I reach out to this week, before their next round is public?"). I designed the 13-signal library and its weights, the scoring formula (signal points × recency × confidence), the bands, and the stage-fit rules, which I based on studying where Greenfield's own portfolio entered (mostly Series B and C; Series A only in deep tech).
- **The company list.** On 11 Nov I rebuilt the company list to mirror Greenfield's five categories and stages (16 out, 16 in, one deliberate off-thesis test) and wrote the change note Claude Code worked from (what it said is recorded under "Step 1 re-run for the new list" below). On 13 Nov I removed Greenfield's portfolio company, Capitolis, so the list is 40.
- **Checking the data by hand.** I opened every job-source row that wasn't high confidence and checked it myself (fixes in `data/job_sources_overrides.csv`), spotted that Rein and Hush were hiring with no careers page, and moved Majestic Labs to Deep tech.
- **Catching the AI's mistakes.** I caught the scoring and data-matching errors listed below by tracing real scores and reading the output.
- **Every judgement call:** the Reach out thresholds, ranking Past Stage companies, what counts as real vs dummy, and every dashboard design decision (each dashboard change in this log came from my review).

**What the AI did**
- Claude Code wrote the code, tests and dashboard from my brief, one build step at a time, and ran the checks. I reviewed the output after every step and sent back what looked wrong.
- **The score is plain arithmetic.** AI never sets a number; it only extracts, classifies and writes the reason line, which may only use the scored signals.

**Mistakes the AI made, and who caught them**
- Guessed job-board slugs matched the wrong company (Lever "hush", Greenhouse "slice"). **I caught it** in my hand check; a guessed slug now needs the company's domain in the job text.
- Gave background facts the article's date, so an old Series D looked new. **I caught it** in the news output.
- Counted every existing foreign team as a "new market" on a first run (Classiq, Upwind at 100). **I caught it** against the test cases.
- Counted one hiring wave 4–5 times (Daylight 105 → capped 100). **I caught it** by tracing real scores.
- Treated a later re-score as a second run. **I caught it** when Wonderful and Daylight jumped to 100.
- Counted Directors as VP+, which would inflate "Senior GTM hire". Caught in review by reading 40 classified Directors.
- The rename matcher paired the wrong roles (Faye). Claude Code caught it by simulating a second run on a copy of the database.

**Cost:** about 500 Claude Haiku calls across all runs and re-runs, about **$0.40** in total.

## Step 1: job-source check (10 Nov 2026)

- **Claude Code** wrote the survey script (`scripts/find_job_sources.ts`) and the shared helpers (`src/lib/fetch.ts`, `ats.ts`, `render.ts`, `csv.ts`).
- **Domains:** 22 of 41 domains were guessed and checked by fetching the homepage title. The rest came from web searches of funding news, then the same check. Look-alike domains were rejected (e.g. grain.com is an AI notetaker, mave.io is a video host, aligned.com is an ASIC firm, bites.com is an unrelated app). Result: `data/company_domains.csv`, with the evidence for each.
- **Comeet endpoint (open question in brief §16), verified:** `GET https://www.comeet.co/careers-api/2.0/company/{uid}/positions?token={token}`. The uid and a public token are embedded in each company's careers page, in three different formats. Positions include `time_updated`, department, and location country.
- **Getro:** the JSON API isn't publicly callable. We render `{board}/companies?q={name}` instead, then confirm the company's domain on its Getro profile.
- **Manual checks:** I opened each row that wasn't high confidence and checked it by hand. The fixes are in `data/job_sources_overrides.csv`. Slug guessing produced two false matches: Lever "hush" is a design agency and Greenhouse "slice" is a US consumer company. So the rule is now: a guessed slug counts only if the company's domain appears in the job text.
- No Claude API calls yet. AI extraction starts in step 4.
- **Run reliability (11 Nov 2026):** one full run hung for 17 h on a single stuck page, and a later run was cut short when the laptop slept. Fixes: a hard 240 s cap per company, and `--merge "A" "B" …`, which re-surveys only the named companies and merges them into the existing results. Long runs go under `caffeinate -i`. The final merged run has 41 of 41 rows and 0 errors.

## Step 1 re-run for the new list (11–12 Nov 2026)

- 11 Nov: company list rebuilt to mirror Greenfield's portfolio; step 1 re-run.
- **Domains** for the 16 new companies were checked by homepage title. Look-alikes were rejected: limitlesslabs.ai is an analytics firm, so we use limitless-labs.ai (ex-LimitlessCNC); majesticlabs.ai is a parked domain. Results were merged into `data/company_domains.csv`. Overrides for the 16 removed companies were dropped.
- **Missed hiring pages (I spotted them):** Rein and Hush had no careers link, only a careers@ email and "we're hiring" copy on their About page. The survey now also checks the careers page, the homepage, and About/Company/Team pages (taken from homepage links, sitemap.xml and common paths) for an open hiring statement. Matches get the new source type `hiring_statement`. Regression tests built from the real page wording are in `scripts/test_hiring.ts` (`npm test`).
- **Other survey bugs found in review:**
  - The trailing slash was stripped from careers links. ZutaCore's `/careers` returns 404, while `/careers/` works.
  - Soft-404 pages weren't recognised.
  - "No open positions" was being read as hiring (Phytolon).
  - A Comeet API call made in the browser wasn't detected (Classiq showed 52 on Getro; Comeet has 27).
  - Parametrix's Greenhouse/Lever namesakes are a US engineering firm; the domain check correctly rejected them.
- **Fit tags** (`src/lib/fit.ts`, `npm run fit`): §8 rules recomputed from round, category and status. Majestic Labs was moved from AI infrastructure to Deep tech in `companies.csv` (my decision, 12 Nov: memory hardware). All 41 now match the pre-filled column.
- **Run reliability:** the laptop slept mid-run again (lid close overrides `caffeinate -i`), and a finished run never exited. The script now calls `process.exit` when done; affected companies were re-run with `--merge`.

## Step 2: D1 schema and company load (12 Nov 2026)

- **Claude Code** wrote `wrangler.jsonc` (D1 binding `DB`, no database_id until first deploy), `migrations/0001_initial.sql`, a read-only Worker (`worker/index.ts`: `/api/health`, `/api/companies`, `/api/coverage`), and `scripts/load_companies.ts`.
- **Schema** follows brief §4, plus fields step 1 showed we need:
  - category, round amount, fit visibility and reason, careers URL, ATS slug, job-source confidence and notes;
  - `hiring_statement` as a job-source type, and `open_jobs` on snapshots;
  - check constraints on enums, foreign keys, and unique keys on `(company_id, source, source_job_id)` for jobs and `(company_id, run_date)` for scores.
- **Loader** merges `companies.csv`, the verified domains, step-1 job sources and the computed fit tags, then upserts on domain. Re-running it is safe, and companies dropped from the list are deleted. Comeet tokens are never stored.
- **Verified locally:** 41 companies, 41 unique domains, 7 conflicts, 1 portfolio. Zenzap is stored with closed 2025-08 and announced 2026-10. `wrangler dev` serves all 41 from D1.
- **Cloudflare setup:** ran Cloudflare's agent-setup steps for Claude Code (`claude plugin marketplace add cloudflare/skills`, `claude plugin install cloudflare@cloudflare`).
- No Claude API calls yet.

## Step 3: ATS collectors (12 Nov 2026)

- **Claude Code** wrote:
  - `src/collectors/ats.ts`: Greenhouse, Lever, Ashby, plus Comeet via its public hosted page or its API with the token read fresh from the careers page each run (never stored). The HTTP function is passed in, so the same code can run in the Worker.
  - `scripts/collect_ats.ts`, `src/lib/country.ts`, `src/lib/d1.ts`, and `migrations/0002_job_details.sql` (department, location, remote, `source_updated`, `source_state`).
- **§7 rules in SQL:**
  - jobs are keyed on `(company, source, source_job_id)`, and `first_seen` is set once;
  - jobs missing from a successful fetch close, while a failed fetch keeps the last data (retried after 1/5/30 min, then marked `not_reached`);
  - undated roles on a company's first run are the baseline.
- **Comeet has no posted date.** Its `time_updated` is stored as `source_updated`, never as `posted_date`, so an edited old role doesn't look new. All 331 Comeet roles are therefore baseline on run 1, and new Comeet roles count from `first_seen` from run 2 onward.
- **Privacy fix found in review:** Comeet location objects include street addresses and building entrance codes, and PhaseV's Greenhouse office names are full addresses. Only city, state and country are stored (`safeLocation`).
- **Conditional requests:** the fetcher now sends ETag / If-Modified-Since and reuses the body on 304.
- **Run on 12 Nov:** 27 companies, 614 open jobs, 0 failures. Counts are within ±1 of step 1. Onyx = 9 US go-to-market + 5 Tel Aviv roles, matching the brief's dry run. A second run created no duplicates, kept first-seen dates and closed a test job. 18 open jobs have no country yet (step 4 AI).
- No Claude API calls yet.

## Step 4, part 1: pages, Getro, AI setup (12 Nov 2026)

- **Built:** a Getro collector (renders the board, stable numeric job ids, "Posted: 9 days / 6+ months" turned into dates); a careers-page collector (page text plus candidate job links go to Claude Haiku 5.5, which maps each role to its own link for a stable id; the AI is skipped when the page hash is unchanged); batch AI classification of function, seniority and country (`scripts/enrich_jobs.ts`); and hiring statements stored as footprint rows. The §7 save logic now lives in `src/lib/store.ts`, shared by all collectors.
- **Run without an API key:** 4 Getro boards gave 34 roles (Airis 5, Quantum Art 19, Visitt 5, Prisma 5). Hiring statements were recorded for ZutaCore and UltraSight. The 6 careers pages are waiting on `ANTHROPIC_API_KEY` (marked failed, last data kept).
- **Aggregator fallback (brief §5 row 7), checked on 12 Nov** (robots.txt allows company pages on all three sites):
  - Zenzap and UltraSight are not listed on Remote Rocketship, Simplify or freehire.
  - Parametrix pages on Simplify and freehire don't mention parametrixinsurance.com (the same-name US engineering firm), so they were rejected by the domain rule.
  - ZutaCore: freehire matches the domain but has 0 open jobs (it shows 122 employees, a possible headcount source); Simplify hides jobs behind a login.
  - Result: no aggregator collector built, because nothing usable was found.

## Step 4: AI run (12 Nov 2026)

- **Claude API (`claude-haiku-5-5`, structured outputs via `messages.parse` + Zod), first real calls in the project:**
  - **Careers pages:** 6 pages, 6 calls. Vega 28, Qodo 7, Xtend 18, Limitless Labs 4, Faye 16 (13 Comeet-linked roles plus 3 unlinked ones on the page), Phytolon 0 (the model flagged "no open positions").
  - **Classification:** 648 jobs in 17 calls, 0 failures. Every one of the 721 open jobs now has a function and seniority, and 703 have a country. The other 18 are multi-country regions (Iberia, CCA, Global) and correctly stay blank.
- **Rules corrected after reviewing the output:**
  - The prompt counted Directors as VP+, which would inflate the "Senior GTM hire" signal (brief: VP/Head/Chief). Directors are now Manager. The 6 pages were re-extracted and 40 Directors checked.
  - Unframe's 8 "Regional GM" roles came back as function Other; regional and country GMs are now Sales. Only those 8 were re-classified (1 call).
- **Check against the brief:** Onyx = 9 US go-to-market + 5 Tel Aviv R&D, exactly the dry run.
- **Idempotent:** a second page run made 0 AI calls (unchanged page hash), and the classifier skips already-classified jobs.
- **Tokens for the whole step:** about 93K in and 61K out across 30 calls, roughly $0.04 at Haiku 5.5 prices ($0.10 / $0.50 per million).
- **Key handling:** `ANTHROPIC_API_KEY` lives in `.dev.vars` (git-ignored, mode 600) and is never printed. For the deployed Worker it goes in with `wrangler secret put` (step 8).

## Step 5: footprint (12 Nov 2026)

- **Claude Code** wrote:
  - `src/collectors/sitemap.ts`: robots.txt Sitemap lines, nested indexes, URLs classified as partner / country / industry / careers / news / about.
  - `src/collectors/news.ts` and `scripts/collect_footprint.ts`.
  - `migrations/0004_footprint.sql`: site_pages history, news_items, footprint dedupe key.
- **News source changed from the brief:** news.google.com/robots.txt disallows all bots (`User-agent: *  Disallow: /`), so Google News RSS is not used. Bing News RSS (allowed) is queried in English and Hebrew: the name, the short name, "layoffs", "hiring", and "פיטורים". The original article is read from the publisher, which is decoded from Bing's `url=` parameter.
- **Claude Haiku in step 5:**
  - **Headline triage:** is the item about this company, judged by domain, sector and HQ, never the name alone? Grain: 13 items, 0 kept.
  - **Event extraction** from original articles, About pages and newsroom pages: round, office, plan, layoff, validation, headcount, each with a date, direct/indirect evidence, a "main news vs background" flag, and a canonical topic for de-duplication. No people's names.
  - **Published headcount** goes to `companies.headcount` with its source.
- **Fixed after reviewing output:**
  - The press writes "AI21", not "AI21 Labs", so the short name is now queried too.
  - Bing ranks by relevance and caps at ~10 items, so targeted signal queries were added (long OR-queries return almost nothing on Bing).
  - Background facts were being given the article's date (an old Series D looked new; I caught this): only main news falls back to the publication date.
  - "In May" now becomes the 1st of the month.
  - Duplicates come from several outlets reporting one event: dedupe is by type + canonical topic, and rounds by amount.
  - A sitemap lastmod shared by a large part of the site is a rebuild, not new pages (Reco: 34 false events → 2).
  - Partner pages: only program/reseller/channel pages count, not /partners/aws-style technology-partner pages.
  - Articles whose AI call failed are no longer marked as seen, so they are retried.
- **Test cases:**
  - Zenzap: partners page 14 Oct; US + Europe teams, indirect.
  - Airis Labs: "double headcount during 2026", 27 May.
  - AI21: layoff of more than 60% in May 2026.
  - Onyx: Gartner Cool Vendor, Fortune Cyber 60, Anthropic integration (Gartner undated: the newsroom shows no date).
- **Result:** 536 events for 40 of 41 companies (273 dated) and 20+ published headcounts. A network drop mid-run hit 22 companies; they were re-run.
- **Cost:** ~430 Haiku calls across both full runs plus re-runs, about $0.35.

## Step 6: compare + dummy history (12 Nov 2026)

- **Claude Code** wrote `src/lib/compare.ts`, `scripts/compare.ts`, `scripts/seed_dummy_history.ts`, `migrations/0005_compare.sql` (`jobs.is_repost`) and tests in `scripts/test_compare.ts` (13 cases, `npm test`).
- **§7 rules:**
  - Same id = same job: already enforced on save since step 3.
  - Careers-page roles without a stable id are matched across runs when function, country and seniority match and the title is similar (Jaccard ≥ 0.5). The old row and its first_seen are kept.
  - A role is a repost when its posted_date is well before the previous run, or when the same title and country closed earlier.
  - The baseline is set on first sighting.
- **Bug found by simulation:** Claude Code ran a fake second run on a backup copy of the local DB (restored afterwards). The rename matcher was greedy in list order, so Faye's "(non-TI)" role grabbed the renamed "(TI)" role. Matching is now best-similarity-first, and the case was added as a test.
- **Dummy history:** each company with no real history gets 3 snapshots at −90 / −60 / −30 days with `is_dummy = 1` and a deterministic per-company trend toward today's real count. Companies with no job listings get empty counts, so no hiring numbers are invented. These rows are replaced on every run and only used where no real history exists.
- No AI calls in this step.

## Step 7: scoring (12 Nov 2026)

- **Claude Code** wrote `src/scoring/signals.ts` (the 13 signals and the §10 arithmetic, pure functions), `scripts/score.ts` (writes the `scores` table and `public/ranking.json`) and `data/company_hq.csv` (HQ country; default IL, Majestic Labs and Capitolis are US).
- **The score is plain arithmetic.** Claude Haiku writes only the reason line, from the scored signals, with their dates (39 calls, ~$0.01).
- **Interpretations, checked against the §14 test cases:**
  - Open job posts are direct evidence at 100% while open, dated or not.
  - Non-job signals need a date to score; undated ones are kept as context.
  - "Announced expansion plan" must be concrete (headcount target, office, country, numbers), not use-of-funds boilerplate.
  - Each signal counts once (its strongest instance).
- **Calibration issue and fix (I caught it against the test cases):** "New market entry (+25, once per country)" can't tell a new country from an old one on a first run. Every existing foreign sales team counted, so big multi-country companies hit 100 (Classiq, Upwind). Until a company has real history, only its strongest market counts (indirect, 60%), and the other countries are listed as presence. From the second real run, new countries count fully.
- **Reason-line fixes:**
  - Lines are trimmed at a sentence end.
  - The Series B window signal no longer carries the Series A close date, which the model had misread as "window opened Aug 2025".
  - Lines don't mention points or scores.
- **Test cases (§14, ±10):**
  - Onyx 40, Strong (expected ~50).
  - Zenzap 34, Some activity, Pre-Series B (~31).
  - Airis Labs 35, Some activity (~25).
  - Grain 10, Quiet, Pre-Series B (~10).
  - AI21 3 + decline flag, hidden (0 + flag).
  - Capitolis hidden (portfolio).
- **Layoffs found beyond the brief (verified in the Hebrew press):** IVIX ~10% (Calcalist, Sep), Xtend ~10% (Globes, TheMarker, Nov). Xtend is also NYSE-listed, which §8 doesn't cover.

## Step 8 follow-up (13 Nov): size-adjusted scoring, graphs back, run date fix
- **Size adjustment** (`src/scoring/signals.ts`): open roles ÷ headcount (headcount from news, 19 of 40 companies). 25%+ → +10 "Hiring hard for its size"; 15–25% → +5; under 5% → GTM build-out / Hiring speeding up / R&D build-up count half. Unknown size → no adjustment, shown as "size unknown". Thresholds chosen so the §14 cases stay within ±10: Onyx 40→45 (expected ~50), Airis 35 (~25), Zenzap 34 (~31), Grain 10, AI21 3. Datarails (11 roles, ~400 people) 28→21.
- **Bug I found:** re-scoring on a later day with no new collection counted as a second run, so baseline presence became "new markets" (Wonderful and Daylight hit 100). The run date is now the latest real snapshot, not the clock.
- **Dashboard:** graphs restored after a misread ("no graphs at all" meant they were missing): team-mix column, map, Rising summary charts (hiring by function, go-to-market roles by country), and in the drawer a size gauge, roles by country, open roles over time (dummy dashed) and per-signal bars. Palette re-validated on the new dark surface.

## Step 8 follow-up (13 Nov): filled vs pulled roles, comparison chart, Compare
- **Fewer open roles is no longer read as decline.** We can't see hires, so we read how roles close (`src/scoring/signals.ts`):
  - *Likely filled*: closed in the last 90 days, not in a mass closure, while the company keeps posting, after 3–16 weeks open (skipped when the start date is unknown). These keep counting toward GTM build-out for 90 days ("9 GTM roles in US, 6 now likely filled").
  - *Hiring paused* (−15, replaces "Hiring stopped"): only for pulled roles. Either half or more of the open roles (3+) close in one run with no new posts, or open roles fall 50%+ with layoff or hiring-freeze news.
  - Covered by `scripts/test_filled.ts` (9 cases). No roles have closed yet (one real run), so no score changed; these rules start working from the second real run.
- **Dashboard:** the two summary charts are replaced by a comparison chart (open roles as % of headcount vs go-to-market share, dot = reach tier) on Rising and as All companies → Chart. Compare: pick 2–3 companies (checkbox by the rank, or + Compare in the panel) for a side-by-side view with one shared scale for open roles over time.

## Scoring fix (13 Nov): size out of the score, one hiring wave counts once, tighter Reach out
- **Why:** I traced real scores and found one hiring wave scoring 4–5 times. Daylight's 10 Nov burst of ~17 US sales roles fed GTM build-out, Hiring speeding up, Mix shifting toward GTM and Hiring hard for its size, so 105 was capped to 100. Company size came from news for only 19 of 40 companies, often months old. "Reach out now" spanned 40–100.
- **Changes:**
  - `src/scoring/signals.ts`: size (open roles ÷ headcount) is still computed but shown as context only. There's no `size_intensity` signal and no halving.
  - `HIRING_WAVE` group: of gtm_buildout / speeding_up / gtm_mix / rd_buildup, the strongest counts in full and the others count half, with a "(half: same hiring wave as …)" note.
  - `scripts/score.ts`: reach now = 60+ and In Range; warm = 40–59, In Range or Approaching B (matching the bands).
  - The dashboard Guide and size gauge wording were updated on top of the parallel UI session's version of `src/dashboard/index.html`.
- **Deliberately not changed:** the new-market duplicate (same US roles also counted as a new market). It fixes itself from the second real run; halving it now would push Onyx to 33, below the brief's test range.
- **Result:**
  - Daylight 100 → 80. Now: Daylight, Zenity, Unframe, Upwind. Warm: ScaleOps, Faye, Quantum Art, Reco, Linx, Onyx.
  - Datarails 21 → 28; Vega 45 → 35; Nimble 43 → 38.
  - Test cases: Onyx 40, Zenzap 34, Airis 35, Grain 10, AI21 3. All within range.
- **Tests:** new `scripts/test_grouping.ts` (10 cases); all 38 tests pass.

## Dashboard design rounds (13 Nov 2026)

- **Claude Code** reworked `src/dashboard/index.html` over several review rounds. Each change was checked in a browser preview (desktop and phone width) before the next.
- **What changed, from my feedback:**
  - Hover tooltips on every label, from one glossary shared with the Guide. The Guide was cut to about a third.
  - Rising: clear axis titles and named quadrants on the comparison chart (later removed); a "Top 10 rising" headline.
  - The side drawer became a full-screen company page with an **Outreach panel** (owner, status, comments) and a **score over time** chart. Owner became its own column (initials only).
  - **+ Add company** form; added companies show as pending until the next run.
  - "This week" became **What's new**: highlights by default, new roles rolled up per company.
  - A **Stage Fit** board view; company logos; Title Case filters; mock ▲▼ arrows so the change column can be judged before a second run.
- **Data behind it:** `score_series` (score per run) added to `scripts/score.ts` via `src/lib/score_series.ts`; `scripts/add_score_series.ts` patches an existing `ranking.json` without re-scoring (a full re-score would make new AI calls).
- **Ranking change (my decision):** every company except the portfolio one is now ranked by score, Past Stage included; Phytolon shows its stage fit (In Range) instead of "Outside Thesis". Applied in the dashboard when it loads; the brief (§8) was updated to match.
- **Restyle to Greenfield's look:** Claude Code read greenfield-growth.com's live styles through Claude in Chrome. The site's accent is a soft blue, not green, so the accent changed; also its navy background, Manrope with light headlines, lavender greys, thin blue-edged cards and pill buttons. Green and red are kept only for data (▲▼, risks).
- **Mock data on the dashboard, labelled where shown:** the ▲▼ change and the early score history come from the dummy snapshots; the five outreach teammates are fictional; owners, statuses, comments and added companies are saved in the viewer's browser only. Logos are fetched from Google's favicon service by domain.
- **Caught in review:** a tooltip stuck on screen after the page redrew; lazy-loaded logos never loaded in the preview; the Headline column collapsed at medium widths once Owner was added; chart lines crossed hollow points.
- No Claude API calls in these rounds.

## Docs (13 Nov 2026)

- `BUILD_BRIEF.md` was rewritten to describe the system as built (Bing News, Hiring paused, one hiring wave counts once, Reach out tiers, stage-fit labels, the dashboard, real vs dummy, how to run). The original 10–11 Nov plan is what Claude Code built from; this log records each change.

## Run now (13 Nov 2026)

- I asked for a **Run now** button so a run can be started from the dashboard during the live session.
- **Claude Code** wrote `scripts/pipeline.ts` (`npm run pipeline`: every step in order, stops at the first failure) and `scripts/serve.ts` (`npm run serve`: serves the dashboard on localhost and runs the pipeline on request, one run at a time, with live step progress and the log). The button only appears when the page is served by `npm run serve`.
- **Safety:** the server listens on 127.0.0.1 only, and a run can only be started by a JSON request, so other websites open in the browser can't trigger one.
- Tested with a dry run (`?dryrun`), which walks the steps without collecting anything. A real full run takes about 20–40 minutes and makes a few hundred Haiku calls.

## Weekly runs and one-click Run now for the team (13 Nov 2026)

- **My decisions:** host on Cloudflare (as in the original plan), and make Run now a true one-click button that non-developers can use without the code or my API key.
- **Why the run moved to GitHub Actions:** the pipeline needs a real browser (Playwright) and up to 40 minutes, which a Cloudflare Worker doesn't allow. GitHub Actions runs it weekly and on demand; the state moved to Cloudflare D1 in the cloud so history builds up between runs.
- **Claude Code** wrote `.github/workflows/weekly-run.yml` (8 named steps, one run at a time, results committed back), extended `worker/index.ts` (serves the dashboard as static assets; `/api/run` reads GitHub's live step status and starts a run), and updated the dashboard so Run now works in both modes.
- **Keys and safety:** the Anthropic key is only a GitHub secret; the Worker holds a repo-only GitHub token and a team passcode (checked in constant time); starts are refused while a run is going; status is cached for 8 s so open dashboards don't exhaust GitHub's API limit.
- **Tested** with `wrangler dev`: dashboard and data served, Run now hidden until it's configured, starts refused without setup (503) or without JSON (415). Going live needs my one-time account setup (README, "Hosted weekly runs").

## Company list: 40, portfolio company removed (13 Nov 2026)

- **My decision:** take Greenfield's own portfolio company (Capitolis) off the list completely, rather than tracking it and hiding it, so every count reads 40.
- **Claude Code** removed it from the seven input files in `data/`, regenerated the job-source report and the seed, and reloaded both databases (local and Cloudflare D1); its jobs and events were deleted with it. It had 0 open roles and 20 footprint events, so the totals are now 40 companies, 721 open roles, 516 events, and 26 companies on job boards.
- Re-scored with **0 AI calls**: no score or reason line changed. The "portfolio companies are left out" rule stays in the code as a safeguard. Earlier entries in this log keep the counts as they were at the time (41).


## First cloud run and a scoring bug I caught (14 Nov 2026)

- **What happened:** I pressed Run now for the first full run in the cloud (17 minutes, all 8 steps passed). The new ranking looked suspiciously high: Daylight, Upwind, Classiq and Wonderful all at 100, Classiq up 82.
- **The cause (AI's mistake):** the "New market entry" rule was meant to count a country only when it first appears after the first run. The code skipped that check, so from the second run on it counted every foreign country with sales roles as a new market, +15 or +25 each (Classiq got 10 of them).
- **The fix:** a country is new only when its first role (open or closed) was first seen after the company's first run. Countries already there keep the first-run treatment (strongest one only, at 60%) for 90 days, because two days of history still can't say when they started. 6 new tests cover it (44 in all).
- **Result after re-scoring:** most scores are back to where they were. Upwind is the one real mover (+25): its first Japan sales role appeared in this run. 27 AI calls for the changed reason lines.
- **Then I asked** for genuinely new markets to show in What's new → Highlights. Upwind's first Japan sales role now appears there on 14 Nov.

## The Monday run: a timer I can rely on (16 Nov 2026)

- **What happened:** the first scheduled Monday run (GitHub's own schedule, 03:00 UTC) never started; by 10:00 UTC GitHub had not created it. GitHub's schedule is best effort and can be delayed for hours or skipped, especially on the hour.
- **My decision:** don't guess, make it reliable and prove it.
- **Claude Code** moved the timer to a Cloudflare Cron Trigger on the Worker (Mondays 03:17 UTC), using the same GitHub start call as Run now, plus a safety check at 06:17 UTC that starts the run again if nothing succeeded that day. GitHub's schedule was removed so runs never double up.
- **Proved live:** a one-time trigger at 10:07 UTC started "Weekly run (scheduled)" on GitHub, which became this Monday's run. A second test trigger at 10:10, while that run was going, started nothing. The test trigger was then removed.

