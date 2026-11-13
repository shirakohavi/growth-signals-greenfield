// Growth Signals Worker: serves the dashboard (static assets from public/), a read-only API over D1, and
// /api/run, which starts and reports the pipeline. The pipeline itself runs in GitHub Actions
// (.github/workflows/weekly-run.yml), because it needs a browser and long runtimes a Worker doesn't have.
//
//   GET  /api/run  → latest run: { running, step, total, label, startedAt, finishedAt, ok, url, ... }
//   POST /api/run  → { "passcode": "…" } starts a run (one at a time)
//
// Secrets (`npx wrangler secret put NAME`): GITHUB_TOKEN (fine-grained, this repo only, Actions: read and write),
// RUN_PASSCODE (shared with the team). Vars in wrangler.jsonc: GITHUB_REPO, WORKFLOW_FILE.

interface RunEnv {
  DB: D1Database;
  ASSETS: Fetcher;
  GITHUB_REPO: string;
  WORKFLOW_FILE: string;
  GITHUB_TOKEN?: string;
  RUN_PASSCODE?: string;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const gh = (env: RunEnv, path: string, init: RequestInit = {}) =>
  fetch(`https://api.github.com/repos/${env.GITHUB_REPO}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "growth-signals-worker",
      ...(init.headers ?? {}),
    },
  });

type GhRun = { id: number; status: string; conclusion: string | null; created_at: string; updated_at: string; html_url: string; event: string };
type GhStep = { name: string; status: string; conclusion: string | null };

/** Latest run of the workflow, shaped like the local server's state (scripts/serve.ts) so the dashboard reads both. */
async function runStatus(env: RunEnv) {
  const base = { mode: "hosted", needsPasscode: true, running: false, step: 0, total: 8, key: "", label: "", startedAt: null as string | null, finishedAt: null as string | null, ok: null as boolean | null, failedStep: null as string | null, dryRun: false, log: [] as string[], url: null as string | null, trigger: null as string | null };
  if (!env.GITHUB_TOKEN) return { ...base, configured: false };
  const runs = await gh(env, `/actions/workflows/${env.WORKFLOW_FILE}/runs?per_page=1`);
  if (!runs.ok) return { ...base, configured: false, error: `GitHub ${runs.status}` };
  const run = ((await runs.json()) as { workflow_runs: GhRun[] }).workflow_runs[0];
  if (!run) return { ...base, configured: true };
  const running = run.status !== "completed";
  const out = { ...base, configured: true, running, startedAt: run.created_at, finishedAt: running ? null : run.updated_at, ok: running ? null : run.conclusion === "success", url: run.html_url, trigger: run.event === "schedule" ? "weekly" : "manual" };
  // Step progress from the job's steps named "N · label" in the workflow.
  const jobs = await gh(env, `/actions/runs/${run.id}/jobs`);
  if (jobs.ok) {
    const steps = (((await jobs.json()) as { jobs: { steps?: GhStep[] }[] }).jobs[0]?.steps ?? [])
      .map((s) => ({ ...s, m: s.name.match(/^(\d+) · (.*)$/) })).filter((s) => s.m);
    out.total = steps.length || 8;
    const current = steps.find((s) => s.status === "in_progress") ?? steps.find((s) => s.status !== "completed");
    const failed = steps.find((s) => s.conclusion === "failure");
    const pick = failed ?? current ?? steps[steps.length - 1];
    if (pick?.m) { out.step = Number(pick.m[1]); out.label = pick.m[2]; out.key = `step${pick.m[1]}`; }
    if (failed?.m) out.failedStep = failed.m[2];
    if (running && !current) out.label = "Setting up";
    out.log = steps.map((s) => `${s.conclusion === "success" ? "✓" : s.conclusion === "failure" ? "✗" : s.status === "in_progress" ? "…" : "·"} ${s.m![1]} · ${s.m![2]}`);
  }
  return out;
}

/** Constant-time-ish comparison so the passcode can't be guessed character by character from timing. */
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function handleRun(request: Request, env: RunEnv, ctx: ExecutionContext): Promise<Response> {
  if (request.method === "GET") {
    // Cache GitHub's answer for a few seconds so several open dashboards don't use up the API limit.
    const cache = caches.default, key = new Request(new URL("/api/run?cached", request.url).toString());
    const hit = await cache.match(key);
    if (hit) return hit;
    const res = json(await runStatus(env));
    const cached = new Response(res.clone().body, res);
    cached.headers.set("cache-control", "max-age=8");
    ctx.waitUntil(cache.put(key, cached));
    return res;
  }
  if (request.method !== "POST") return json({ error: "GET or POST" }, 405);
  if (!(request.headers.get("content-type") ?? "").startsWith("application/json")) return json({ error: "JSON only" }, 415);
  if (!env.GITHUB_TOKEN || !env.RUN_PASSCODE) return json({ error: "Run now isn't set up yet (missing GITHUB_TOKEN or RUN_PASSCODE)." }, 503);
  let passcode = "";
  try { passcode = String(((await request.json()) as { passcode?: unknown }).passcode ?? ""); } catch { /* empty */ }
  if (!same(passcode, env.RUN_PASSCODE)) return json({ error: "Wrong passcode." }, 401);
  const status = await runStatus(env);
  if (status.running) return json({ error: "A run is already in progress.", ...status }, 409);
  const go = await gh(env, `/actions/workflows/${env.WORKFLOW_FILE}/dispatches`, { method: "POST", body: JSON.stringify({ ref: "main" }), headers: { "content-type": "application/json" } });
  if (go.status !== 204) return json({ error: `GitHub refused to start the run (${go.status}).` }, 502);
  await caches.default.delete(new Request(new URL("/api/run?cached", request.url).toString()));
  return json({ ...status, running: true, step: 0, label: "Starting…", startedAt: new Date().toISOString(), finishedAt: null, ok: null }, 202);
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const e = env as unknown as RunEnv;
    const url = new URL(request.url);

    if (url.pathname === "/api/run") return handleRun(request, e, ctx);

    if (url.pathname === "/api/health") {
      const row = await e.DB.prepare("SELECT COUNT(*) AS companies FROM companies").first<{ companies: number }>();
      return json({ ok: true, companies: row?.companies ?? 0 });
    }

    if (url.pathname === "/api/companies") {
      // Portfolio companies are hidden from the ranking but still listed here with their visibility.
      const { results } = await e.DB.prepare(
        `SELECT list_no, name, domain, category, last_round, round_closed, fit_tag, fit_visibility, greenfield_status,
                job_source_type, job_source_confidence, careers_url
           FROM companies ORDER BY list_no`,
      ).all();
      return json(results);
    }

    if (url.pathname === "/api/coverage") {
      const { results } = await e.DB.prepare(
        `SELECT job_source_type, COUNT(*) AS companies FROM companies GROUP BY job_source_type ORDER BY companies DESC`,
      ).all();
      return json(results);
    }

    if (url.pathname.startsWith("/api/")) return json({ error: "not found", routes: ["/api/run", "/api/health", "/api/companies", "/api/coverage"] }, 404);

    return e.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
