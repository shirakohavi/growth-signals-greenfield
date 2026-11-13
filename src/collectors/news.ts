// Footprint: news in English AND Hebrew (BUILD_BRIEF §5).
// Source: Bing News RSS. The brief suggests Google News RSS, but news.google.com/robots.txt disallows all
// automated clients ("User-agent: *  Disallow: /"), and we respect robots.txt. Bing's /news/search RSS is allowed.
// Each item links through bing.com/news/apiclick.aspx?...&url=<original>: we keep the ORIGINAL article URL,
// and the article itself is read from the publisher (brief: read the original article, not roundups).
import type { Http } from "./ats.ts";

export interface NewsItem {
  url: string;          // original article URL
  title: string;
  source: string | null;
  published: string | null; // YYYY-MM-DD
  snippet: string;
  lang: "en" | "he";
}

const unescape = (s: string) =>
  s.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

function originalUrl(link: string): string {
  const l = link.replace(/&amp;/g, "&");
  const m = l.match(/[?&]url=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : l;
}

export async function bingNews(http: Http, query: string, lang: "en" | "he"): Promise<{ ok: boolean; items: NewsItem[]; error?: string }> {
  const params = lang === "he" ? "setlang=he&cc=IL" : "setlang=en-US&cc=US";
  const url = `https://www.bing.com/news/search?q=${encodeURIComponent(query)}&format=rss&${params}`;
  const r = await http(url, { respectRobots: true });
  if (!r.ok) return { ok: false, items: [], error: r.error ?? `HTTP ${r.status}` };
  const items: NewsItem[] = [];
  for (const m of r.body.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const get = (t: string) => m[1].match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, "i"))?.[1];
    const link = get("link");
    if (!link) continue;
    const pub = get("pubDate");
    const d = pub ? new Date(unescape(pub)) : null;
    items.push({
      url: originalUrl(unescape(link).replace(/ /g, "")),
      title: unescape(get("title") ?? ""),
      source: get("News:Source") ? unescape(get("News:Source")!) : null,
      published: d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : null,
      snippet: unescape(get("description") ?? "").slice(0, 400),
      lang,
    });
  }
  return { ok: true, items };
}

/** Main text of an article page: paragraphs, without nav/scripts. Good enough for the AI to read. */
export function articleText(html: string): string {
  const body = html
    .replace(/<(script|style|noscript|svg|nav|footer|header|aside|form)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|h[1-6]|li|div|br)>/gi, "\n");
  const paras = body.replace(/<[^>]+>/g, " ").split(/\n+/)
    .map((p) => p.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 40);
  return paras.join("\n").slice(0, 12000);
}
