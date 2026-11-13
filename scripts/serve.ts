// Local server for the dashboard: serves public/ and runs the pipeline from the "Run now" button.
//   GET  /api/run  → { running, step, total, key, label, startedAt, finishedAt, ok, failedStep, log }
//   POST /api/run  → starts scripts/pipeline.ts (one run at a time); body {"dryRun": true} for a test run.
// Listens on 127.0.0.1 only. POST must be JSON, which forces a CORS preflight that this server never approves,
// so other websites open in the browser can't start a run.
// Usage: npm run serve   (PORT=4180 by default)
import { spawn } from "node:child_process";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";

const PORT = Number(process.env.PORT ?? 4180);
const ROOT = resolve("public");
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".json": "application/json; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

type RunState = { running: boolean; step: number; total: number; key: string; label: string; startedAt: string | null; finishedAt: string | null; ok: boolean | null; failedStep: string | null; dryRun: boolean; log: string[] };
const state: RunState = { running: false, step: 0, total: 0, key: "", label: "", startedAt: null, finishedAt: null, ok: null, failedStep: null, dryRun: false, log: [] };
const remember = (line: string) => { state.log.push(line.slice(0, 400)); if (state.log.length > 200) state.log.splice(0, state.log.length - 200); };

function startRun(dryRun: boolean) {
  Object.assign(state, { running: true, step: 0, total: 0, key: "", label: "Starting…", startedAt: new Date().toISOString(), finishedAt: null, ok: null, failedStep: null, dryRun, log: [] });
  const child = spawn("npx", ["tsx", "scripts/pipeline.ts", ...(dryRun ? ["--dry-run"] : [])], { stdio: ["ignore", "pipe", "pipe"] });
  const onData = (buf: Buffer) => {
    for (const line of buf.toString().split(/\r?\n/)) {
      if (!line.trim()) continue;
      const m = line.match(/^::step (\d+)\/(\d+) (\S+) (.*)$/);
      if (m) { Object.assign(state, { step: Number(m[1]), total: Number(m[2]), key: m[3], label: m[4] }); remember(`— ${m[4]}`); continue; }
      const d = line.match(/^::done (ok|failed)(?: (\S+))?/);
      if (d) { state.ok = d[1] === "ok"; state.failedStep = d[2] ?? null; continue; }
      remember(line);
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("close", (code) => { state.running = false; state.finishedAt = new Date().toISOString(); if (state.ok === null) state.ok = code === 0; console.log(`run finished: ${state.ok ? "ok" : "failed"}`); });
}

const send = (res: import("node:http").ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/api/run") {
    if (req.method === "GET") return send(res, 200, state);
    if (req.method === "POST") {
      if (!(req.headers["content-type"] ?? "").startsWith("application/json")) return send(res, 415, { error: "JSON only" });
      if (state.running) return send(res, 409, { error: "A run is already in progress", state });
      let body = "";
      req.on("data", (c) => { body += c; if (body.length > 1000) req.destroy(); });
      req.on("end", () => { let dry = false; try { dry = !!JSON.parse(body || "{}").dryRun; } catch { /* default */ } startRun(dry); send(res, 202, state); });
      return;
    }
    return send(res, 405, { error: "GET or POST" });
  }
  // Static files from public/ (no directory escapes).
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "") || "index.html";
  const file = join(ROOT, rel);
  if (!file.startsWith(ROOT) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end("Not found"); return; }
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
  createReadStream(file).pipe(res);
}).listen(PORT, "127.0.0.1", () => console.log(`Growth Signals on http://localhost:${PORT}  (Run now button enabled)`));
