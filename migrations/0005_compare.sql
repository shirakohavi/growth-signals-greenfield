-- Step 6: compare runs (BUILD_BRIEF §7).
-- is_repost: a role that looks new but isn't (old posted_date, or the same role came back after closing).
-- Scoring counts a job as "new" only if is_baseline = 0 AND is_repost = 0.
ALTER TABLE jobs ADD COLUMN is_repost INTEGER NOT NULL DEFAULT 0;
