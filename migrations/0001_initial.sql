-- Team Signals v1 schema (BUILD_BRIEF §4), with the fields step 1 showed we need.
-- Privacy: roles and counts only. Never store people's names or photos.


CREATE TABLE companies (
  id                    INTEGER PRIMARY KEY,
  list_no               INTEGER,                      -- "#" column in data/companies.csv
  name                  TEXT NOT NULL,
  domain                TEXT NOT NULL UNIQUE,         -- identity key: match on domain (+ HQ), never on name alone
  hq                    TEXT,
  category              TEXT,                         -- Greenfield category: Cybersecurity | AI infrastructure | Deep tech | Vertical AI | Fintech | Off-thesis
  sector                TEXT,
  last_round            TEXT,                         -- e.g. "Series B", "Series A (extended)", "Growth"
  round_amount          TEXT,                         -- as given, e.g. "33 (44 total)" ($M)
  round_closed          DATE,                         -- YYYY-MM-01 when only the month is known
  round_announced       DATE,
  greenfield_status     TEXT NOT NULL DEFAULT 'open'
                        CHECK (greenfield_status IN ('open', 'portfolio', 'conflict')),
  greenfield_note       TEXT,                         -- e.g. "identity security; overlaps Silverfort"
  fit_tag               TEXT CHECK (fit_tag IN ('In mandate', 'Pre-Series B', 'Too early', 'Too late', 'Portfolio', 'Off-thesis')),
  fit_visibility        TEXT CHECK (fit_visibility IN ('ranked', 'ranked_marked', 'watchlist', 'hidden', 'ranked_last')),
  fit_reason            TEXT,
  role_in_list          TEXT,                         -- Core | Test case
  why_included          TEXT,
  job_source_type       TEXT NOT NULL DEFAULT 'none'
                        CHECK (job_source_type IN ('greenhouse', 'lever', 'ashby', 'comeet', 'workable', 'getro',
                                                   'careers_page', 'hiring_statement', 'aggregator', 'none')),
  job_source_url        TEXT,                         -- Comeet: token is NOT stored here (read from the careers page at collect time)
  ats_slug              TEXT,
  careers_url           TEXT,
  job_source_confidence TEXT CHECK (job_source_confidence IN ('high', 'medium', 'low')),
  needs_rendering       INTEGER NOT NULL DEFAULT 0,
  job_source_notes      TEXT,
  headcount             INTEGER,
  headcount_source      TEXT,
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per company per pipeline run.
CREATE TABLE snapshots (
  id              INTEGER PRIMARY KEY,
  company_id      INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  run_date        DATE NOT NULL,
  sources_checked TEXT,                               -- JSON: {source: "ok"|"empty"|"failed"|"not_checked"}
  coverage        TEXT CHECK (coverage IN ('full', 'partial', 'low')),
  open_jobs       INTEGER,                            -- count seen this run (NULL = no listings, e.g. hiring_statement)
  is_dummy        INTEGER NOT NULL DEFAULT 0,
  UNIQUE (company_id, run_date, is_dummy)
);

CREATE TABLE jobs (
  id            INTEGER PRIMARY KEY,
  company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  source        TEXT NOT NULL,                        -- greenhouse | lever | ashby | comeet | getro | careers_page | aggregator
  source_job_id TEXT NOT NULL,                        -- ATS id, or a stable hash of normalised title+location for scraped pages
  title         TEXT NOT NULL,
  function      TEXT,                                 -- e.g. engineering | gtm | product | ops (AI-classified in step 4)
  seniority     TEXT,
  country       TEXT,
  url           TEXT,
  posted_date   DATE,
  first_seen    DATE NOT NULL,
  last_seen     DATE NOT NULL,
  is_open       INTEGER NOT NULL DEFAULT 1,
  is_baseline   INTEGER NOT NULL DEFAULT 0,           -- open at the first run: existed before we started watching
  is_dummy      INTEGER NOT NULL DEFAULT 0,
  UNIQUE (company_id, source, source_job_id)
);

CREATE TABLE footprint (
  id         INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  run_date   DATE NOT NULL,
  type       TEXT NOT NULL CHECK (type IN ('news', 'new_page', 'office', 'plan', 'validation', 'layoff', 'round', 'hiring_statement')),
  value      TEXT,
  event_date DATE,
  source_url TEXT,
  evidence   TEXT CHECK (evidence IN ('direct', 'indirect')),
  is_dummy   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE scores (
  company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  run_date      DATE NOT NULL,
  score         INTEGER,
  band          TEXT,                                 -- Strong | Some activity | Quiet
  fit_tag       TEXT,
  coverage      TEXT,
  decline_flag  INTEGER NOT NULL DEFAULT 0,
  reason        TEXT,
  signals_json  TEXT,
  PRIMARY KEY (company_id, run_date)
);

CREATE INDEX idx_jobs_company_open ON jobs (company_id, is_open);
CREATE INDEX idx_jobs_first_seen   ON jobs (company_id, first_seen);
CREATE INDEX idx_snapshots_company ON snapshots (company_id, run_date);
CREATE INDEX idx_footprint_company ON footprint (company_id, run_date);
CREATE INDEX idx_scores_run        ON scores (run_date, score DESC);
