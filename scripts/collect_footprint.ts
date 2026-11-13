// Step 5: footprint for every company, every run (BUILD_BRIEF §5):
//   1. sitemap.xml: URL history; new partner / country / industry pages become `new_page` events (indirect)
//   2. About + newsroom pages: AI extracts offices, published headcount, validation, plans (one call per changed page)
//   3. News in English AND Hebrew (Bing News RSS; Google News forbids bots in robots.txt): AI triage on headlines,
//      then the ORIGINAL article is read for signal-bearing items, and events are extracted with dates + evidence
// Usage: npx tsx scripts/collect_footprint.ts [--remote] [--only "Name"] [--max-articles N]
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import {
  aiErrorMessage, extractFootprint, triageNews, usage,
  type CompanyContext, type FootprintResult,
} from "../src/ai/claude.ts";
import type { Http } from "../src/collectors/ats.ts";
import { articleText, bingNews, type NewsItem } from "../src/collectors/news.ts";
import { collectSitemap, type SitePage } from "../src/collectors/sitemap.ts";
import { d1ExecFile, d1Query, sq } from "../src/lib/d1.ts";
import { politeFetch } from "../src/lib/fetch.ts";
import { closeBrowser, render } from "../src/lib/render.ts";
import { hasAnthropicKey, loadDevVars } from "./env.ts";

loadDevVars();
const args = process.argv.slice(2);
const remote = args.includes("--remote");
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : undefined;
const MAX_ARTICLES = args.includes("--max-articles") ? Number(args[args.indexOf("--max-articles") + 1]) : 6;
const runDate = new Date().toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(a) - Date.parse(b)) / 86400000);
const h = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

// Names that are ordinary words get "Israel" added to the English news query (brief: name + Israel/domain).
const COMMON_WORD = /^(grain|mind|vega|faye|reco|wonderful|aligned|daylight|nimble|upwind|second nature|zenity|orca ai|qodo)$/i;
const SIGNAL_VERDICTS = new Set(["layoff", "plan", "office", "round", "validation", "headcount"]);
const VERDICT_PRIORITY = ["layoff", "plan", "office", "round", "validation", "headcount"];

const http: Http = (url, o = {}) => politeFetch(url, { respectRobots: o.respectRobots ?? true, cacheTtlMs: 0 });

interface Company extends CompanyContext { id: number; careers_url: string | null }

interface Outcome { sql: string[]; sources: Record<string, string>; log: string[] }

function footprintSql(c: Company, type: string, value: string, eventDate: string | null, sourceUrl: string | null, evidence: "direct" | "indirect", dedupe: string): string {
  return `INSERT OR IGNORE INTO footprint (company_id, run_date, type, value, event_date, source_url, evidence, is_dummy, dedupe_key)
  VALUES (${c.id}, ${sq(runDate)}, ${sq(type)}, ${sq(value.slice(0, 300))}, ${sq(eventDate)}, ${sq(sourceUrl)}, ${sq(evidence)}, 0, ${sq(dedupe)});`;
}

const validDate = (d: string | null | undefined) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) && d <= runDate ? d : null);

/** Events from an AI footprint result -> SQL. Headcount updates the company row instead of footprint. */
function eventsSql(c: Company, res: FootprintResult, sourceUrl: string, fallbackDate: string | null): string[] {
  const out: string[] = [];
  if (!res.about_this_company) return out;
  for (const e of res.events) {
    // The publication date stands in only for the article's main news, never for background facts.
    const date = validDate(e.event_date) ?? (e.is_main_news ? fallbackDate : null);
    if (e.type === "headcount") {
      if (e.headcount && e.headcount > 0 && e.headcount < 100000) {
        out.push(`UPDATE companies SET headcount = ${Math.round(e.headcount)}, headcount_source = ${sq(`${sourceUrl}${date ? ` (${date})` : ""}`)} WHERE id = ${c.id};`);
      }
      continue;
    }
    const value = e.type === "round" && validDate(e.round_closed_date) ? `${e.value} (closed ${e.round_closed_date})` : e.value;
    // One row per event. A round is identified by its amount ("$113M"), since outlets date it a few days apart;
    // other events by type + country + month, or by their text when undated.
    const amount = e.type === "round" ? e.value.match(/\$\s?(\d+(?:\.\d+)?)\s?(m|million|b|billion)/i) : null;
    const topic = e.topic.toLowerCase().replace(/[^a-z0-9$ ]+/g, " ").replace(/\s+/g, " ").trim();
    const dedupe = amount ? `evt:round:${amount[1]}${amount[2][0].toLowerCase()}` : `evt:${e.type}:${topic || h(e.value.toLowerCase())}`;
    out.push(footprintSql(c, e.type, value, date, sourceUrl, e.evidence, dedupe));
  }
  return out;
}

async function pageText(url: string): Promise<{ ok: boolean; url: string; text: string }> {
  const r = await politeFetch(url, { respectRobots: true, cacheTtlMs: 0 });
  if (r.status === -1) return { ok: false, url, text: "" };
  let text = r.ok ? articleText(r.body) : "";
  if (text.length < 500) {
    const rr = await render(url, 2000);
    if (rr.ok) text = rr.text.split(/\n+/).map((l) => l.trim()).filter((l) => l.length > 2 && l.length < 400).join("\n").slice(0, 15000);
  }
  return { ok: text.length > 200, url: r.ok ? r.url : url, text };
}

// ------------------------------------------------------------------------------------------------ per company
async function footprint(c: Company, known: { pages: Set<string>; news: Set<string>; extractions: Map<string, string> }): Promise<Outcome> {
  const o: Outcome = { sql: [], sources: {}, log: [] };

  // 1. Sitemap
  const sm = await collectSitemap(http, c.domain);
  o.sources.sitemap = sm.status;
  let aboutUrl: string | null = null;
  let newsroomUrl: string | null = null;
  if (sm.status !== "failed") {
    const firstRun = known.pages.size === 0;
    // A lastmod shared by a big part of the sitemap is a site rebuild, not the date pages were added.
    const lastmodCount = new Map<string, number>();
    for (const p of sm.pages) if (p.lastmod) lastmodCount.set(p.lastmod, (lastmodCount.get(p.lastmod) ?? 0) + 1);
    const rebuildDates = new Set([...lastmodCount].filter(([, n]) => n >= 25 || n >= sm.pages.length * 0.2).map(([d]) => d));
    const rows: string[] = [];
    let events = 0;
    for (const p of sm.pages) {
      rows.push(`(${c.id}, ${sq(p.url)}, ${sq(p.kind)}, ${sq(p.lastmod)}, ${sq(runDate)}, ${sq(runDate)})`);
      if (!["partner", "country", "industry"].includes(p.kind)) continue;
      const isNew = !firstRun && !known.pages.has(p.url);
      // Baseline run: no history to diff, so only pages whose lastmod is within 90 days count, dated by lastmod.
      const recentOnBaseline = firstRun && p.lastmod && !rebuildDates.has(p.lastmod) && daysBetween(runDate, p.lastmod) <= 90;
      if (!isNew && !recentOnBaseline) continue;
      const path = new URL(p.url).pathname;
      const when = isNew ? (p.lastmod && daysBetween(runDate, p.lastmod) <= 30 ? p.lastmod : runDate) : p.lastmod;
      o.sql.push(footprintSql(c, "new_page", `${p.kind} page ${path}${isNew ? "" : ` (sitemap lastmod ${p.lastmod})`}`, when, p.url, "indirect", `page:${p.url}`));
      events++;
    }
    for (let i = 0; i < rows.length; i += 200) {
      o.sql.push(`INSERT INTO site_pages (company_id, url, kind, lastmod, first_seen, last_seen) VALUES ${rows.slice(i, i + 200).join(",\n  ")}
  ON CONFLICT(company_id, url) DO UPDATE SET kind = excluded.kind, lastmod = excluded.lastmod, last_seen = excluded.last_seen;`);
    }
    o.log.push(`sitemap ${sm.pages.length} urls${firstRun ? " (baseline)" : ""}, ${events} page events`);
    const pick = (re: RegExp) => sm.pages.filter((p: SitePage) => re.test(new URL(p.url).pathname)).sort((a, b) => a.url.length - b.url.length)[0]?.url ?? null;
    aboutUrl = pick(/^\/(about(-us)?|company)\/?$/i) ?? pick(/^\/(about(-us)?|company)\//i);
    newsroomUrl = pick(/^\/(newsroom|press|news|press-releases|media)\/?$/i);
  } else {
    o.log.push(`sitemap failed (${sm.error})`);
  }

  if (!hasAnthropicKey()) { o.log.push("no API key: About/news skipped"); return o; }

  // 2. About + newsroom pages (one AI call per changed page)
  aboutUrl ??= `https://${c.domain}/about`;
  for (const [kind, url] of [["about page", aboutUrl], ["newsroom page", newsroomUrl]] as const) {
    if (!url) continue;
    const key = kind === "about page" ? "about" : "newsroom";
    try {
      const p = await pageText(url);
      if (!p.ok) { o.sources[key] = "empty"; continue; }
      const hash = h(p.text);
      if (known.extractions.get(url) === hash) { o.sources[key] = "ok"; o.log.push(`${key} unchanged`); continue; }
      const res = await extractFootprint(c, kind, p.url, p.text, runDate);
      o.sql.push(...eventsSql(c, res, p.url, null));
      o.sql.push(`INSERT INTO page_extractions (url, company_id, content_hash, extracted_json, model) VALUES (${sq(url)}, ${c.id}, ${sq(hash)}, ${sq(JSON.stringify(res))}, 'claude-haiku-5-5')
  ON CONFLICT(url) DO UPDATE SET content_hash = excluded.content_hash, extracted_json = excluded.extracted_json, extracted_at = datetime('now');`);
      o.sources[key] = "ok";
      o.log.push(`${key} ${res.about_this_company ? res.events.length : 0} events`);
    } catch (e) {
      o.sources[key] = "failed";
      o.log.push(`${key} failed: ${aiErrorMessage(e)}`);
    }
  }

  // 3. News, English + Hebrew
  const queries: [string, "en" | "he"][] = [
    [COMMON_WORD.test(c.name) ? `"${c.name}" Israel` : `"${c.name}"`, "en"],
    [`"${c.name}"`, "he"],
  ];
  // The press often drops the suffix ("AI21", not "AI21 Labs"): also search the short name, with Israel to disambiguate.
  const stem = c.name.replace(/\s+(labs|security|ai|inc\.?)$/i, "").trim();
  const short = stem.length >= 4 ? stem : c.name;
  if (stem !== c.name && stem.length >= 4) queries.push([`"${stem}" Israel`, "en"]);
  // Bing ranks by relevance and returns ~10 items, so big older stories crowd out signals. Short targeted
  // queries for the signals that matter most (long OR-queries return almost nothing on Bing).
  queries.push([`"${short}" layoffs`, "en"], [`"${short}" hiring`, "en"], [`"${short}" פיטורים`, "he"]);
  const fresh = new Map<string, NewsItem>();
  let newsOk = false;
  for (const [q, lang] of queries) {
    let r = await bingNews(http, q, lang);
    if (!r.ok) { await new Promise((res) => setTimeout(res, 5000)); r = await bingNews(http, q, lang); }
    if (!r.ok) { o.log.push(`news ${lang} failed (${r.error})`); continue; }
    newsOk = true;
    for (const it of r.items) {
      if (known.news.has(it.url) || fresh.has(it.url)) continue;
      if (it.published && daysBetween(runDate, it.published) > 365) continue; // older than 12 months: never scored
      fresh.set(it.url, it);
    }
  }
  o.sources.news = newsOk ? (fresh.size ? "ok" : "empty") : "failed";
  if (!fresh.size) { o.log.push("news: nothing new"); return o; }

  // Newest first, so the most recent signals are triaged when there are many items.
  const list = [...fresh.values()].sort((x, y) => (y.published ?? "").localeCompare(x.published ?? "")).slice(0, 60);
  const ids = new Map(list.map((it, i) => [`n${i}`, it]));
  let verdicts: { id: string; verdict: string }[] = [];
  try {
    verdicts = await triageNews(c, [...ids.entries()].map(([id, it]) => ({ id, title: it.title, source: it.source, snippet: it.snippet, published: it.published })));
  } catch (e) {
    o.log.push(`news triage failed: ${aiErrorMessage(e)} (items left for next run)`);
    return o;
  }
  const verdictOf = new Map(verdicts.map((v) => [v.id, v.verdict]));
  const toRead = [...ids.entries()]
    .filter(([id]) => SIGNAL_VERDICTS.has(verdictOf.get(id) ?? ""))
    .sort((a, b) => VERDICT_PRIORITY.indexOf(verdictOf.get(a[0])!) - VERDICT_PRIORITY.indexOf(verdictOf.get(b[0])!) || (b[1].published ?? "").localeCompare(a[1].published ?? ""))
    .slice(0, MAX_ARTICLES);
  const readStatus = new Map<string, string>();
  let events = 0;
  for (const [id, it] of toRead) {
    try {
      const p = await pageText(it.url);
      // Article blocked/paywalled: fall back to the headline + snippet (still the publisher's words).
      const text = p.ok ? p.text : `${it.title}\n${it.snippet}`;
      readStatus.set(id, p.ok ? "read" : "headline_only");
      const res = await extractFootprint(c, "news article", it.url, text, runDate, it.published);
      const sql = eventsSql(c, res, it.url, it.published);
      events += sql.filter((s) => s.startsWith("INSERT OR IGNORE INTO footprint")).length;
      o.sql.push(...sql);
    } catch (e) {
      readStatus.set(id, "skipped");
      o.log.push(`article failed (retried next run): ${aiErrorMessage(e)}`);
    }
  }
  for (const [id, it] of ids) {
    // An article whose read/extraction failed is NOT recorded as seen, so the next run retries it.
    if (readStatus.get(id) === "skipped") continue;
    o.sql.push(`INSERT OR IGNORE INTO news_items (company_id, url, title, source, lang, published, verdict, read_status) VALUES (${c.id}, ${sq(it.url)}, ${sq(it.title)}, ${sq(it.source)}, ${sq(it.lang)}, ${sq(it.published)}, ${sq(verdictOf.get(id) ?? null)}, ${sq(readStatus.get(id) ?? (SIGNAL_VERDICTS.has(verdictOf.get(id) ?? "") ? "skipped" : null))});`);
  }
  const relevant = verdicts.filter((v) => v.verdict !== "not_this_company").length;
  o.log.push(`news ${list.length} new (${relevant} about this company), read ${toRead.length}, ${events} events`);
  return o;
}

// ------------------------------------------------------------------------------------------------ main
async function main() {
  const companies = d1Query<Company>(
    `SELECT id, name, domain, category, sector, hq, careers_url FROM companies ORDER BY list_no`, remote,
  ).filter((c) => !only || c.name.toLowerCase() === only.toLowerCase());
  if (!companies.length) throw new Error(only ? `no company named ${only}` : "no companies: run npm run db:load first");

  const pagesBy = new Map<number, Set<string>>();
  for (const r of d1Query<{ company_id: number; url: string }>("SELECT company_id, url FROM site_pages", remote)) {
    if (!pagesBy.has(r.company_id)) pagesBy.set(r.company_id, new Set());
    pagesBy.get(r.company_id)!.add(r.url);
  }
  const newsBy = new Map<number, Set<string>>();
  for (const r of d1Query<{ company_id: number; url: string }>("SELECT company_id, url FROM news_items", remote)) {
    if (!newsBy.has(r.company_id)) newsBy.set(r.company_id, new Set());
    newsBy.get(r.company_id)!.add(r.url);
  }
  const extractions = new Map(d1Query<{ url: string; content_hash: string }>("SELECT url, content_hash FROM page_extractions", remote).map((r) => [r.url, r.content_hash]));

  const results = new Map<number, Outcome>();
  let next = 0;
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (next < companies.length) {
      const c = companies[next++];
      let o: Outcome;
      try {
        o = await footprint(c, { pages: pagesBy.get(c.id) ?? new Set(), news: newsBy.get(c.id) ?? new Set(), extractions });
      } catch (e) {
        o = { sql: [], sources: { sitemap: "failed", news: "failed" }, log: [`failed: ${(e as Error).message}`] };
      }
      results.set(c.id, o);
      console.log(`${c.name.padEnd(18)} ${o.log.join(" · ")}`);
    }
  }));
  await closeBrowser();

  const sql = [`-- footprint ${runDate} (generated by scripts/collect_footprint.ts)`];
  for (const c of companies) {
    const o = results.get(c.id)!;
    sql.push(...o.sql);
    sql.push(`INSERT INTO snapshots (company_id, run_date, sources_checked, coverage, open_jobs, is_dummy) VALUES (${c.id}, ${sq(runDate)}, ${sq(JSON.stringify(o.sources))}, 'low', NULL, 0)
  ON CONFLICT(company_id, run_date, is_dummy) DO UPDATE SET sources_checked = json_patch(COALESCE(snapshots.sources_checked, '{}'), excluded.sources_checked);`);
  }
  await mkdir("data/runs", { recursive: true });
  const path = `data/runs/footprint-${runDate}.sql`;
  await writeFile(path, sql.join("\n") + "\n");
  d1ExecFile(path, remote);
  console.log(`\n${companies.length} companies · AI calls ${usage.calls} (${usage.input} in / ${usage.output} out tokens) · wrote ${path}`);
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
