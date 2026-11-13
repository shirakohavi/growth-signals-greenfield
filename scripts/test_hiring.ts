// Regression cases for hiring-statement detection, from real pages seen in step 1 (11–12 Nov 2026).
// Run: npm test
import { findHiringStatement } from "../src/lib/hiring.ts";

const cases: { name: string; html: string; expect: "strong" | "weak" | "none"; linkedIn?: boolean }[] = [
  {
    name: "Rein /about-us: careers@ email, no careers link (missed before 11 Nov)",
    html: `<h2>Join The Rein Universe</h2><p>We're actively recruiting for both go-to-market and engineering roles. If you like what we do, reach out. <a href="mailto:careers@reinsec.io">careers@reinsec.io</a></p>`,
    expect: "strong",
  },
  {
    name: "Hush /about: 'Send your CV' button -> careers@ (missed before 11 Nov)",
    html: `<span>CAREERS</span><h2>Exceptional People Build Exceptional Things. Join us.</h2><p>From security engineering to go-to-market, we're growing fast.</p><a href="mailto:careers@hush.security">Send your CV</a>`,
    expect: "strong",
  },
  {
    name: "ZutaCore /careers/: listings only on LinkedIn",
    html: `<h1>CAREERS</h1><p>You are going to love working with us.</p><p>VISIT OUR LINKEDIN PAGE FOR OUR OPEN POSITIONS</p>`,
    expect: "weak",
    linkedIn: true,
  },
  {
    name: "Phytolon /careers: 'Open Positions' heading over an empty list",
    html: `<h2>Open Positions</h2><a>View all</a><a>R&amp;D Team</a><p>Sorry, no open positions at the moment.</p>`,
    expect: "none",
  },
  {
    name: "Webinar banner 'Join us' is not hiring",
    html: `<a href="/webinar">Webinar: How many AI agents are in your environment? Join us →</a>`,
    expect: "none",
  },
  {
    name: "Generic contact email is not a careers email",
    html: `<a href="mailto:info@example.com">Contact us</a>`,
    expect: "none",
  },
];

let failed = 0;
for (const c of cases) {
  const s = findHiringStatement(c.html);
  const got = !s ? "none" : s.strong ? "strong" : "weak";
  const ok = got === c.expect && (c.linkedIn === undefined || s?.listingsOnLinkedIn === c.linkedIn);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.name}  (got ${got}${s?.listingsOnLinkedIn ? ", linkedin" : ""}${s?.email ? `, ${s.email}` : ""})`);
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exitCode = failed ? 1 : 0;
