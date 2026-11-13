-- Step 4: one AI call per changed page (brief §6). Unchanged page text (same hash) reuses the last extraction.
CREATE TABLE page_extractions (
  url            TEXT PRIMARY KEY,
  company_id     INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  content_hash   TEXT NOT NULL,
  extracted_json TEXT NOT NULL,     -- the model's JSON output (jobs only: titles, function, seniority, country)
  model          TEXT NOT NULL,
  extracted_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
