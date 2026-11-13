// Step 3: collect jobs from Greenhouse / Lever / Ashby / Comeet for every company whose step-1 source is an ATS,
// and store them in D1 following BUILD_BRIEF §7:
//   - same job = same source_job_id (a renamed job is an edit, not a new role)
//   - first_seen is set once; last_seen/is_open refresh every run; jobs missing from a successful fetch close
//   - undated roles seen on a company's first real run are the baseline (never "new")
//   - a failed fetch is retried after 1 / 5 / 30 min (brief §5), then marked "not_reached" and the last data is kept
// Usage: npx tsx scripts/collect_ats.ts [--remote] [--quick] [--only "Name"]
//   --quick: retry after 5 s instead of 1/5/30 min (development)
import { mkdir, writeFile } from "node:fs/promises";
import { detectAts } from "../src/lib/ats.ts";
import { politeFetch } from "../src/lib/fetch.ts";
import { closeBrowser, render } from "../src/lib/render.ts";
import { d1ExecFile, d1Query } from "../src/lib/d1.ts";
import { sqlForResult } from "../src/lib/store.ts";
import {
  collectAshby, collectComeetApi, collectComeetPage, collectGreenhouse, collectLever,
  type CollectResult, type Http,
} from "../src/collectors/ats.ts";

const args = process.argv.slice(2);
const remote = args.includes("--remote");
const quick = args.includes("--quick");
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : undefined;
const RETRY_DELAYS_S = quick ? [5] : [60, 300, 1800];
const runDate = new Date().toISOString().slice(0, 10);

interface Company {
  id: number; name: string; domain: string; job_source_type: string; ats_slug: string | null; careers_url: string | null;
}

// Job APIs are documented public endpoints (robots.txt applies to websites, not these); always revalidate.
const http: Http = (url, opts = {}) =>
  politeFetch(url, {
    cacheTtlMs: 0,
    respectRobots: opts.respectRobots ?? false,
    init: opts.json ? { headers: { accept: "application/json" } } : {},
  });

/** Comeet token: public, embedded in the careers page. Re-read every run (raw HTML first, then rendered page + network calls). */
async function comeetToken(c: Company, uid: string): Promise<string | null> {
  if (!c.careers_url) return null;
  const pick = (text: string) => detectAts(text, c.careers_url!).find((h) => h.type === "comeet" && h.slug === uid && h.extra && h.extra.length > 8)?.extra ?? null;
  const raw = await politeFetch(c.careers_url, { respectRobots: true, cacheTtlMs: 0 });
  const fromRaw = raw.ok ? pick(raw.body) : null;
  if (fromRaw) return fromRaw;
  const r = await render(c.careers_url);
  return r.ok ? pick(r.html + "\n" + r.requests.join("\n")) : null;
}

async function collect(c: Company): Promise<CollectResult> {
  const slug = c.ats_slug ?? "";
  switch (c.job_source_type) {
    case "greenhouse": return collectGreenhouse(http, slug);
    case "lever": return collectLever(http, slug);
    case "ashby": return collectAshby(http, slug);
    case "comeet": {
      if (slug.includes("/")) return collectComeetPage(http, slug); // "grain/4A.000": public hosted page
      const token = await comeetToken(c, slug);
      if (!token) return { source: "comeet", status: "failed", jobs: [], endpoint: c.careers_url ?? "", error: "Comeet token not found on careers page" };
      return collectComeetApi(http, slug, token);
    }
    default: throw new Error(`not an ATS source: ${c.job_source_type}`);
  }
}

async function main() {
  const companies = d1Query<Company>(
    `SELECT id, name, domain, job_source_type, ats_slug, careers_url FROM companies
      WHERE job_source_type IN ('greenhouse', 'lever', 'ashby', 'comeet') ORDER BY list_no`, remote,
  ).filter((c) => !only || c.name.toLowerCase() === only.toLowerCase());
  if (!companies.length) throw new Error(only ? `no ATS company named ${only}` : "no ATS companies in D1: run npm run db:load first");

  const results = new Map<number, CollectResult>();
  const runAll = async (list: Company[]) => {
    let next = 0;
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (next < list.length) {
        const c = list[next++];
        let r: CollectResult;
        try { r = await collect(c); } catch (e) { r = { source: c.job_source_type as CollectResult["source"], status: "failed", jobs: [], endpoint: "", error: (e as Error).message }; }
        results.set(c.id, r);
        console.log(`${c.name.padEnd(18)} ${c.job_source_type.padEnd(11)} ${r.status.padEnd(7)} ${String(r.jobs.length).padStart(4)} jobs${r.error ? `  (${r.error})` : ""}`);
      }
    }));
  };

  await runAll(companies);
  for (const delay of RETRY_DELAYS_S) {
    const retry = companies.filter((c) => results.get(c.id)?.status === "failed");
    if (!retry.length) break;
    console.log(`\nretrying ${retry.length} failed source(s) in ${delay}s: ${retry.map((c) => c.name).join(", ")}`);
    await new Promise((res) => setTimeout(res, delay * 1000));
    await runAll(retry);
  }
  await closeBrowser();

  const sql = [`-- ATS collection ${runDate} (generated by scripts/collect_ats.ts)`];
  for (const c of companies) sql.push(...sqlForResult(c.id, results.get(c.id)!, runDate, true));
  await mkdir("data/runs", { recursive: true });
  const path = `data/runs/ats-${runDate}.sql`;
  await writeFile(path, sql.join("\n") + "\n");
  d1ExecFile(path, remote);

  const failed = companies.filter((c) => results.get(c.id)!.status === "failed");
  const total = [...results.values()].reduce((a, r) => a + r.jobs.length, 0);
  console.log(`\n${companies.length} companies · ${total} open jobs · ${failed.length} not reached${failed.length ? ` (${failed.map((c) => c.name).join(", ")}; last data kept)` : ""} · wrote ${path}`);
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
