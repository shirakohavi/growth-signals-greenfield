// Local JS rendering with Playwright (stand-in for Cloudflare Browser Rendering in production).
import { chromium, type Browser } from "playwright";
import { USER_AGENT } from "./fetch.ts";

let browser: Browser | null = null;
const hostLast = new Map<string, number>();

export interface RenderResult {
  ok: boolean;
  url: string;
  html: string;
  text: string;
  requests: string[]; // every request URL the page made (used to spot ATS / Getro JSON calls)
  links: { href: string; text: string }[];
  error?: string;
}

export async function render(url: string, waitMs = 2500): Promise<RenderResult> {
  browser ??= await chromium.launch();
  const host = new URL(url).host;
  const gap = 3000 - (Date.now() - (hostLast.get(host) ?? 0));
  if (gap > 0) await new Promise((r) => setTimeout(r, gap));
  hostLast.set(host, Date.now());

  const ctx = await browser.newContext({ userAgent: USER_AGENT });
  const page = await ctx.newPage();
  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url()));
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(waitMs);
    const html = await page.content();
    const text = await page.innerText("body").catch(() => "");
    // Include iframe contents (ATS widgets are often iframes)
    let frameHtml = "";
    for (const f of page.frames()) if (f !== page.mainFrame()) frameHtml += " " + f.url();
    const links = await page.$$eval("a[href]", (as) =>
      as.map((a) => ({ href: (a as HTMLAnchorElement).href, text: ((a as HTMLElement).innerText || a.textContent || "").trim().slice(0, 200) })),
    );
    return { ok: true, url: page.url(), html: html + frameHtml, text, requests, links };
  } catch (e) {
    return { ok: false, url, html: "", text: "", requests, links: [], error: (e as Error).message };
  } finally {
    await ctx.close();
  }
}

export async function closeBrowser() {
  await browser?.close();
  browser = null;
}
