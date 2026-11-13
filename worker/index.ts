// Team Signals Worker. Step 2: read-only API over D1 to verify the schema and the binding.
// Collectors (steps 3–5), scoring (step 7) and the cron trigger (step 8) are added later.

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" },
  });

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      const row = await env.DB.prepare("SELECT COUNT(*) AS companies FROM companies").first<{ companies: number }>();
      return json({ ok: true, companies: row?.companies ?? 0 });
    }

    if (url.pathname === "/api/companies") {
      // Portfolio companies are hidden from the ranking but still listed here with their visibility.
      const { results } = await env.DB.prepare(
        `SELECT list_no, name, domain, category, last_round, round_closed, fit_tag, fit_visibility, greenfield_status,
                job_source_type, job_source_confidence, careers_url
           FROM companies ORDER BY list_no`,
      ).all();
      return json(results);
    }

    if (url.pathname === "/api/coverage") {
      const { results } = await env.DB.prepare(
        `SELECT job_source_type, COUNT(*) AS companies FROM companies GROUP BY job_source_type ORDER BY companies DESC`,
      ).all();
      return json(results);
    }

    return json({ error: "not found", routes: ["/api/health", "/api/companies", "/api/coverage"] }, 404);
  },
} satisfies ExportedHandler<Env>;
