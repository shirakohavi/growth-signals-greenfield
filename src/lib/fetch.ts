// Polite HTTP fetching for local (Node) runs.
// - clear User-Agent, no disguising
// - >= 3 s between requests to the same host
// - robots.txt respected for website pages (not for documented public job APIs)
// - small on-disk cache so re-running during development doesn't re-hit sites
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Says who we are and where to look: a case-study crawler, with its public dashboard as the contact page.
export const USER_AGENT = "GrowthSignalsBot/0.1 (case-study crawler; +https://team-signals.team-signals.workers.dev)";
const HOST_GAP_MS = 3000;
const CACHE_DIR = join(process.cwd(), "data", "cache", "http");
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

export interface FetchResult {
  ok: boolean;
  status: number; // 0 = network error, -1 = blocked by robots.txt
  url: string; // final URL after redirects
  body: string;
  error?: string;
  notModified?: boolean; // served from cache after a 304
}

const hostQueue = new Map<string, Promise<void>>();

/** Serialises requests per host and keeps HOST_GAP_MS between them. */
async function waitForHost(host: string): Promise<() => void> {
  const prev = hostQueue.get(host) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((r) => (release = r));
  hostQueue.set(host, prev.then(() => next));
  await prev;
  return () => setTimeout(release, HOST_GAP_MS);
}

const robotsCache = new Map<string, string[] | null>();

async function disallowedPrefixes(origin: string): Promise<string[]> {
  if (robotsCache.has(origin)) return robotsCache.get(origin) ?? [];
  const res = await rawFetch(`${origin}/robots.txt`, {}, true);
  const rules: string[] = [];
  if (res.ok) {
    let applies = false;
    let sawAgentBlock = false;
    for (const line of res.body.split(/\r?\n/)) {
      const [k, ...rest] = line.split(":");
      const key = k.trim().toLowerCase();
      const val = rest.join(":").split("#")[0].trim();
      if (key === "user-agent") {
        if (sawAgentBlock) { applies = false; sawAgentBlock = false; }
        if (val === "*" || /growthsignals/i.test(val)) applies = true;
      } else if (key === "disallow" || key === "allow") {
        sawAgentBlock = true;
        if (applies && key === "disallow" && val) rules.push(val);
      }
    }
  }
  robotsCache.set(origin, rules);
  return rules;
}

interface CacheEntry { t: number; r: FetchResult; etag?: string; lastModified?: string }

async function rawFetch(url: string, init: RequestInit, skipCache = false, ttlMs = CACHE_TTL_MS): Promise<FetchResult> {
  const key = createHash("sha1").update((init.method ?? "GET") + url + String(init.body ?? "")).digest("hex");
  const cachePath = join(CACHE_DIR, key + ".json");
  let cached: CacheEntry | undefined;
  if (!skipCache) {
    try {
      cached = JSON.parse(await readFile(cachePath, "utf8")) as CacheEntry;
      if (Date.now() - cached.t < ttlMs) return cached.r;
    } catch { /* miss */ }
  }
  // Stale or bypassed cache: revalidate with ETag / Last-Modified when we have them (brief §5: conditional requests).
  const conditional: Record<string, string> = {};
  if (cached?.r.ok && cached.etag) conditional["if-none-match"] = cached.etag;
  if (cached?.r.ok && cached.lastModified) conditional["if-modified-since"] = cached.lastModified;
  const host = new URL(url).host;
  const done = await waitForHost(host);
  let result: FetchResult;
  let validators: { etag?: string; lastModified?: string } = {};
  try {
    const res = await fetch(url, {
      ...init,
      redirect: "follow",
      headers: { "user-agent": USER_AGENT, accept: "text/html,application/json;q=0.9,*/*;q=0.8", ...conditional, ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(20000),
    });
    if (res.status === 304 && cached) {
      await writeFile(cachePath, JSON.stringify({ ...cached, t: Date.now() }));
      return { ...cached.r, notModified: true };
    }
    const body = await res.text();
    result = { ok: res.ok, status: res.status, url: res.url, body };
    validators = { etag: res.headers.get("etag") ?? undefined, lastModified: res.headers.get("last-modified") ?? undefined };
  } catch (e) {
    result = { ok: false, status: 0, url, body: "", error: (e as Error).message };
  } finally {
    done();
  }
  if (!skipCache && result.status !== 0 && result.status < 500) {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(cachePath, JSON.stringify({ t: Date.now(), r: result, ...validators } satisfies CacheEntry));
  }
  return result;
}

/**
 * Fetch with one retry on network/5xx errors.
 * `respectRobots` should be true for company websites and investor boards.
 * (The production pipeline retries after 1/5/30 min; the step-1 survey retries once.)
 */
export async function politeFetch(
  url: string,
  opts: { respectRobots?: boolean; init?: RequestInit; /** 0 = always revalidate (collectors); default 12 h (survey/dev) */ cacheTtlMs?: number } = {},
): Promise<FetchResult> {
  if (opts.respectRobots) {
    const u = new URL(url);
    const rules = await disallowedPrefixes(u.origin);
    const path = u.pathname + u.search;
    const matches = (p: string) => {
      const re = new RegExp("^" + p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$"));
      return re.test(path);
    };
    if (rules.some(matches)) {
      return { ok: false, status: -1, url, body: "", error: "blocked by robots.txt" };
    }
  }
  const ttl = opts.cacheTtlMs ?? CACHE_TTL_MS;
  let r = await rawFetch(url, opts.init ?? {}, false, ttl);
  if (r.status === 0 || r.status >= 500) {
    await new Promise((res) => setTimeout(res, 2000));
    r = await rawFetch(url, opts.init ?? {}, false, ttl);
  }
  return r;
}

export async function fetchJson<T = unknown>(url: string): Promise<{ status: number; data: T | null; error?: string }> {
  const r = await politeFetch(url, { init: { headers: { accept: "application/json" } } });
  if (!r.ok) return { status: r.status, data: null, error: r.error };
  try {
    return { status: r.status, data: JSON.parse(r.body) as T };
  } catch {
    return { status: r.status, data: null, error: "invalid JSON" };
  }
}
