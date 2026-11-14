# Growth Signals v1: Build Brief

> The engineering spec for the Greenfield Partners case study, **Option B: team composition as a growth signal**.
> First written on 10–11 Nov 2026 as the brief Claude Code built from; **rewritten on 13 Nov 2026 to describe the system as built**. How each decision changed along the way is in `AI_LOG.md`.

---

## 1. What it does

A pipeline that tracks **40 Israeli and Israel-related tech companies**, turns dated changes in their hiring and public footprint into **scored signals**, and gives Greenfield's investment team a **ranked list** where every score has a reason line with dated source links.

**User:** a Greenfield partner or associate. **Decision:** "Which companies should I reach out to this week, before their next round is public?"

Home assignment, 8–10 hours. Working end to end beats polish.

## 2. Stack

| Part | Choice | Status |
|---|---|---|
| Code | TypeScript, plain scripts (no no-code tools) | Built |
| Database | Cloudflare **D1** (SQLite), run locally with Wrangler | Built (local) |
| JS-rendered careers pages | **Playwright** locally (Cloudflare Browser Rendering in production) | Built (local) |
| AI enrichment | **Claude API**, `claude-haiku-5-5`, structured outputs (`messages.parse` + Zod) | Built |
| Dashboard | One static page (`public/index.html`) reading `public/ranking.json` | Built |
| Worker | Read-only API over D1 (`/api/health`, `/api/companies`, `/api/coverage`) | Built |
| Runs | `npm run pipeline` locally; in the cloud, a GitHub Actions workflow (`.github/workflows/weekly-run.yml`) | Built |
| Schedule | Weekly, Mondays 03:00 UTC (05:00–06:00 Israel time), GitHub Actions | Live |
| Hosting | One Cloudflare Worker serves the dashboard (static assets) and the API; state in Cloudflare D1 | Live: https://team-signals.team-signals.workers.dev |
| Run now | Dashboard button → Worker (team passcode) → GitHub starts the workflow; live step progress | Built (local mode via `npm run serve` too) |
| Not in v1 | Queues, R2, LinkedIn scraping, email/Slack alerts, auto-discovery of companies | Cut on purpose |

Secrets: `ANTHROPIC_API_KEY` lives in `.dev.vars` (git-ignored). In production it goes in with `wrangler secret put`. Keys are never committed or printed.

## 3. Input

`data/companies.csv`, 40 rows: `#, Company, Greenfield category, Sector, Latest round, Amount ($M), Round date, Fit tag, Greenfield status, Role in the list, Why included, Known jobs source, Website`.

- The list mirrors Greenfield's portfolio: its five categories from greenfield-growth.com/portfolio (Cybersecurity 9, AI infrastructure 9, Deep tech 9, Vertical AI 7, Fintech 5), plus one deliberate off-thesis test (Phytolon).
- `Greenfield status`: Greenfield's own portfolio companies are not on the list (a `PORTFOLIO …` row would be left out of the dashboard). `Possible conflict …` (Linx, Oasis, Daylight, Upwind, groundcover, Xtend, Limitless Labs) is kept, with a flag.
- Supporting files: `company_domains.csv` (verified domains with evidence), `job_sources.csv` / `.json` (step 1 survey), `job_sources_overrides.csv` (manual fixes), `company_hq.csv`, `fit_tags.csv`.
- Rounds store both **closed** and **announced** dates (Zenzap: closed Aug 2025, announced Oct 2026).

## 4. Data model (D1)

Five migrations in `migrations/`. Main tables:

| Table | Holds |
|---|---|
| `companies` | name, domain (unique), HQ, category, sector, round + closed/announced dates, amount, Greenfield status, fit tag + visibility + reason, job source type/URL/slug/confidence, careers URL, headcount + source |
| `snapshots` | one row per company per run: sources checked (ok / empty / failed / not_reached), coverage, open job count, `is_dummy` |
| `jobs` | `(company, source, source_job_id)` unique; title, function, seniority, country, department, location, posted date, first/last seen, open, baseline, repost, `is_dummy` |
| `footprint` | dated events: new page, office, plan, validation, layoff, round, hiring statement; evidence direct/indirect; source URL; `is_dummy` |
| `site_pages`, `news_items`, `page_extractions`, `source_state` | history used to spot new pages, avoid re-reading articles, skip unchanged pages, and retry failed sources |
| `scores` | `(company, run_date)` unique: score, band, fit tag, coverage, decline flag, reason line, signals JSON |

**Privacy:** roles and counts only. No people's names or photos. Locations are cut to city, state and country (some sources include street addresses and door codes).

## 5. Collectors

For each company, sources are tried in this order and each is recorded as ok / empty / failed / not reached.

| # | Source | How |
|---|---|---|
| 1 | Greenhouse | `boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true` |
| 2 | Lever | `api.lever.co/v0/postings/{company}?mode=json` |
| 3 | Ashby | `api.ashbyhq.com/posting-api/job-board/{name}` |
| 4 | Comeet | `comeet.co/careers-api/2.0/company/{uid}/positions?token={token}`; uid and public token read fresh from the careers page each run, never stored. No posted date: `time_updated` is kept as `source_updated` only |
| 5 | Getro (investor job boards) | Board rendered, company matched by domain on its profile; "Posted 9 days ago" turned into dates |
| 6 | Own careers page | Rendered with Playwright; Claude Haiku extracts roles and links each to its own URL; skipped when the page hash is unchanged |
| 7 | Hiring statement | No job list, but the careers / About page says "we're hiring" (e.g. a careers@ address) |
| – | Aggregators | Checked (Remote Rocketship, Simplify, freehire); nothing usable found, so no collector built |

A guessed ATS slug only counts if the company's domain appears in the job text (Lever "hush" and Greenhouse "slice" were false matches).

**Footprint, every company, every run:**
- `sitemap.xml` (via `robots.txt`, nested indexes): new URLs vs last run, classified as partner / country / industry / careers / news / about. A `lastmod` shared by a large part of the site is a rebuild, not new pages.
- About, team and newsroom pages: offices, published headcount, events (titles only, no names).
- **News in English and Hebrew from Bing News RSS.** Google News is not used: its `robots.txt` disallows all bots. The original article is read from the publisher. Claude Haiku first checks the item is about this company (domain, sector, HQ, never the name alone; Grain: 13 items, 0 kept), then extracts dated events.

**Polite fetching:** clear User-Agent, robots.txt respected, ≥3 s between requests to one host, ETag / If-Modified-Since, retries after 1 / 5 / 30 min, then "not reached" while keeping the last data. A hard 240 s cap per company. No CAPTCHA solving, no disguised bot, no LinkedIn scraping.

## 6. AI enrichment (Claude Haiku)

Strict JSON via structured outputs. AI is used for:

- **Careers pages:** `[{title, function, seniority, country, posted_date|null, url}]`.
- **Every job:** `function` ∈ {R&D, Sales, Marketing, Customer success, Partnerships, G&A, Other}; `seniority` ∈ {IC, Manager, VP+} (Directors are Manager; VP/Head/Chief are VP+); `country` as ISO code ("Remote-US" → US; multi-country regions stay blank). Regional and country GMs are Sales.
- **News, About and newsroom pages:** relevance triage, then `{type: round|office|plan|layoff|validation|headcount, value, event_date, evidence: direct|indirect, main_news, topic}`. Background facts never take the article's date.
- **Reason line:** written only from the scored signals, with their dates. No points, no invented facts.

**The score itself is plain arithmetic, not AI.**

## 7. Compare and dedupe

- Same `source_job_id` = same job; a renamed job keeps its ID.
- No ID (careers pages): same job if function, country and seniority match and the title is similar (Jaccard ≥ 0.5), matched best-similarity-first.
- Repost: posted well before the previous run, or the same title and country closed earlier.
- **First sighting is the baseline:** undated roles seen on a company's first run never count as "new".
- A job missing from a successful fetch closes; a failed fetch keeps the last data.
- The run date is the latest real snapshot, not the clock (re-scoring later must not count as a second run).

## 8. Stage fit (decides labels and reach-out, not the score)

| Internal tag | Dashboard label | Rule |
|---|---|---|
| In mandate | **In Range** | Series B or C; or Series A in deep tech |
| Pre-Series B | **Approaching B** | Series A closed 12–24 months ago (outside deep tech) |
| Too early | **Too Early** | Series A closed under 12 months ago (outside deep tech) |
| Too late | **Past Stage** | Series D+, $1B+ valuation, or acquired |
| Portfolio | (not shown) | Greenfield invested; none on the list |
| Off-thesis | (no label) | Outside Greenfield's five categories (Phytolon) |

**Why these stage rules:** Greenfield's portfolio page shows it leads mostly at Series B and C, and at Series A only in deep tech (Commcrete, Exodigo).

**Ranking (changed on 13 Nov, user decision):** every company is **ranked by score**, Past Stage included (Wonderful is #9). Stage fit is shown as a label and a filter, and it gates the **Reach out** tiers. The off-thesis company has no fit label; the dashboard shows its stage fit from the round (Phytolon, Series B → In Range) and its Type stays "Other". The scoring script still writes the original visibility to `ranking.json`; the dashboard applies the new ranking when it loads.

## 9. Signal library

| Signal | Detection rule | Points |
|---|---|---|
| New market entry | GTM role, office or local team in a country with none before (once per country) | +25 |
| GTM team build-out | 4+ Sales/Marketing/CS/Partnerships roles in one country in the last 90 days (likely-filled roles keep counting for 90 days) | +20 |
| Senior GTM hire | VP/Head/Chief in Sales, Revenue, CS, Partnerships or Marketing | +20 |
| Hiring speeding up | 5+ roles posted in the last 90 days, 30%+ of open roles | +15 |
| Series B window | Series A closed 12–24 months ago (a state, never ages) | +10 |
| Partner or channel program | A partners / resellers / channel page appears (not technology-integration pages) | +10 |
| Mix shifting toward GTM | GTM share of recent postings 15+ points above older open roles | +10 |
| Announced expansion plan | Concrete plan in the news: headcount target, office, country or numbers (not use-of-funds boilerplate) | +10 |
| R&D build-up | 4+ R&D roles posted in the last 90 days | +5 |
| New industry pages | New industry / solution pages | +5 |
| Market validation | Analyst recognition, major industry list, integration with a major platform | +5 |
| Hiring paused | Roles look pulled, not filled: half or more (3+) close in one run with no new posts, or open roles fall 50%+ with layoff or hiring-freeze news. Needs two real runs | −15 |
| Layoffs reported | Layoffs, restructuring or shutdown in the news | −25 |

**Likely filled vs pulled:** a role that closes after 3–16 weeks open, while the company keeps posting and not in a mass closure, counts as likely filled. Fewer open roles is not a penalty on its own.

## 10. Scoring

```
Score = max(0, min(100, Σ SignalPoints_i × Recency_i × Confidence_i))
```

- **Recency:** open job posts 100% while open. Other positive signals: 0–30 days 100%, 31–90 days 50%, older dropped. Plans and negative signals: 0–90 days 100%, up to 12 months 50%. Series B window doesn't age. Non-job signals need a date to score; undated ones are kept as context.
- **Confidence:** direct (job post, news report) 100%; indirect (website change only, or presence with no start date) 60%.
- **Each signal counts once** (its strongest instance).
- **One hiring wave counts once:** of GTM build-out, Hiring speeding up, Mix shifting toward GTM and R&D build-up, the strongest counts in full and the others count half.
- **New markets on a first run:** with no history, a foreign team can't be told from a new one, so only the strongest market counts (indirect, 60%) until the second real run.
- **Company size is context, not score:** open roles ÷ headcount (headcount from news, about half the companies) is shown on the company page.
- **Decline flag:** any negative signal in the last 12 months.
- **Coverage:** full (job data + history), partial (website / news only), low (little found). "Not checked" is shown apart from "checked, nothing found".
- **Bands:** 0–19 Quiet · 20–39 Some activity · 40–59 Strong growth story · 60+ Exceptional.
- **Reach out:** **Reach out now** = score 60+ and In Range. **Warm** = 40–59, In Range or Approaching B.
- **Every signal carries a real / dummy label.**

## 11. Dashboard

One static page (`src/dashboard/index.html` → `npm run build:dashboard` → `public/index.html`), styled after greenfield-growth.com (navy, Manrope, one soft-blue accent).

- **Rising:** the top 10 by score (biggest movers once there are two real runs), with Reach out tiers.
- **All companies:** List, **Stage Fit** board (one column per stage), Chart and Map (open roles by country). Search, filters (reach, type, stage fit, band, decline, coverage, country, owner, outreach status) and sorting.
- **What's new:** dated changes over the last 7–90 days. Highlights (funding, plans, offices, risks) by default; new roles rolled up per company.
- **Company page (full screen):** score, band, reach tier, headline, reason line, links, **score over time**, and tabs for Changes, Why (every signal with points and source) and Team (hiring vs size, roles by function and country, open roles over time). A "Check on LinkedIn" link for low-coverage companies.
- **Outreach panel** on each company: owner, status (Not Contacted → Meeting Set / Passed), comments.
- **Compare** 2–3 companies side by side; **+ Add company** to track a new one (scored on the next run).
- Hover tooltips on every label and a short Guide, both from one glossary.

## 12. Real vs dummy

| Real | Dummy or mock |
|---|---|
| Company list and funding facts | Past snapshots before the first run (`seed_dummy_history.ts`, `is_dummy = 1`): 3 per company at −90/−60/−30 days, drawn dashed and hollow |
| Current open roles and posting dates (12 Nov run) | Score history before the first run: today's score scaled by the dummy open-role counts |
| Website pages, sitemaps, news, published headcount | ▲▼ score change: vs that dummy history until a second real run exists (tooltip says so) |
| Scores and reason lines | Outreach team (5 fictional names), owners, statuses and comments: saved in the viewer's browser only |
| | Companies added with + Add company: saved in the browser, not scored until the next run |
| | Logos: fetched live from Google's favicon service by domain (initials when none) |

## 13. How to run (local)

**One command:** `npm run pipeline` runs every step below in order and stops at the first step that fails. **Or from the dashboard:** `npm run serve`, open http://localhost:4180 and press **Run now** (live progress and log; the dashboard reloads when the run finishes). Add `?dryrun` to the URL to test the button without collecting anything.

The steps, which can also be run one by one:

```
npm install
npm run db:migrate        # D1 schema (local)
npm run db:load           # companies + verified domains + job sources + fit tags
npm run collect:ats       # Greenhouse, Lever, Ashby, Comeet
npm run collect:pages     # Getro boards + careers pages (Claude Haiku)
npm run enrich            # function / seniority / country for every job (Claude Haiku)
npm run collect:footprint # sitemaps, About/newsroom, Bing News EN+HE (Claude Haiku)
npm run compare           # dedupe, reposts, baseline
npm run seed:dummy        # dummy history where no real history exists
npm run score             # scores table + public/ranking.json (Claude Haiku reason lines)
npm run build:dashboard   # public/index.html
npm test                  # 38 rule tests
```

Then `npm run serve` and open http://localhost:4180 (any static server for `public/` works too; it just won't show Run now). The AI steps need `ANTHROPIC_API_KEY` in `.dev.vars`.

## 14. Test cases (manual dry run, 10 Nov 2026)

Expected ±10. Result from the 12 Nov run.

| Company | Expected | Result |
|---|---|---|
| Onyx Security | ~50, Strong | 40, Strong |
| Zenzap | ~31, Some activity, Approaching B | 34, Some activity, Approaching B |
| Airis Labs | ~25, Some activity | 35, Some activity |
| Grain | ~10, Quiet, Approaching B | 10, Quiet, Approaching B |
| AI21 Labs | 0 + decline flag, Past Stage | 3 + decline flag, Past Stage (ranked #36 since the 13 Nov ranking change) |

## 15. Definition of done

- [x] One command runs collect → enrich → compare → score → dashboard (`npm run pipeline`, or Run now in the dashboard)
- [x] Real ingestion from job sources for real companies (721 open roles, 26 ATS companies + Getro + careers pages)
- [x] AI maps every role to function and seniority, and to a country where there is one (703 of 721)
- [x] Each company shows score, band, stage fit, coverage, reason line with dated links, real / dummy labels
- [x] An unreachable source keeps the last data, marked "not reached"
- [x] Weekly schedule and hosting (GitHub Actions + Cloudflare Worker), live at https://team-signals.team-signals.workers.dev
- [x] README: how to run, what's real vs dummy, how AI was used (`AI_LOG.md` is kept)
