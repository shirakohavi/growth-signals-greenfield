# Growth Signals

**Greenfield Partners · Data & AI Specialist case study · Option B: team composition as a growth signal**

Growth Signals tracks 40 Israeli and Israel-related tech companies, turns dated changes in how they build their teams (new go-to-market roles abroad, senior sales hires, R&D build-ups, partner programs, expansion plans, layoffs) into scored signals, and shows Greenfield's investment team a ranked list. Every score comes with a reason line and dated source links.

**User:** a Greenfield partner or associate. **Decision:** which companies to reach out to this week, before their next round is public.

**The idea:** teams move before rounds do. New sales roles abroad or a growing R&D team show up months before the funding news.

**Worth a call = right stage + right moment.**
- **Right stage:** *In Range*, meaning Series B or C, or Series A in deep tech. This is a gate, not points.
- **Right moment:** a score of 60 or more, meaning the team is gearing up to sell (new markets, go-to-market hires abroad).
- **Both together = Reach out now.** Today that's Daylight, Zenity, Unframe and Upwind.

| Score | Reads as |
|---|---|
| 0–39 | Not yet |
| 40–59 | Warm |
| 60–100 | Reach out now (if In Range) |

## How to run it

1. **Open the live dashboard:** **https://team-signals.team-signals.workers.dev**
2. **Press Run now** (top right) and enter the team passcode (shared separately). The run happens in the cloud and takes about 30–40 minutes. The dashboard shows live progress ("Step 3 of 8") and updates itself when it's done; you can close the page meanwhile.
3. **Or do nothing:** it runs by itself every Monday morning.

<details>
<summary><b>For developers: run it on your own machine</b></summary>

<br>

**Just view it.** The latest run's output is committed, so no pipeline run is needed:

```
npm install
npm run serve                       # open http://localhost:4180
```

**Run the whole pipeline.** Needs Node 22+ and your own Anthropic API key (Claude Haiku does extraction, classification and reason lines):

```
npm install
npx playwright install chromium     # browser for JS careers pages
echo 'ANTHROPIC_API_KEY=sk-ant-…' > .dev.vars
npm run db:migrate                  # local database schema
npm run db:load                     # the 40 companies
npm run pipeline                    # collect → AI → compare → score → dashboard
npm run serve                       # open http://localhost:4180
```

- `npm run pipeline` runs every step in order and stops at the first one that fails. Sources that fail inside a step keep their last data and are marked "not reached".
- A full run takes about 20–40 minutes, because sites are fetched politely (3 s between requests to one site), and makes a few hundred Haiku calls, well under $1.
- Locally, the dashboard's **Run now** button runs the pipeline on your machine; add `?dryrun` to the URL to try it without collecting anything.
- Each step also runs on its own: `collect:ats`, `collect:pages`, `enrich`, `collect:footprint`, `compare`, `seed:dummy`, `score`, `build:dashboard`. `npm test` runs 53 rule tests; `npm run typecheck` checks types.

</details>

## Using the dashboard

Three tabs across the top: **Rising**, **All companies** and **What's new**. Every column header, filter and score has a tooltip (hover or tab to it), and **Guide** (top right) explains every term in one place.

**How to read a row**
- **Reach out now** companies (score 60+ and In Range) have a tinted row with a blue bar on the left and a **filled** score circle. **Warm** companies (40–59) have an **outlined** circle. The two dots under the page title are the legend.
- **Chips:** Type (sector, each with its own color), Round (latest round and month) and Stage Fit (green = In Range, amber = Approaching B, grey = Too Early or Past Stage).
- **▲▼** is the score change since the last run; **Team** is the mix of open roles by function (R&D, Sales, Marketing, Customer success, Partnerships).
- **Owner** shows the initials of the teammate who owns the outreach (empty when unassigned).

**Rising** — the top 10 **In Range** companies by score (Series B or C, or Series A in deep tech; off-thesis companies left out). Too Early, Approaching B and Past Stage companies are still ranked in **All companies**. Search, sort (score, change, open roles, name) and **Filters**: Reach out, Type, Band, Decline, Owner and Outreach status. Active filters show as chips you can clear.

**All companies** — all 40 companies, in three views:
- **List:** the same table with every company, plus Coverage and Hiring-in-country filters.
- **Stage Fit board:** one column per stage (In Range, Approaching B, Too Early, Past Stage), so you can see who is at the right stage at a glance.
- **Map:** a heatmap of open roles by country, to spot who is building teams abroad.

**What's new** — dated changes from the last 7, 14, 30 or 90 days, grouped by day. **Highlights** shows new markets (a country where a company posts its first sales role), funding, plans, new offices and risks first; **Roles**, **News**, **Site** and **Risks** narrow it down. Many new roles at one company collapse into one line you can expand. Every item links to its source.

**Company page** (click any company)
- The score with its one-line reason, links (website, careers, jobs, and "Check on LinkedIn" when coverage is low) and **score over time**.
- **Changes:** every dated change with its source. **Why:** the scoring signals with points and sources. **Team:** open roles vs company size, roles by team and country, open roles over time and the full role list.
- **Outreach panel** (right side of the page), so the team can track who is talking to whom:
  - **Owner:** pick the teammate who owns the relationship. Their initials then show in the Owner column.
  - **Status:** Not contacted → Reached out → In conversation → Meeting set, or Passed. The panel shows when the status last changed, a small colored dot appears next to the company's name in every list, and Rising and All companies can be filtered by Owner and by Outreach status.
  - **Comments:** add a note (who you spoke to, what's next), choose who it's from with "As", and it's saved with the date. Comments show newest first and can be deleted.
  - The five teammates are fictional, for the demo.

**Compare** — tick the box at the start of up to three rows (or **+ Compare** on a company page), then press **Compare** in the tray at the bottom. Companies sit side by side: score, headline, hiring vs size, go-to-market share, team, countries, score over time, open roles over time (on one shared scale) and top signals.

**+ Add company** — add a company by name and website. It appears as **Pending** in All companies and is scored on the next run; **Copy CSV rows** gives the lines to paste into `data/companies.csv`.

**Run now** — starts a full run in the cloud with the team passcode (see above). Progress shows live, and the dashboard refreshes itself when it's done.

Owners, statuses, comments and added companies are saved in your browser only (see Known limits).

## How it's hosted (Cloudflare + GitHub Actions)

Already set up and running; nobody needs the code or a key to use it:
- **The dashboard** is served by the Cloudflare Worker in `worker/`.
- **It runs every Monday early morning** (03:17 UTC: 05:17 Israel time in winter, 06:17 in summer). The timer is a Cloudflare Cron Trigger on the Worker, which starts the GitHub Actions workflow (`.github/workflows/weekly-run.yml`). GitHub's own schedule is best effort and skipped the first Monday, so it isn't used. **Safety check:** at 06:17 UTC the Worker checks again and starts the run if nothing succeeded that day. Every decision is logged in the Worker's logs (Cloudflare → Workers → team-signals → Logs).
- **Anyone can press Run now.** They type the team passcode (shared separately) once, and the dashboard shows "Step 3 of 8" live, then updates itself.
- **The Anthropic key stays a GitHub secret.** Nobody using the dashboard can see it, and runs are billed to the key's owner (about $0.40 each).
- **History builds up.** The database lives in Cloudflare D1, so every run compares with the last real one.

**To set it up again in another Cloudflare account (about 15 minutes):**

1. Log in to Cloudflare: `npx wrangler login`
2. Create the cloud database: `npx wrangler d1 create team-signals`, then paste the printed `database_id` into `wrangler.jsonc` (in `d1_databases`).
3. Copy the current data up:
   `npx wrangler d1 export team-signals --local --output /tmp/growth-signals.sql`
   `npx wrangler d1 execute team-signals --remote --file /tmp/growth-signals.sql`
4. Create a GitHub token for Run now: github.com → Settings → Developer settings → Fine-grained tokens. Give it access to **this repo only**, with permissions **Actions: Read and write**.
5. Give the Worker its two secrets (each command asks you to paste the value):
   `npx wrangler secret put GITHUB_TOKEN`
   `npx wrangler secret put RUN_PASSCODE` (pick a passcode to share with the team)
6. Deploy: `npx wrangler deploy`. It prints the dashboard's address (`https://team-signals.<your-subdomain>.workers.dev`).
7. Give GitHub Actions its three secrets (each command asks for the value):
   `gh secret set ANTHROPIC_API_KEY`
   `gh secret set CLOUDFLARE_API_TOKEN` (Cloudflare → My Profile → API Tokens → "Edit Cloudflare Workers" template, plus **D1: Edit**)
   `gh secret set CLOUDFLARE_ACCOUNT_ID` (shown on the Cloudflare dashboard's home page)
8. Test: open the dashboard, press **Run now**, enter the passcode. Or on GitHub: Actions → Weekly run → **Run workflow**.

Optional: put the dashboard behind **Cloudflare Access** (Zero Trust → Access → add the Worker's address), so only people with a Greenfield email can open it.

## Real vs dummy

| Real (runs of 12 and 14 Nov 2026) | Dummy or mock, labelled where shown |
|---|---|
| Company list and funding facts | Past snapshots before the first run: 3 per company (−90/−60/−30 days), drawn dashed and hollow |
| 717 open roles (14 Nov) from job boards, Getro boards and careers pages, with posting dates | Score history before the first real run (12 Nov), based on those dummy snapshots |
| Every role classified by function, seniority and country (Claude Haiku) | The five outreach teammates (fictional), and owners, statuses and comments (saved in your browser only) |
| Sitemaps, About and newsroom pages, news in English and Hebrew | Companies added with + Add company (saved in your browser, scored on the next run) |
| Scores, bands and reason lines | Logos are fetched live from Google's favicon service |

## Where team data lives

| Source | What it gives | Access | Coverage |
|---|---|---|---|
| Job boards (Greenhouse, Lever, Ashby, Comeet) | Every open role, with ids and posting dates | Free public APIs | 65% (26 of 40) |
| Getro investor boards, careers pages | Roles behind JavaScript | Opened in a browser, then read by AI | 25% |
| Sitemaps, About and newsroom pages | New partnership program, country and industry pages, office announcements and headcount references | Public pages, robots.txt respected | 98% |
| News, English and Hebrew | Rounds, plans, layoffs, validation | Bing News RSS (Google's robots.txt blocks bots) | 90% |

| What's missing | How the gap is filled |
|---|---|
| Actual hires (only postings) | Roles closed after 3–16 weeks, while the company keeps posting, count as likely filled |
| Posting dates on Comeet | First-seen dates |
| Up-to-date headcount | Headcount from news, shown as context only |
| History before the first run | Dummy history, always labelled |
| LinkedIn | A "Check on LinkedIn" link for low-coverage companies |

## How it works

Every week, from a list of companies to who to call:
1. **Collect:** open roles, website changes and news for each company.
2. **Read and tag (AI):** Claude Haiku pulls roles off careers pages, tags each by team, level and country, and turns news into dated events.
3. **Compare:** against last week: what's new, closed or reposted.
4. **Score:** growth signals become a 0–100 score, with plain arithmetic.
5. **Act:** a ranked Top 10 with sources. 60+ and at the right stage = Reach out now.

It runs on its own every Monday, or with one click (**Run now**). Latest run (14 Nov, the first in the cloud): 717 roles, 17 minutes, well under $1 of AI.

```
companies.csv ──► collectors ──────────────► AI enrichment ─────────► compare ──► score ──► dashboard
                  Greenhouse, Lever, Ashby,   Claude Haiku: extract      new / closed   13 signals,    ranking.json
                  Comeet, Getro, careers      roles, classify function,  / reposted     points ×      + index.html
                  pages, sitemaps, About,     seniority, country; read   roles,         recency ×
                  Bing News (EN + HE)         news into dated events     baseline       confidence
```

- **The score is plain arithmetic**, not AI: `Score = Σ (signal points × recency × confidence)`, kept between 0 and 100. AI only extracts and classifies, and writes the reason line from the scored signals.

| Signal points: how important | | Recency: how recent | | Confidence: how reliable | |
|---|---|---|---|---|---|
| New market abroad | +25 | Last 30 days, or the job post is still open | 100% | Job post or news | 100% |
| GTM team build-out | +20 | 1–3 months | 50% | Website hint only | 60% |
| Senior GTM hire | +20 | Older | 0% | | |
| Hiring speeding up | +15 | Plans and layoffs count for up to a year | | | |
| Expansion plan, partner program, Series B window, mix shifting to GTM | +10 | | | | |
| New industry pages, market validation, R&D build-up | +5 | | | | |
| Layoffs | −25 | | | | |
| Hiring paused | −15 | | | | |

- **One hiring wave counts once.** A wave shows up several ways (GTM build-out, faster hiring, GTM mix, R&D build-up). The strongest sign counts in full and each related sign counts half, so it isn't counted twice.
- **Company size is context, not points.** Open roles ÷ employees is shown on the company page, but headcount is missing or old for half the companies, so it's kept out of the score.
- **Why trust it:** every point links to its source and date; each score has a one-line reason; missing and dummy data are always shown; sample companies scored by hand all landed within ±10 of the pipeline.
- **Stage fit** (In Range, Approaching B, Too Early, Past Stage) comes from the round and its date, based on where Greenfield's own portfolio entered. It sets the reach-out tiers, not the score.
- **Sources are used politely:** robots.txt respected (which is why news comes from Bing, not Google), a clear User-Agent, conditional requests, no LinkedIn scraping, and roles and counts only, never people's names.

The full spec (sources, signals, weights, rules and test cases) is in **[BUILD_BRIEF.md](BUILD_BRIEF.md)**.

## How AI was used

**[AI_LOG.md](AI_LOG.md)** records it step by step: what I decided, what Claude Code built, the mistakes the AI made and who caught them, and what the API calls cost (about $0.40 in total).

## What's not in v1 (cut on purpose)

- **LinkedIn:** terms of use (job postings live elsewhere anyway).
- **CRM sync and alerts:** outreach notes stay in the browser.
- **Auto-discovery** of new companies.
- **Founder signals and paid data.**
- **Parallel fetching:** not needed at 40 companies.

## With four more weeks

- **Back-test:** let the weekly runs build real history, then check whether high scores came before real rounds, and tune the weights on that.
- **AI copilot:** a chatbot to ask the data questions ("who's hiring sales in Germany?"), and a "prep me for the call" brief per company, built from its signals and sources.
- **Outreach:** a LinkedIn message or email drafted from what each company is actually doing, moving to automatic reach-out once the drafts prove good.
- **Manage the list:** discover new companies from funding news, remove ones that no longer fit, and sync owners, statuses and notes to the CRM.
- **Stage-change alerts:** when the news reports a newer, completed round than the list has (say a Series C after a Series B), flag it on the company page and in What's new for a person to confirm.

v1 is a modular base: the Growth Signals database (companies, roles, signals and scores, kept week after week) sits in the middle, and sourcing and CRM sync plug into it without a rebuild.

## Known limits

**Data**
- **Short history.** Two real runs so far (12 and 14 Nov). Signals that compare runs have started to work (Upwind's first Japan sales role showed up as a new market), but trends like "hiring paused" need a few more weeks, and history before 12 Nov is dummy (labelled wherever it's shown).
- **Postings, not hires.** A posted role isn't a person hired. "Likely filled" is an inference from how and when roles close.
- **Uneven coverage.** 26 companies have clean job-board data; the rest rely on rendered careers pages, investor boards, websites and news. Low-coverage companies are flagged, with a "Check on LinkedIn" link.
- **Company size is often old.** Headcount comes from news for about half the companies, so it's shown as context and kept out of the score.
- **Stage comes from the researched company list.** Each run recalculates the time-based part (a Series A turning 12 months old moves to Approaching B), but a new round reported in the news doesn't change the stage: news can be a rumor or a raise still in progress (Wonderful "seeking to raise $500M, not closed"), so a person confirms the round and updates the list.
- **Name collisions.** Common names (four different "Grain"s) are matched by domain and HQ, never the name alone, but a wrong match is still possible.
- **AI can misread.** Role classification and page extraction were spot-checked (and fixed where wrong), not checked one by one.

**Product**
- **Past Stage companies are ranked**, by choice, so their activity stays visible, even though they're outside Greenfield's stage.
- **Outreach notes are per browser.** Owners, statuses and comments aren't shared between teammates yet.
- **Open site, protected runs.** Anyone with the dashboard link can view it; only people with the team passcode can start a run.

**Scale:** fine at about 100 companies; 400+ needs parallel runs.

**At 10× the companies**
- Polite fetching (3 s between requests to one site) turns a 30-minute run into hours.
- Careers pages that change their layout break silently, and the job-source survey is still half manual.
- Bing News returns about 10 results per query, so busy companies' news gets cut.

## Repo map

| Path | What's there |
|---|---|
| `src/collectors/` | Job boards (ATS), careers pages and Getro, sitemaps, news |
| `src/ai/claude.ts` | All Claude Haiku calls (structured outputs) |
| `src/scoring/signals.ts` | The 13 signals and the scoring arithmetic |
| `src/lib/` | Fetching, storage, compare/dedupe, stage fit, helpers |
| `src/dashboard/index.html` | Dashboard source (built to `public/index.html`) |
| `scripts/` | One script per pipeline step, `pipeline.ts`, `serve.ts`, tests |
| `migrations/` | D1 schema |
| `data/` | Company list, verified domains, job-source survey, and SQL from each run (`data/runs/`) |
| `worker/` | Cloudflare Worker: serves the dashboard, a read-only API over D1, and Run now |
| `public/` | Built dashboard and `ranking.json` from the latest run |
| `.github/workflows/` | The weekly run (GitHub Actions) |
