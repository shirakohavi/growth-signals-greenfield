// Footprint: a company's sitemap (BUILD_BRIEF §5). URLs + lastmod, classified by kind, so runs can be diffed:
// new partner/reseller pages, new country paths (/us, /de), new industry/solution pages.
import type { Http } from "./ats.ts";

export type PageKind = "partner" | "country" | "industry" | "careers" | "news" | "about" | "other";
export interface SitePage { url: string; kind: PageKind; lastmod: string | null }

const MAX_SITEMAPS = 15;
const MAX_URLS = 5000;

// Country/locale path prefixes. Language-only codes (en, he) are not countries.
const COUNTRY_SEG = /^(us|usa|uk|gb|de|fr|es|it|nl|be|ch|at|se|dk|no|fi|ie|pt|pl|jp|kr|cn|hk|tw|sg|in|au|nz|ca|mx|br|ar|cl|co|ae|sa|za|il|en-(?:us|gb|uk|au|ca|in|sg)|de-de|de-at|de-ch|fr-fr|fr-ca|es-es|es-mx|it-it|nl-nl|pt-br|ja-jp|ko-kr|zh-cn)$/i;

export function classifyUrl(url: string): PageKind {
  let path: string;
  try { path = new URL(url).pathname.toLowerCase(); } catch { return "other"; }
  const segs = path.split("/").filter(Boolean);
  if (/\/(blog|news|press|newsroom|media|events?|webinars?|resources|podcast)s?(\/|$)/.test(path)) {
    // A blog post that mentions partners is not a partner program page.
    return /\/(press|newsroom|news)(\/|$)/.test(path) ? "news" : "other";
  }
  // Partner/channel PROGRAM pages only. /partners/aws, /partners/azure are technology-partner (integration) pages.
  if (!/integrations?/.test(path)) {
    if (/(^|\/)(partner-program|partners?-program|become-a-partner|resellers?|channel(-partners?)?|msps?|mssps?|distributors?|referral-partners?)(\/|$|-)/.test(path)) return "partner";
    if (/^\/partners?\/?$/.test(path)) return "partner";
    if (/^\/partners?\/(join|program|become|apply|portal|channel|resell|msp|mssp|referral)/.test(path)) return "partner";
  }
  if (segs.length && COUNTRY_SEG.test(segs[0])) return "country";
  if (/(^|\/)(industries|industry|solutions?|use-cases?|verticals?|sectors?)(\/|$)/.test(path)) return "industry";
  if (/(^|\/)(careers?|jobs|join-us|open-positions)(\/|$)/.test(path)) return "careers";
  if (/(^|\/)(about(-us)?|company|team|leadership|our-story|contact(-us)?)(\/|$)/.test(path)) return "about";
  return "other";
}

const locs = (xml: string) =>
  [...xml.matchAll(/<(url|sitemap)>([\s\S]*?)<\/\1>/gi)].map((m) => ({
    isIndex: m[1].toLowerCase() === "sitemap",
    loc: m[2].match(/<loc>\s*(?:<!\[CDATA\[)?([^<\]\s]+)/i)?.[1]?.trim() ?? "",
    lastmod: m[2].match(/<lastmod>\s*([^<\s]+)/i)?.[1]?.slice(0, 10) ?? null,
  })).filter((x) => x.loc);

/** Sitemap URLs from robots.txt "Sitemap:" lines, else /sitemap.xml and /sitemap_index.xml. Follows index files. */
export async function collectSitemap(http: Http, domain: string): Promise<{ status: "ok" | "empty" | "failed"; pages: SitePage[]; error?: string }> {
  const root = domain.replace(/^www\./, "");
  const sameSite = (u: string) => { try { return new URL(u).host.replace(/^www\./, "").endsWith(root); } catch { return false; } };
  const queue: string[] = [];
  const robots = await http(`https://${domain}/robots.txt`);
  if (robots.ok) for (const m of robots.body.matchAll(/^\s*sitemap:\s*(\S+)/gim)) queue.push(m[1]);
  if (!queue.length) queue.push(`https://${domain}/sitemap.xml`, `https://${domain}/sitemap_index.xml`);

  const seen = new Set<string>();
  const pages = new Map<string, SitePage>();
  let fetched = 0;
  let anyOk = false;
  while (queue.length && fetched < MAX_SITEMAPS && pages.size < MAX_URLS) {
    const sm = queue.shift()!;
    if (seen.has(sm)) continue;
    seen.add(sm);
    fetched++;
    const r = await http(sm, { respectRobots: true });
    if (!r.ok || !/<(urlset|sitemapindex)/i.test(r.body)) continue;
    anyOk = true;
    for (const x of locs(r.body)) {
      if (x.isIndex) { if (!seen.has(x.loc)) queue.push(x.loc); continue; }
      if (!sameSite(x.loc) || pages.has(x.loc)) continue;
      pages.set(x.loc, { url: x.loc, kind: classifyUrl(x.loc), lastmod: /^\d{4}-\d{2}-\d{2}$/.test(x.lastmod ?? "") ? x.lastmod : null });
      if (pages.size >= MAX_URLS) break;
    }
  }
  if (!anyOk) return { status: "failed", pages: [], error: "no readable sitemap" };
  return { status: pages.size ? "ok" : "empty", pages: [...pages.values()] };
}
