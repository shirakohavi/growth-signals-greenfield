# Growth Signals

**Greenfield Partners · Data & AI Specialist case study · Option B: team composition as a growth signal**

Growth Signals tracks 41 Israeli and Israel-related tech companies, turns dated changes in how they build their teams (new go-to-market roles abroad, senior sales hires, R&D build-ups, partner programs, expansion plans, layoffs) into scored signals, and shows Greenfield's investment team a ranked list. Every score comes with a reason line and dated source links.

**User:** a Greenfield partner or associate. **Decision:** which companies to reach out to this week, before their next round is public.

## See it in 1 minute

The latest run's output is committed, so the dashboard works without running the pipeline.

```
npm install
npm run serve
```

Open **http://localhost:4180**.

- **Rising:** the top 10 by score, with *Reach out now* (60+ and In Range) and *Warm* (40–59) tiers.
- **All companies:** list, Stage Fit board, chart and map, with search and filters.
- **What's new:** dated changes from the last 7–90 days.
- Click any company for its full page: score over time, every signal with points and source, team breakdown, and an outreach panel (owner, status, comments).

## Run the pipeline

Needs Node 22+ and an Anthropic API key (Claude Haiku is used for extraction, classification and reason lines).

```
npm install
npx playwright install chromium          # renders JS careers pages and Getro boards
echo 'ANTHROPIC_API_KEY=sk-ant-…' > .dev.vars
npm run db:migrate                       # local D1 (SQLite) schema
npm run db:load                          # the 41 companies, verified domains, job sources, stage fit
npm run pipeline                         # collect → enrich → compare → score → dashboard
npm run serve                            # open http://localhost:4180
```

`npm run pipeline` runs every step in order and stops at the first one that fails. Sources that fail inside a step keep their last data and are marked "not reached". A full run takes about 20–40 minutes, because sites are fetched politely (3 s between requests to one host). It makes a few hundred Haiku calls, well under $1.

You can also start a run from the dashboard's **Run now** button when it's served by `npm run serve`. It shows live step progress and the log, then reloads the dashboard. Add `?dryrun` to the URL to try the button without collecting anything.

Each step can be run on its own: `collect:ats`, `collect:pages`, `enrich`, `collect:footprint`, `compare`, `seed:dummy`, `score`, `build:dashboard`. `npm test` runs 38 rule tests and `npm run typecheck` runs the type checks.

## Real vs dummy

| Real (12 Nov 2026 run) | Dummy or mock, labelled where shown |
|---|---|
| Company list and funding facts | Past snapshots before the first run: 3 per company (−90/−60/−30 days), drawn dashed and hollow |
| 721 open roles from job boards, Getro boards and careers pages, with posting dates | Score history and ▲▼ changes before a second real run (based on those dummy snapshots) |
| Every role classified by function, seniority and country (Claude Haiku) | The five outreach teammates (fictional), and owners, statuses and comments (saved in your browser only) |
| Sitemaps, About and newsroom pages, news in English and Hebrew | Companies added with + Add company (saved in your browser, scored on the next run) |
| Scores, bands and reason lines | Logos are fetched live from Google's favicon service |

## How it works

```
companies.csv ──► collectors ──────────────► AI enrichment ─────────► compare ──► score ──► dashboard
                  Greenhouse, Lever, Ashby,   Claude Haiku: extract      new / closed   13 signals,    ranking.json
                  Comeet, Getro, careers      roles, classify function,  / reposted     points × age   + index.html
                  pages, sitemaps, About,     seniority, country; read   roles,         × evidence
                  Bing News (EN + HE)         news into dated events     baseline
```

- **The score is plain arithmetic**, not AI: `max(0, min(100, Σ points × age × evidence))`. AI only extracts and classifies, and writes the reason line from the scored signals.
- **Stage fit** (In Range, Approaching B, Too Early, Past Stage) comes from the round and its date, based on where Greenfield's own portfolio entered. It sets the reach-out tiers, not the score.
- **Sources are used politely:** robots.txt respected (which is why news comes from Bing, not Google), a clear User-Agent, conditional requests, no LinkedIn scraping, and roles and counts only, never people's names.

The full spec (sources, signals, weights, rules and test cases) is in **[BUILD_BRIEF.md](BUILD_BRIEF.md)**.

## How AI was used

**[AI_LOG.md](AI_LOG.md)** records it step by step: what I decided, what Claude Code built, the mistakes the AI made and who caught them, and what the API calls cost (about $0.40 in total).

## What's not in v1

- No weekly cron and no Cloudflare Pages deploy: it runs locally.
- No LinkedIn data.
- No alerts.
- No auto-discovery of new companies.

Known limits and open questions are in BUILD_BRIEF.md §15–16.

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
| `worker/` | Cloudflare Worker: read-only API over D1 |
| `public/` | Built dashboard and `ranking.json` from the latest run |
