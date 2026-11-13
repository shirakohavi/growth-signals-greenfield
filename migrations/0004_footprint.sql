-- Step 5: footprint (BUILD_BRIEF §5 "Footprint, every company, every run").

-- Every URL seen in a company's sitemap, so each run can diff against the last ("new URLs vs last run").
CREATE TABLE site_pages (
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  url        TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('partner', 'country', 'industry', 'careers', 'news', 'about', 'other')),
  lastmod    DATE,
  first_seen DATE NOT NULL,
  last_seen  DATE NOT NULL,
  PRIMARY KEY (company_id, url)
);
CREATE INDEX idx_site_pages_kind ON site_pages (company_id, kind, first_seen);

-- News items already looked at, so each article is triaged / read once.
CREATE TABLE news_items (
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  url        TEXT NOT NULL,              -- original article URL (not the aggregator redirect)
  title      TEXT,
  source     TEXT,
  lang       TEXT,                       -- en | he
  published  DATE,
  verdict    TEXT,                       -- AI triage: signal type, 'other_news' or 'not_this_company'
  read_status TEXT,                      -- read | headline_only (article blocked) | skipped
  seen_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (company_id, url)
);

-- The same event must not be stored twice when a page or article is re-read on a later run.
ALTER TABLE footprint ADD COLUMN dedupe_key TEXT;
CREATE UNIQUE INDEX idx_footprint_dedupe ON footprint (company_id, dedupe_key, is_dummy) WHERE dedupe_key IS NOT NULL;
