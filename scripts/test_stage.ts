// Tests for time-based stage moves, recomputed on every run (BUILD_BRIEF §8).
// Run: npx tsx scripts/test_stage.ts
import { refreshTimeFit } from "../src/lib/fit.ts";

const checks: [string, boolean][] = [];
const check = (name: string, ok: boolean) => checks.push([name, ok]);
const co = (p: Partial<{ last_round: string; round_closed: string; category: string; fit_tag: string }>) =>
  ({ last_round: "Series A", round_closed: "2026-01-01", category: "Fintech", fit_tag: "Too early", ...p });
const day = (d: string) => new Date(`${d}T00:00:00Z`);

// A Series A closed Jan 2026 is Too early in Nov 2026, and becomes Approaching B in Jan 2027.
check("Series A at 10 months stays Too early", refreshTimeFit(co({}), day("2026-11-16")) === null);
const moved = refreshTimeFit(co({}), day("2027-01-20"));
check("Series A turning 12 months moves to Pre-Series B (Approaching B)", moved?.tag === "Pre-Series B" && moved.visibility === "ranked_marked");
check("the reason says how old the round is", moved?.reason === "Series A closed 12 months ago");

// Already Approaching B: nothing to change (also past 24 months, where the brief keeps it and flags it).
check("Pre-Series B at 15 months: no change", refreshTimeFit(co({ fit_tag: "Pre-Series B", round_closed: "2025-08-01" }), day("2026-11-16")) === null);
check("Pre-Series B at 30 months: no change", refreshTimeFit(co({ fit_tag: "Pre-Series B", round_closed: "2024-05-01" }), day("2026-11-16")) === null);

// Not time-based: deep tech Series A is In Range at any age; B/C and Past Stage never move with time.
check("deep tech Series A never moves", refreshTimeFit(co({ category: "Deep tech", fit_tag: "In mandate" }), day("2028-01-01")) === null);
check("Series B never moves", refreshTimeFit(co({ last_round: "Series B", fit_tag: "In mandate" }), day("2030-01-01")) === null);
check("Past Stage never moves", refreshTimeFit(co({ last_round: "Later stage", fit_tag: "Too late" }), day("2030-01-01")) === null);
check("unknown round date: no change", refreshTimeFit(co({ round_closed: "" }), day("2028-01-01")) === null);

let failed = 0;
for (const [name, ok] of checks) { console.log(`${ok ? "ok  " : "FAIL"} ${name}`); if (!ok) failed++; }
console.log(`${checks.length - failed}/${checks.length} passed`);
if (failed) process.exit(1);
