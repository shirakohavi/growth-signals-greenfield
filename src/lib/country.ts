// Location text -> ISO 3166-1 alpha-2, for the cases ATS boards give us as free text.
// Unknown stays null; step 4's AI pass fills the rest. Runs in Node and Workers (no I/O).

const NAMES: Record<string, string> = {
  "israel": "IL", "united states": "US", "united states of america": "US", "usa": "US", "us": "US", "u.s.": "US",
  "united kingdom": "GB", "uk": "GB", "england": "GB", "scotland": "GB", "germany": "DE", "deutschland": "DE",
  "france": "FR", "spain": "ES", "italy": "IT", "netherlands": "NL", "the netherlands": "NL", "belgium": "BE",
  "ireland": "IE", "portugal": "PT", "poland": "PL", "sweden": "SE", "denmark": "DK", "norway": "NO",
  "finland": "FI", "switzerland": "CH", "austria": "AT", "czech republic": "CZ", "czechia": "CZ", "romania": "RO",
  "greece": "GR", "canada": "CA", "mexico": "MX", "brazil": "BR", "argentina": "AR", "colombia": "CO", "chile": "CL",
  "peru": "PE", "india": "IN", "singapore": "SG", "japan": "JP", "south korea": "KR", "korea": "KR",
  "australia": "AU", "new zealand": "NZ", "china": "CN", "hong kong": "HK", "taiwan": "TW", "philippines": "PH",
  "vietnam": "VN", "thailand": "TH", "indonesia": "ID", "malaysia": "MY", "united arab emirates": "AE", "uae": "AE",
  "saudi arabia": "SA", "south africa": "ZA", "turkey": "TR", "ukraine": "UA", "cyprus": "CY", "bulgaria": "BG",
  "serbia": "RS", "hungary": "HU", "estonia": "EE", "lithuania": "LT", "latvia": "LV", "luxembourg": "LU", "malta": "MT",
};

const CITIES: Record<string, string> = {
  "tel aviv": "IL", "tel-aviv": "IL", "tel aviv-yafo": "IL", "herzliya": "IL", "ramat gan": "IL", "jerusalem": "IL",
  "haifa": "IL", "petah tikva": "IL", "petach tikva": "IL", "rehovot": "IL", "netanya": "IL", "be'er sheva": "IL",
  "beer sheva": "IL", "ra'anana": "IL", "raanana": "IL", "hod hasharon": "IL", "yokneam": "IL", "kfar saba": "IL",
  "new york": "US", "nyc": "US", "san francisco": "US", "boston": "US", "austin": "US", "seattle": "US",
  "chicago": "US", "los angeles": "US", "miami": "US", "atlanta": "US", "denver": "US", "dallas": "US",
  "washington": "US", "washington dc": "US", "palo alto": "US", "mountain view": "US", "san jose": "US",
  "cupertino": "US", "sunnyvale": "US", "richmond": "US", "philadelphia": "US",
  "london": "GB", "manchester": "GB", "berlin": "DE", "munich": "DE", "frankfurt": "DE", "hamburg": "DE",
  "paris": "FR", "madrid": "ES", "barcelona": "ES", "milan": "IT", "amsterdam": "NL", "dublin": "IE",
  "lisbon": "PT", "warsaw": "PL", "stockholm": "SE", "zurich": "CH", "toronto": "CA", "vancouver": "CA",
  "sao paulo": "BR", "são paulo": "BR", "bangalore": "IN", "bengaluru": "IN", "tokyo": "JP", "sydney": "AU",
  "melbourne": "AU", "copenhagen": "DK", "malta": "MT", "dubai": "AE", "abu dhabi": "AE", "riyadh": "SA", "kyiv": "UA", "singapore": "SG",
};

const US_STATES = new Set(["AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA",
  "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI",
  "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "DC"]);
const US_STATE_NAMES = /\b(california|new york|texas|florida|massachusetts|washington state|illinois|colorado|georgia|virginia|north carolina|new jersey|pennsylvania|ohio|michigan|arizona|oregon|utah|tennessee|minnesota|maryland)\b/i;

const ISO = new Set([...Object.values(NAMES), ...Object.values(CITIES)]);

const ADDRESS_PART = /\d|\b(st|street|rd|road|ave|avenue|blvd|boulevard|broadway|floor|fl|suite|ste|building|bldg|entrance|derech|dereck|rehov|po box|p\.o\.)\b\.?/i;

/** Location for storage: city / state / country only. Street addresses, floors, zip codes are dropped (privacy rule). */
export function safeLocation(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 1 && !ADDRESS_PART.test(parts[0])) return parts[0];
  const kept = parts
    .map((p) => p.replace(/\s+\d{4,6}(?:-\d{4})?$/, "")) // "MA 02142" -> "MA"
    .filter((p) => p && !ADDRESS_PART.test(p));
  return kept.length ? kept.join(", ") : null;
}

/** Best-effort ISO country from free text like "Tel Aviv, Israel", "Remote - US", "Austin, TX", "EMEA". */
export function toCountry(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (/^[A-Z]{2}$/.test(s)) return s === "UK" ? "GB" : s;               // already ISO ("IL", "US")
  if (/^remote[\s\-–(]*(us|usa|united states)\b/i.test(s) || /\bU\.?S\.? (?:west|east|central)\b/i.test(s)) return "US";
  const lower = s.toLowerCase();
  // Longest names first so "united states" wins over "us".
  for (const [name, iso] of Object.entries(NAMES).sort((a, b) => b[0].length - a[0].length)) {
    if (new RegExp(`(^|[^a-z])${name.replace(/[.]/g, "\\.")}([^a-z]|$)`, "i").test(lower)) return iso;
  }
  for (const [city, iso] of Object.entries(CITIES)) if (lower.includes(city)) return iso;
  const st = s.match(/,\s*([A-Z]{2})\b/);                                 // "Austin, TX"
  if (st && US_STATES.has(st[1])) return "US";
  if (US_STATE_NAMES.test(s)) return "US";
  const tail = s.match(/,\s*([A-Z]{2})\s*$/);                             // "Berlin, DE"
  if (tail && ISO.has(tail[1])) return tail[1];
  return null;                                                            // "EMEA", "Remote", "Hybrid": leave to step 4
}
