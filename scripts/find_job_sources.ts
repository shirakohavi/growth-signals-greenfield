// Step 1: job-source survey for all companies.
// For each company: load website -> find careers link + ATS references (raw HTML, then rendered DOM + network
// calls) -> confirm via the ATS public API -> else guess ATS slugs (with identity check) -> else investor Getro
// boards -> else own careers page / none.
// Output: data/job_sources.csv, data/job_sources.json, data/job_sources_report.md
import { readFile, writeFile } from "node:fs/promises";
import { politeFetch } from "../src/lib/fetch.ts";
import { comeetPositionIds, detectAts, identityCheck, probeBoard, probeComeetApi, probeComeetPage, slugGuesses, type AtsHit, type BoardProbe } from "../src/lib/ats.ts";
import { closeBrowser, render } from "../src/lib/render.ts";
import { parseCsv, toCsv } from "../src/lib/csv.ts";
import { ABOUT_PATH_RE, findHiringStatement } from "../src/lib/hiring.ts";

const GETRO_BOARDS = [
  "https://jobs.tlv.partners",
  "https://jobs.nfx.com",
  "https://jobs.insightpartners.com",
  "https://jobs.vertexventures.co.il",
  "https://jobs.accel.com",
];
const API_ATS = ["greenhouse", "lever", "ashby", "workable"] as const;
const CAREERS_RE = /(careers?|jobs|join[-_ ]?(us|the[-_ ]?team)|open[-_ ]?(roles|positions)|positions|work[-_ ]?with[-_ ]?us|we.?re[-_ ]?hiring|hiring)/i;
const ROLE_RE = /\b(engineer|developer|manager|director|head of|vp\b|vice president|executive|sdr|bdr|analyst|designer|specialist|researcher|scientist|lead|architect|representative|recruiter|counsel|controller|intern|technician|chemist|biologist)\b/i;

type SourceStatus = "ok" | "empty" | "failed" | "not_checked";

interface Row {
  company: string;
  domain: string;
  website_status: string;
  careers_url: string;
  job_source_type: string;
  job_source_url: string;
  ats_slug: string;
  open_jobs: string;
  detection: string;
  confidence: string;
  needs_rendering: string;
  sources_checked: string;
  notes: string;
}

function anchors(html: string, base: string): { href: string; text: string }[] {
  const out: { href: string; text: string }[] = [];
  for (const m of html.matchAll(/<a\b[^>]*?href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]{0,300}?)<\/a>/gi)) {
    try {
      out.push({ href: new URL(m[1], base).href, text: m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() });
    } catch { /* bad URL */ }
  }
  return out;
}

function careersLinks(links: { href: string; text: string }[], domain: string): string[] {
  const root = domain.replace(/^www\./, "");
  const scored = links
    .filter((l) => CAREERS_RE.test(l.href) || CAREERS_RE.test(l.text))
    .filter((l) => !/linkedin\.com|twitter\.com|x\.com|facebook\.com|\.pdf$|blog\/|\/news\//i.test(l.href))
    .map((l) => {
      let s = 0;
      try {
        const host = new URL(l.href).host;
        if (host.endsWith(root)) s += 2;
        if (/greenhouse|lever|ashby|comeet|workable|bamboohr|breezy|getro|teamtailor/.test(host)) s += 3;
      } catch { /* */ }
      if (/^(careers?|jobs|join us|we'?re hiring)$/i.test(l.text)) s += 2;
      // Keep the href exactly as linked: some sites (e.g. HubSpot CMS) 404 without the trailing slash.
      return { href: l.href, s };
    })
    .sort((a, b) => b.s - a.s);
  const seen = new Set<string>();
  return scored.filter((x) => { const k = x.href.replace(/\/$/, ""); if (seen.has(k)) return false; seen.add(k); return true; })
    .map((x) => x.href).slice(0, 2);
}

/** Soft 404: 200 status but a "page not found" body. */
const SOFT_404_RE = /page not found|can.t be found|can.t find (?:the|this) page|page (?:you were looking for|you requested) (?:does not|doesn.t) exist|404 error|error 404/i;
function isSoft404(html: string): boolean {
  return SOFT_404_RE.test(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").slice(0, 20000));
}

function roleLikeLines(text: string): string[] {
  return text
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 6 && l.length < 90 && ROLE_RE.test(l) && !/apply|cookie|privacy|©|all rights/i.test(l));
}

/** Same-site page URLs from sitemap.xml (follows one level of nested sitemaps, page sitemaps first). */
async function sitemapPages(domain: string): Promise<string[]> {
  const locs = (xml: string) => [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
  const top = await politeFetch(`https://${domain}/sitemap.xml`, { respectRobots: true });
  if (!top.ok) return [];
  let urls = locs(top.body);
  const nested = urls.filter((u) => /\.xml(\?|$)/i.test(u));
  if (nested.length) {
    urls = urls.filter((u) => !nested.includes(u));
    const pick = [...nested.filter((u) => /page/i.test(u)), ...nested.filter((u) => !/page/i.test(u))].slice(0, 2);
    for (const n of pick) {
      const r = await politeFetch(n, { respectRobots: true });
      if (r.ok) urls.push(...locs(r.body));
    }
  }
  const root = domain.replace(/^www\./, "");
  return urls.filter((u) => { try { return new URL(u).host.endsWith(root); } catch { return false; } });
}

async function getroSearch(name: string, domain: string): Promise<{ board: string; jobs: number; url: string } | null> {
  for (const board of GETRO_BOARDS) {
    const url = `${board}/companies?q=${encodeURIComponent(name)}`;
    const r = await render(url, 1500);
    if (!r.ok) continue;
    // Text pattern on Getro company search: "... Showing N company | <Name> | <k> jobs | ..."
    const lines = r.text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
    for (let i = 0; i < lines.length - 1; i++) {
      if (lines[i].toLowerCase() === name.toLowerCase()) {
        const m = lines.slice(i + 1, i + 3).join(" ").match(/(\d+)\s+jobs?/i);
        if (m) {
          const link = r.links.find((l) => /\/companies\//.test(l.href) && l.text.toLowerCase().includes(name.toLowerCase()));
          // Identity check: the Getro company profile lists the company's website.
          const profile = await render(link?.href ?? url, 1000);
          if (!profile.text.toLowerCase().includes(domain.toLowerCase())) continue;
          return { board, jobs: Number(m[1]), url: link?.href ?? url };
        }
      }
    }
  }
  return null;
}

async function survey(company: string, domain: string): Promise<Row> {
  const notes: string[] = [];
  const sources: Record<string, SourceStatus> = {
    greenhouse: "not_checked", lever: "not_checked", ashby: "not_checked", comeet: "not_checked",
    workable: "not_checked", getro: "not_checked", careers_page: "not_checked", aggregator: "not_checked",
  };
  const row: Row = {
    company, domain, website_status: "", careers_url: "", job_source_type: "none", job_source_url: "", ats_slug: "",
    open_jobs: "", detection: "", confidence: "", needs_rendering: "no", sources_checked: "", notes: "",
  };

  // 1. Homepage
  let home = await politeFetch(`https://${domain}`, { respectRobots: true });
  let homeHtml = home.body;
  let homeLinks = home.ok ? anchors(homeHtml, home.url) : [];
  if (!home.ok || homeLinks.length < 5) {
    const r = await render(`https://${domain}`);
    if (r.ok) {
      homeHtml = r.html + "\n" + r.requests.join("\n");
      homeLinks = r.links;
      notes.push("homepage needs JS");
    }
  }
  row.website_status = home.ok ? "ok" : homeLinks.length ? "ok (rendered)" : `failed (${home.status || home.error})`;
  const hits: AtsHit[] = detectAts(homeHtml, home.url);

  // 2. Careers page(s)
  let careers = careersLinks(homeLinks, domain);
  // Menus behind "About ▾" dropdowns often aren't in the homepage links, so also use the sitemap.
  const sitemap = await sitemapPages(domain);
  if (!careers.length) {
    const fromMap = sitemap.filter((u) => /\/(careers?|jobs|join-us|open-positions|hiring)(\/|$)/i.test(new URL(u).pathname));
    if (fromMap.length) {
      careers = fromMap.slice(0, 2);
      notes.push(`careers page found via sitemap: ${new URL(fromMap[0]).pathname}`);
    }
  }
  if (!careers.length) {
    for (const p of ["/careers", "/jobs", "/company/careers", "/about/careers", "/join-us"]) {
      const r = await politeFetch(`https://${domain}${p}`, { respectRobots: true });
      const landed = new URL(r.url);
      if (r.ok && landed.pathname.replace(/\/$/, "") !== "" && !isSoft404(r.body)) {
        careers = [r.url];
        notes.push(`careers page not linked from homepage; found at ${p}`);
        break;
      }
    }
  }
  let careersText = "";
  let careersHrefs: string[] = [];
  for (let c of careers) {
    let raw = await politeFetch(c, { respectRobots: !/greenhouse|lever|ashby|comeet|workable/.test(c) });
    if (raw.ok && isSoft404(raw.body)) {
      // Try the other trailing-slash form before giving up on this link.
      const alt = c.endsWith("/") ? c.slice(0, -1) : `${c}/`;
      const r2 = await politeFetch(alt, { respectRobots: true });
      if (r2.ok && !isSoft404(r2.body)) { notes.push(`careers link only works as ${new URL(alt).pathname}`); c = alt; raw = r2; }
      else { notes.push(`careers link ${new URL(c).pathname} is a 'page not found' page`); continue; }
    }
    if (raw.status === -1) notes.push(`robots.txt disallows ${c}`);
    const rawHits = detectAts(raw.body + " " + c, c);
    hits.push(...rawHits);
    const rawRoles = roleLikeLines(raw.body.replace(/<[^>]+>/g, "\n"));
    if (!rawHits.length) {
      const r = await render(c);
      if (r.ok) {
        const renderedHits = detectAts(r.html + "\n" + r.requests.join("\n") + "\n" + r.links.map((l) => l.href).join("\n"), c);
        hits.push(...renderedHits);
        careersText += "\n" + r.text;
        careersHrefs.push(...r.links.map((l) => l.href));
        if (roleLikeLines(r.text).length > rawRoles.length + 2 || renderedHits.length) row.needs_rendering = "yes";
      }
    } else {
      careersText += "\n" + raw.body.replace(/<[^>]+>/g, "\n");
    }
    careersHrefs.push(...anchors(raw.body, c).map((l) => l.href));
    if (!row.careers_url) row.careers_url = c;
    if (hits.length) break;
  }

  // 3. Confirm detected ATS boards via API
  const seen = new Set<string>();
  const confirmed: { probe: BoardProbe; how: string; conf: string }[] = [];
  for (const h of hits) {
    const key = `${h.type}:${h.slug}`;
    if (seen.has(key) || h.type === "getro") continue;
    seen.add(key);
    const isEmbed = h.type === "comeet" && h.extra && h.extra.length > 8;
    const probe = h.type !== "comeet" ? await probeBoard(h.type, h.slug)
      : isEmbed ? await probeComeetApi(h.slug, h.extra!) : await probeComeetPage(h.slug, h.extra);
    if (probe.status === "ok" || probe.status === "empty") {
      if (h.type === "comeet" && h.extra && !isEmbed) probe.slug = `${h.slug}/${h.extra}`;
      confirmed.push({ probe, how: "linked from website", conf: "high" });
    } else {
      notes.push(`${h.type}:${h.slug} linked but API ${probe.status}`);
    }
    if (h.type in sources) sources[h.type] = probe.status === "not_found" ? "failed" : probe.status === "ok" ? "ok" : probe.status === "empty" ? "empty" : "failed";
  }

  // 4. Slug guesses when nothing was linked (identity-checked: common names collide across companies)
  if (!confirmed.some((c) => c.probe.status === "ok")) {
    for (const ats of API_ATS) {
      if (sources[ats] !== "not_checked") continue; // already linked from the site
      let best: BoardProbe | null = null;
      for (const slug of slugGuesses(company, domain).slice(0, 3)) {
        const p = await probeBoard(ats, slug);
        if (p.status === "ok" || p.status === "empty") { best = p; break; }
      }
      if (!best) { if (sources[ats] === "not_checked") sources[ats] = "empty"; continue; }
      const id = identityCheck(best, company, domain);
      if (id !== "confirmed") {
        const who = best.boardName ? `"${best.boardName}"` : `titles: ${(best.sampleTitles ?? []).slice(0, 2).join("; ")}`;
        notes.push(`${ats}:${best.slug} exists (${best.openJobs} jobs, ${who}) but not tied to ${domain} — ignored`);
        sources[ats] = "empty";
        continue;
      }
      sources[ats] = best.status === "ok" ? "ok" : "empty";
      confirmed.push({ probe: best, how: "slug guess (domain found in job text)", conf: "medium" });
    }
  }

  const bestAts = confirmed.sort((a, b) => (b.probe.openJobs ?? 0) - (a.probe.openJobs ?? 0) || (a.conf === "high" ? -1 : 1))[0];
  if (bestAts && (bestAts.probe.status === "ok" || bestAts.conf === "high")) {
    row.job_source_type = bestAts.probe.type;
    row.job_source_url = bestAts.probe.apiUrl;
    row.ats_slug = bestAts.probe.slug;
    row.open_jobs = bestAts.probe.openJobs === undefined ? "?" : String(bestAts.probe.openJobs);
    row.detection = bestAts.how;
    row.confidence = bestAts.conf;
    if (bestAts.probe.sampleTitles?.length) notes.push(`e.g. ${bestAts.probe.sampleTitles.slice(0, 3).join("; ")}`);
    if (confirmed.length > 1) notes.push(`also: ${confirmed.filter((c) => c !== bestAts).map((c) => `${c.probe.type}:${c.probe.slug}(${c.probe.openJobs ?? "?"})`).join(", ")}`);
  }

  // 5. Investor Getro boards (fallback)
  if (!row.open_jobs || row.open_jobs === "0" || row.open_jobs === "?") {
    const g = await getroSearch(company, domain);
    sources.getro = g ? (g.jobs > 0 ? "ok" : "empty") : "empty";
    if (g && g.jobs > 0) {
      if (row.job_source_type !== "none") notes.push(`primary ${row.job_source_type} had ${row.open_jobs} jobs`);
      row.job_source_type = "getro";
      row.job_source_url = g.url;
      row.open_jobs = String(g.jobs);
      row.detection = `Getro search on ${new URL(g.board).host}`;
      row.confidence = "medium";
    }
  }

  // 6. Own careers page as the source
  const roles = roleLikeLines(careersText);
  const comeetIds = comeetPositionIds(careersHrefs);
  if (row.careers_url) sources.careers_page = roles.length || comeetIds.length ? "ok" : "empty";
  if (row.job_source_type === "none" && row.careers_url) {
    row.job_source_type = "careers_page";
    row.job_source_url = row.careers_url;
    row.open_jobs = comeetIds.length ? String(comeetIds.length)
      : roles.length ? `~${roles.length} (role-like lines; AI extraction in step 4)` : "0 seen";
    if (comeetIds.length) notes.push(`Comeet-powered page (${comeetIds.length} position IDs in links; no public token, so scrape the page)`);
    row.detection = row.needs_rendering === "yes" ? "careers page (JS-rendered)" : "careers page";
    row.confidence = comeetIds.length ? "high" : roles.length ? "medium" : "low";
    if (roles.length) notes.push(`e.g. ${roles.slice(0, 3).join("; ")}`);
  }
  // 7. Open hiring statement with no listings (e.g. "actively recruiting ... careers@x.io" on the About page).
  //    Checked on the homepage, About/Company/Team pages (homepage links + sitemap + common paths).
  if (row.job_source_type === "none" || (row.job_source_type === "careers_page" && row.open_jobs === "0 seen")) {
    const root = domain.replace(/^www\./, "");
    const sameSite = (u: string) => { try { return new URL(u).host.endsWith(root); } catch { return false; } };
    const aboutPages = [
      ...homeLinks.map((l) => l.href).filter((u) => sameSite(u) && ABOUT_PATH_RE.test(new URL(u).pathname)),
      ...sitemap.filter((u) => ABOUT_PATH_RE.test(new URL(u).pathname)),
      ...["/about", "/about-us", "/company"].map((p) => `https://${domain}${p}`),
    ].map((u) => u.replace(/\/$/, ""));
    const checked = new Set<string>();
    let found: { url: string; s: NonNullable<ReturnType<typeof findHiringStatement>> } | null = null;
    // Careers page with no listings first (e.g. "visit our LinkedIn page for open positions"), then homepage.
    const careersHit = row.careers_url ? findHiringStatement(careersHrefs.join(" ") + "\n" + careersText, careersText) : null;
    if (careersHit) found = { url: row.careers_url, s: careersHit };
    const homeHit = found ? null : findHiringStatement(homeHtml);
    if (homeHit) found = { url: `https://${domain}`, s: homeHit };
    const pathKey = (u: string) => new URL(u).pathname.replace(/\/$/, "");
    const candidates = [...new Map(aboutPages.map((u) => [pathKey(u), u])).values()];
    for (const u of candidates.slice(0, 4)) {
      if (found) break;
      const r = await politeFetch(u, { respectRobots: true });
      if (!r.ok || pathKey(r.url) === "" || isSoft404(r.body) || checked.has(pathKey(r.url))) continue;
      checked.add(pathKey(r.url));
      let s = findHiringStatement(r.body);
      if (!s && anchors(r.body, r.url).length < 5) {
        const rr = await render(u);
        if (rr.ok) s = findHiringStatement(rr.html, rr.text);
      }
      if (s) found = { url: r.url, s };
    }
    if (found) {
      row.job_source_type = "hiring_statement";
      row.job_source_url = found.url;
      if (!row.careers_url) row.careers_url = found.url;
      row.open_jobs = "open (no listings)";
      row.detection = "hiring statement on site";
      row.confidence = found.s.strong ? "medium" : "low";
      if (found.s.listingsOnLinkedIn) notes.push("site points to LinkedIn for open positions (not scraped; aggregator fallback in step 4)");
      if (!found.s.strong) notes.push("weak wording only (e.g. 'join our team'): needs a human look");
      notes.push(`no job list, but site says it is hiring${found.s.areas.length ? ` (${found.s.areas.join(", ")})` : ""}` +
        `${found.s.email ? `; contact ${found.s.email}` : ""}${found.s.phrases.length ? `; "${found.s.phrases[0]}"` : ""}`);
    } else if (row.job_source_type === "none") {
      notes.push(`checked for a hiring statement on: / ${[...checked].join(" ")}`.trim());
    }
  }

  if (row.job_source_type === "none") {
    row.detection = "nothing found";
    row.confidence = "low";
    notes.push("candidate for aggregator fallback (step 4)");
  }

  row.sources_checked = JSON.stringify(sources);
  row.notes = notes.join(" | ");
  return row;
}

async function main() {
  const companies = parseCsv(await readFile("data/companies.csv", "utf8"));
  const domains = new Map(parseCsv(await readFile("data/company_domains.csv", "utf8")).map((r) => [r.company, r.domain]));
  // Usage: find_job_sources.ts                      -> survey all, write files
  //        find_job_sources.ts "Name"               -> survey one, print JSON only (debug)
  //        find_job_sources.ts --merge "A" "B" ...  -> re-survey these, merge into existing job_sources.json
  const args = process.argv.slice(2);
  const merge = args.includes("--merge");
  const names = args.filter((a) => a !== "--merge").map((a) => a.toLowerCase());
  const only = names.length > 0 && !merge;
  const todo = companies.filter((c) => !names.length || names.includes(c.Company.toLowerCase()));
  const missing = names.filter((n) => !companies.some((c) => c.Company.toLowerCase() === n));
  if (missing.length) throw new Error(`unknown company: ${missing.join(", ")}`);

  const rows: Row[] = new Array(todo.length);
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const i = next++;
      const c = todo[i];
      const domain = domains.get(c.Company) ?? c.Website;
      if (!domain) { console.error(`no domain for ${c.Company}`); continue; }
      const t = Date.now();
      try {
        // Hard cap per company so one hung page/render can't stall the whole run.
        rows[i] = await Promise.race([
          survey(c.Company, domain),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error("survey timed out after 240s")), 240_000).unref()),
        ]);
      } catch (e) {
        rows[i] = { company: c.Company, domain, website_status: "error", careers_url: "", job_source_type: "none", job_source_url: "", ats_slug: "", open_jobs: "", detection: "error", confidence: "low", needs_rendering: "", sources_checked: "{}", notes: (e as Error).message };
      }
      console.log(`[${i + 1}/${todo.length}] ${c.Company.padEnd(18)} ${rows[i].job_source_type.padEnd(12)} jobs=${rows[i].open_jobs || "-"}  (${((Date.now() - t) / 1000).toFixed(0)}s)`);
    }
  };
  await Promise.all(Array.from({ length: 5 }, worker));
  await closeBrowser();

  let out = rows.filter(Boolean);
  if (merge) {
    // Keep existing rows (in companies.csv order), swapping in the freshly surveyed ones.
    const prev: Row[] = JSON.parse(await readFile("data/job_sources.json", "utf8"));
    const fresh = new Map(out.map((r) => [r.company, r]));
    out = companies
      .map((c) => fresh.get(c.Company) ?? prev.find((p) => p.company === c.Company))
      .filter((r): r is Row => Boolean(r));
    // Overrides are re-applied below; strip any MANUAL prefix already on kept rows so it isn't doubled.
    for (const r of out) r.notes = r.notes.split(" | ").filter((n) => !n.startsWith("MANUAL: ")).join(" | ");
  }
  // Manual corrections from hand-checking pages (kept in a file so the run stays reproducible).
  try {
    for (const o of parseCsv(await readFile("data/job_sources_overrides.csv", "utf8"))) {
      const r = out.find((x) => x.company === o.company);
      if (!r) continue;
      if (o.open_jobs) r.open_jobs = o.open_jobs;
      if (o.confidence) r.confidence = o.confidence;
      if (o.note) r.notes = [`MANUAL: ${o.note}`, r.notes].filter(Boolean).join(" | ");
    }
  } catch { /* no overrides */ }
  if (only) { console.log(JSON.stringify(out, null, 2)); return; }
  await writeFile("data/job_sources.csv", toCsv(out as unknown as Record<string, string>[]));
  await writeFile("data/job_sources.json", JSON.stringify(out, null, 2));
  console.log("wrote data/job_sources.csv");
}

// Exit explicitly: timed-out surveys can leave sockets/pages open that keep the event loop alive after we're done.
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
