// Score over time for the dashboard. Real points come from the scores table (one per run). Until enough
// real runs exist, earlier points are back-filled from the seeded dummy snapshots: today's score scaled by
// that snapshot's open roles ÷ today's open roles (clamped 0–100), always marked dummy.

export type ScorePoint = { date: string; score: number; dummy: boolean };

export function scoreSeries(
  real: { run_date: string; score: number | null }[],
  snaps: { run_date: string; open_jobs: number | null; is_dummy: number | boolean }[],
  current: { date: string; score: number; open: number },
): ScorePoint[] {
  const pts = new Map<string, ScorePoint>();
  for (const r of real) if (r.score !== null) pts.set(r.run_date, { date: r.run_date, score: r.score, dummy: false });
  pts.set(current.date, { date: current.date, score: current.score, dummy: false });
  for (const s of snaps) {
    if (!s.is_dummy || pts.has(s.run_date) || s.run_date >= current.date) continue;
    const ratio = current.open > 0 && s.open_jobs !== null ? s.open_jobs / current.open : 1;
    pts.set(s.run_date, { date: s.run_date, score: Math.max(0, Math.min(100, Math.round(current.score * ratio))), dummy: true });
  }
  return [...pts.values()].sort((a, b) => a.date.localeCompare(b.date));
}
