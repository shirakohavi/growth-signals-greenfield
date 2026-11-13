// Detects an open "we're hiring" statement on a page that has no job listings,
// e.g. Rein's About page ("actively recruiting ... careers@reinsec.io") or Hush's ("Send your CV" -> careers@).
// That is still a hiring signal, just without role counts.

const CAREERS_EMAIL_RE = /mailto:\s*((?:careers?|jobs?|hr|talent|recruit\w*|hiring|people|cv|join(?:us)?)@[a-z0-9.-]+\.[a-z]{2,})/gi;
const STRONG_PHRASE_RE = /\b(we(?:'|’)?re (?:actively )?(?:hiring|recruiting)|we are (?:actively )?(?:hiring|recruiting)|actively recruiting|now hiring|send (?:us )?your (?:cv|resume)|open positions|open roles|join our team|join the team)\b/gi;
const NO_OPENINGS_RE = /\b(no (?:current |open )?(?:open )?(?:positions|openings|roles|vacancies|jobs)(?: available| at the moment| right now)?|not (?:currently )?hiring|there are (?:currently )?no (?:open )?(?:positions|openings|roles))\b/i;
const AREA_RE = /\b(engineering|r&d|go-to-market|gtm|sales|marketing|product|research|security engineering|customer success|operations|design|data)\b/gi;

export interface HiringStatement {
  email?: string;
  phrases: string[];
  areas: string[];
  excerpt: string;
  /** true = careers@ email or an explicit "hiring/recruiting/send your CV"; false = only "join our team"/"open positions". */
  strong: boolean;
  /** Listings live on LinkedIn ("visit our LinkedIn page for open positions"): we note it, never scrape LinkedIn. */
  listingsOnLinkedIn: boolean;
}

/** html: raw or rendered HTML (mailto links live in attributes); text: visible text if available. */
export function findHiringStatement(html: string, text = html.replace(/<[^>]+>/g, " ")): HiringStatement | null {
  const emails = [...html.matchAll(CAREERS_EMAIL_RE)].map((m) => m[1].toLowerCase());
  const flat = text.replace(/\s+/g, " ");
  // An explicit "no openings" message beats a heading like "Open Positions" over an empty list.
  if (!emails.length && NO_OPENINGS_RE.test(flat)) return null;
  // Drop negated hits: "no open positions", "not hiring", "there are currently no open roles".
  const phraseHits = [...flat.matchAll(STRONG_PHRASE_RE)]
    .filter((m) => !/\b(no|not|aren.t|isn.t|currently no|any)\s*(?:currently\s*)?$/i.test(flat.slice(Math.max(0, (m.index ?? 0) - 25), m.index)));
  if (!emails.length && !phraseHits.length) return null;
  // Areas: only from text near the hiring phrase, so "engineering" in a product blurb doesn't count.
  const at = phraseHits[0]?.index ?? flat.search(/careers?@|careers/i);
  const window = at >= 0 ? flat.slice(Math.max(0, at - 250), at + 350) : "";
  const areas = [...new Set([...window.matchAll(AREA_RE)].map((m) => m[1].toLowerCase()))];
  const phrases = [...new Set(phraseHits.map((m) => m[1].toLowerCase()))];
  return {
    email: emails[0],
    phrases,
    areas,
    excerpt: window.trim().slice(0, 240),
    strong: emails.length > 0 || phrases.some((p) => /hiring|recruiting|send/.test(p)),
    listingsOnLinkedIn: /linkedin[^.]{0,40}(open positions|open roles|jobs)|(open positions|open roles|jobs)[^.]{0,40}linkedin/i.test(flat),
  };
}

/** Same-site pages likely to hold a hiring section when there is no careers page. */
export const ABOUT_PATH_RE = /\/(about(?:-us)?|company|team|culture|who-we-are|our-story)\/?$/i;
