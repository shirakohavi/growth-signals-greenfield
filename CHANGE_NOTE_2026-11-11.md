# Change note: company list rebuilt (11 Nov 2026)

Read this before continuing the build. `BUILD_BRIEF.md` and `data/companies.csv` were updated today; this note says what changed and what to redo.

## Why

The list is now modelled on Greenfield's own portfolio (greenfield-growth.com/portfolio): its five categories and the stages it actually invests at. The old list was built from general funding news and had too many fresh Series A companies and off-thesis sectors.

## What changed in `data/companies.csv`

- Still 41 rows, but **16 companies removed and 16 added**.
- **New columns:** `Greenfield category` (3rd) and `Fit tag` (8th). Column order is now:
  `#, Company, Greenfield category, Sector, Latest round, Amount ($M), Round date, Fit tag, Greenfield status, Role in the list, Why included, Known jobs source, Website`
- Update any code that reads the CSV by column position.

**Removed:** Ocean, Rein Security, Pluto Security, Jazz, Reclaim Security, Hush Security, Above Security, Mave, Slice, Encore AI, Bites, enso (Series A < 12 months, outside deep tech) · Loora, BloomX (off-thesis sectors) · Torii, Chargeflow (acquired / stage unverified).

**Added:** Daylight, MIND, Upwind (cyber) · PointFive, Majestic Labs (AI infra) · Xtend, Classiq, Quantum Art, ZutaCore, Limitless Labs, Orca AI, Prisma Photonics (deep tech) · PhaseV (vertical AI) · Faye, IVIX, Parametrix (fintech).

**Unchanged test cases:** Onyx, Zenzap, Airis Labs, Grain, AI21 Labs, Capitolis (portfolio), Oasis (acquired), Wonderful (too late), Phytolon (off-thesis test). Expected results in BUILD_BRIEF §14 still apply.

## What changed in `BUILD_BRIEF.md`

- **§3:** new columns; conflict flags are now Linx, Oasis, Daylight, Upwind, groundcover, Xtend, Limitless Labs.
- **§8 fit tags:**
  - *In mandate* = Series B or C, **or Series A in deep tech**
  - *Pre-Series B* / *Too early* apply only **outside deep tech**
  - *Too late* now includes a $1B+ valuation
  - New tag **Off-thesis** = outside the five categories (Cybersecurity, AI infrastructure, Deep tech, Vertical AI, Fintech) → shown last, flagged
- **§16:** the 16 new companies need websites and job sources.

## What to do now

1. **Re-run step 1 (job-source check) for the new list.** These files were built from the old list and must be regenerated: `data/company_domains.csv`, `data/job_sources.csv`, `data/job_sources.json`, `data/job_sources_report.md`.
   - Keep `data/job_sources_overrides.csv` rows for companies still on the list; drop rows for the 16 removed companies.
   - Reuse cached results in `data/cache/` for the 25 companies that stayed; only look up the 16 new ones.
2. **Update the fit-tag logic** to the new §8 rules, including `Off-thesis`. Use the `Greenfield category` column for sector fit.
3. **Show the new step-1 report and stop**, as before, before continuing with step 2.
4. Add a line to `AI_LOG.md`: "11 Nov: company list rebuilt to mirror Greenfield's portfolio; step 1 re-run."
