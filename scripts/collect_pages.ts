// Step 4: collect jobs from investor Getro boards and companies' own careers pages, store them in D1 (§7 rules),
// and record "hiring, no listings" statements and "nothing found" coverage.
// AI (Claude Haiku) extracts roles from careers pages, one call per changed page (content hash).
// Usage: npx tsx scripts/collect_pages.ts [--remote] [--quick] [--only "Name"]
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { aiErrorMessage, extractJobsFromPage, MODEL, usage, type ExtractedPage } from "../src/ai/claude.ts";
import { collectGetro, renderCareersPage, scrapedJobId } from "../src/collectors/pages.ts";
import { safeLocation, toCountry } from "../src/lib/country.ts";
import { d1ExecFile, d1Query, sq } from "../src/lib/d1.ts";
import { closeBrowser } from "../src/lib/render.ts";
import { sqlForResult, type SourceResult, type StoredJob } from "../src/lib/store.ts";
import { hasAnthropicKey, loadDevVars } from "./env.ts";

loadDevVars();
const args = process.argv.slice(2);
const remote = args.includes("--remote");
const quick = args.includes("--quick");
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : undefined;
const RETRY_DELAYS_S = quick ? [5] : [60, 300, 1800];
const runDate = new Date().toISOString().slice(0, 10);

interface Company {
  id: number; name: string; job_source_type: string; job_source_url: string | null; careers_url: string | null; job_source_notes: string | null;
}
interface Outcome { result?: SourceResult; extraSql: string[]; log: string }

const cached = new Map(
  d1Query<{ url: string; content_hash: string; extracted_json: string }>("SELECT url, content_hash, extracted_json FROM page_extractions", remote)
    .map((r) => [r.url, r]),
);

async function careersPage(c: Company): Promise<Outcome> {
  const fail = (error: string): Outcome => ({ result: { source: "careers_page", status: "failed", jobs: [], error }, extraSql: [], log: error });
  if (!c.careers_url) return fail("no careers URL");
  const page = await renderCareersPage(c.careers_url);
  if (!page.ok) return fail(page.error ?? "render failed");

  let extracted: ExtractedPage;
  let how: string;
  const prev = cached.get(c.careers_url);
  const extraSql: string[] = [];
  if (prev && prev.content_hash === page.contentHash) {
    extracted = JSON.parse(prev.extracted_json) as ExtractedPage;
    how = "page unchanged, reused last extraction";
  } else {
    if (!hasAnthropicKey()) return fail("ANTHROPIC_API_KEY not set (add it to .dev.vars)");
    try {
      extracted = await extractJobsFromPage(c.name, page.url, page.text, runDate, page.links);
    } catch (e) {
      return fail(`AI extraction failed: ${aiErrorMessage(e)}`);
    }
    how = "AI extraction";
    extraSql.push(`INSERT INTO page_extractions (url, company_id, content_hash, extracted_json, model) VALUES (${sq(c.careers_url)}, ${c.id}, ${sq(page.contentHash)}, ${sq(JSON.stringify(extracted))}, ${sq(MODEL)})
  ON CONFLICT(url) DO UPDATE SET content_hash = excluded.content_hash, extracted_json = excluded.extracted_json, model = excluded.model, extracted_at = datetime('now');`);
  }

  const byLid = new Map(page.links.map((l) => [l.lid, l]));
  const usedIds = new Set<string>();
  const jobs: StoredJob[] = extracted.jobs.map((j) => {
    const link = j.link_id ? byLid.get(j.link_id) : undefined;
    // Stable id: Comeet position id > hash of the role's own link > hash of title + location.
    let id = link?.comeetId ?? (link ? createHash("sha256").update(link.href).digest("hex").slice(0, 16) : scrapedJobId(j.title, j.location));
    if (usedIds.has(id)) id = scrapedJobId(j.title, j.location);
    usedIds.add(id);
    const iso = j.country && /^[A-Z]{2}$/.test(j.country) ? j.country : toCountry(j.location);
    return {
      source: "careers_page", source_job_id: id, title: j.title, location: safeLocation(j.location), country: iso,
      posted_date: j.posted_date && /^\d{4}-\d{2}-\d{2}$/.test(j.posted_date) ? j.posted_date : null,
      url: link?.href ?? page.url, function: j.function, seniority: j.seniority,
    };
  });
  const check = page.comeetIds && page.comeetIds !== jobs.length ? `; ${page.comeetIds} Comeet ids on page` : "";
  return {
    result: { source: "careers_page", status: jobs.length ? "ok" : "empty", jobs },
    extraSql,
    log: `${how}${extracted.no_openings_stated ? "; page says no open positions" : ""}${check}`,
  };
}

async function handle(c: Company): Promise<Outcome> {
  switch (c.job_source_type) {
    case "getro": {
      if (!c.job_source_url) return { result: { source: "getro", status: "failed", jobs: [], error: "no Getro URL" }, extraSql: [], log: "" };
      const r = await collectGetro(c.job_source_url, runDate);
      return { result: r, extraSql: [], log: r.error ?? `${r.jobs.filter((j) => j.posted_date).length}/${r.jobs.length} with posted dates` };
    }
    case "careers_page":
      return careersPage(c);
    case "hiring_statement": {
      // No listings: record the statement as a footprint signal (direct evidence: the company's own site).
      const value = (c.job_source_notes ?? "").split(" | ").find((n) => /says it is hiring|LinkedIn/i.test(n)) ?? "site says it is hiring";
      return {
        extraSql: [
          `DELETE FROM footprint WHERE company_id = ${c.id} AND run_date = ${sq(runDate)} AND type = 'hiring_statement' AND is_dummy = 0;`,
          `INSERT INTO footprint (company_id, run_date, type, value, event_date, source_url, evidence, is_dummy) VALUES (${c.id}, ${sq(runDate)}, 'hiring_statement', ${sq(value)}, NULL, ${sq(c.careers_url)}, 'direct', 0);`,
          `INSERT INTO snapshots (company_id, run_date, sources_checked, coverage, open_jobs, is_dummy) VALUES (${c.id}, ${sq(runDate)}, ${sq(JSON.stringify({ careers_page: "empty", hiring_statement: "ok" }))}, 'partial', NULL, 0)
  ON CONFLICT(company_id, run_date, is_dummy) DO UPDATE SET sources_checked = json_patch(COALESCE(snapshots.sources_checked, '{}'), excluded.sources_checked), coverage = excluded.coverage;`,
        ],
        log: "hiring statement recorded (no listings)",
      };
    }
    default: // none: checked, nothing found (shown separately from "not checked")
      return {
        extraSql: [`INSERT INTO snapshots (company_id, run_date, sources_checked, coverage, open_jobs, is_dummy) VALUES (${c.id}, ${sq(runDate)}, ${sq(JSON.stringify({ website: "empty", ats: "empty", getro: "empty" }))}, 'low', NULL, 0)
  ON CONFLICT(company_id, run_date, is_dummy) DO UPDATE SET sources_checked = json_patch(COALESCE(snapshots.sources_checked, '{}'), excluded.sources_checked), coverage = excluded.coverage;`],
        log: "no job source (aggregator fallback is a separate step)",
      };
  }
}

async function main() {
  const companies = d1Query<Company>(
    `SELECT id, name, job_source_type, job_source_url, careers_url, job_source_notes FROM companies
      WHERE job_source_type IN ('getro', 'careers_page', 'hiring_statement', 'none') ORDER BY list_no`, remote,
  ).filter((c) => !only || c.name.toLowerCase() === only.toLowerCase());
  if (!companies.length) throw new Error(only ? `no page-based company named ${only}` : "no companies: run npm run db:load first");
  if (!hasAnthropicKey()) console.log("note: ANTHROPIC_API_KEY not set: careers pages that changed will be marked failed (last data kept)\n");

  const outcomes = new Map<number, Outcome>();
  const runAll = async (list: Company[]) => {
    let next = 0;
    await Promise.all(Array.from({ length: 3 }, async () => {
      while (next < list.length) {
        const c = list[next++];
        let o: Outcome;
        try { o = await handle(c); } catch (e) { o = { result: { source: c.job_source_type as "careers_page", status: "failed", jobs: [], error: (e as Error).message }, extraSql: [], log: (e as Error).message }; }
        outcomes.set(c.id, o);
        console.log(`${c.name.padEnd(18)} ${c.job_source_type.padEnd(17)} ${(o.result?.status ?? "-").padEnd(7)} ${String(o.result?.jobs.length ?? "-").padStart(3)} jobs  ${o.log}`);
      }
    }));
  };
  await runAll(companies);
  for (const delay of RETRY_DELAYS_S) {
    // No point retrying a missing key.
    const retry = companies.filter((c) => outcomes.get(c.id)?.result?.status === "failed" && !/API_KEY/.test(outcomes.get(c.id)?.result?.error ?? ""));
    if (!retry.length) break;
    console.log(`\nretrying ${retry.length} in ${delay}s: ${retry.map((c) => c.name).join(", ")}`);
    await new Promise((res) => setTimeout(res, delay * 1000));
    await runAll(retry);
  }
  await closeBrowser();

  const sql = [`-- page collection ${runDate} (generated by scripts/collect_pages.ts)`];
  for (const c of companies) {
    const o = outcomes.get(c.id)!;
    sql.push(...o.extraSql);
    if (o.result) sql.push(...sqlForResult(c.id, o.result, runDate, true));
  }
  await mkdir("data/runs", { recursive: true });
  const path = `data/runs/pages-${runDate}.sql`;
  await writeFile(path, sql.join("\n") + "\n");
  d1ExecFile(path, remote);
  const jobs = [...outcomes.values()].reduce((a, o) => a + (o.result?.jobs.length ?? 0), 0);
  console.log(`\n${companies.length} companies · ${jobs} jobs · AI calls ${usage.calls} (${usage.input} in / ${usage.output} out tokens) · wrote ${path}`);
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
