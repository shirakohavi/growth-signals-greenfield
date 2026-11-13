-- Step 3: fields the ATS collectors return.
-- source_updated: the ATS "last updated" time. Comeet has no posted date, only time_updated, which is NOT a
-- posting date (an old role edited today would look new), so it lives here and posted_date stays NULL.
-- location: city/region name only. Never street addresses or building details (Comeet returns entrance codes).
ALTER TABLE jobs ADD COLUMN department TEXT;
ALTER TABLE jobs ADD COLUMN location TEXT;
ALTER TABLE jobs ADD COLUMN is_remote INTEGER;
ALTER TABLE jobs ADD COLUMN source_updated TEXT;

-- Per-source fetch state, so a failed fetch keeps the last data and can be retried (brief §5: 1 / 5 / 30 min).
CREATE TABLE source_state (
  company_id   INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  source       TEXT NOT NULL,
  last_status  TEXT NOT NULL CHECK (last_status IN ('ok', 'empty', 'failed', 'not_reached')),
  last_ok_date DATE,
  last_error   TEXT,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (company_id, source)
);
