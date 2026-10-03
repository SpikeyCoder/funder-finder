// Run: deno test supabase/functions/process-organization-requests/
import { assertEquals } from "jsr:@std/assert@1";
import {
  cronAuthorized,
  type IrsOrg,
  type Outcome,
  normalizeName,
  notificationFor,
  pickExactMatch,
  type QueueRow,
  reviewCardFor,
  reviewReason,
} from "./index.ts";
import { padEin } from "../_shared/ein.ts";

const org = (name: string, state: string | null = "WA", ein = "123456789"): IrsOrg =>
  ({ ein, name, city: "Seattle", state, ntee_code: "B90" });

const row: QueueRow = { id: "r1", query: "Students Feeding Students", ein: null, state: null, requester_email: "a@b.org", attempts: 0 };

Deno.test("normalizeName folds case, punctuation, '&' and legal suffixes", () => {
  assertEquals(normalizeName("The Sit Stay Read, Inc."), "sit stay read");
  assertEquals(normalizeName("BOYS & GIRLS CLUB OF KING COUNTY"), "boys and girls club of king county");
  assertEquals(normalizeName("Habitat for Humanity International Inc"), "habitat for humanity international");
  assertEquals(normalizeName("The"), "the"); // never normalizes to empty
});

Deno.test("padEin zero-pads and strips formatting", () => {
  assertEquals(padEin(62618866), "062618866");
  assertEquals(padEin("86-3739484"), "863739484");
});

Deno.test("pickExactMatch refuses approximate names (the Trello #153 case)", () => {
  // Real ProPublica results for "Students Feeding Students" on 2026-10-02.
  const results = [org("Students Feeding Oahu Foundation", "HI"), org("Feedng And Teaching Students", "GA")];
  assertEquals(pickExactMatch("Students Feeding Students", null, results), null);
});

Deno.test("pickExactMatch accepts a unique normalized-equal name", () => {
  const hit = org("SIT STAY READ INC", "IL", "364368215");
  assertEquals(pickExactMatch("SitStay Read", null, [hit]), null); // camel-case is search's job, not ours
  assertEquals(pickExactMatch("Sit Stay Read", null, [org("Sit Stay Read Foundation"), hit]), hit);
});

Deno.test("pickExactMatch uses the requested state to break same-name ties", () => {
  const wa = org("Community Food Bank", "WA", "111111111");
  const or = org("Community Food Bank", "OR", "222222222");
  assertEquals(pickExactMatch("Community Food Bank", null, [wa, or]), null);
  assertEquals(pickExactMatch("Community Food Bank", "OR", [wa, or]), or);
});

Deno.test("cronAuthorized fails closed and accepts both header forms", () => {
  const req = (h: Record<string, string>) => new Request("https://x", { method: "POST", headers: h });
  assertEquals(cronAuthorized(req({ "x-cron-secret": "s3cret" }), ""), false);
  assertEquals(cronAuthorized(req({}), "s3cret"), false);
  assertEquals(cronAuthorized(req({ "x-cron-secret": "wrong!" }), "s3cret"), false);
  assertEquals(cronAuthorized(req({ "x-cron-secret": "s3cret" }), "s3cret"), true);
  assertEquals(cronAuthorized(req({ authorization: "Bearer cron:s3cret" }), "s3cret"), true);
});

Deno.test("notificationFor links to the right page and acknowledges a review", () => {
  const added = notificationFor(row, { status: "added", id: "uuid-1", org: org("X") });
  assertEquals(added?.text.includes("https://fundermatch.org/recipient/uuid-1"), true);
  const funder = notificationFor(row, { status: "already_listed", entityType: "funder", id: "562618866", org: org("Gates") });
  assertEquals(funder?.text.includes("https://fundermatch.org/funder/562618866"), true);
  assertEquals(
    notificationFor(row, { status: "needs_review", reason: "x", candidates: [] })?.subject,
    "We're reviewing your organization request",
  );
  assertEquals(notificationFor(row, { status: "not_found" })?.subject, "We couldn't find the organization you requested");
});

Deno.test("notificationFor never quotes the visitor's text (unconfirmed recipient)", () => {
  const spam = { ...row, query: "Your account is suspended, visit evil.example" };
  const outcomes: Outcome[] = [
    { status: "added", id: "u", org: org("REAL ORG") },
    { status: "already_listed", entityType: "recipient", id: "u", org: org("REAL ORG") },
    { status: "needs_review", reason: "x", candidates: [] },
    { status: "not_found" },
  ];
  for (const o of outcomes) {
    const note = notificationFor(spam, o);
    assertEquals(`${note?.subject} ${note?.text}`.includes("evil.example"), false, o.status);
  }
});

Deno.test("reviewCardFor lists candidates with ProPublica links", () => {
  const card = reviewCardFor(row, "no exact name match", [org("Students Feeding Oahu Foundation", "HI", "863739484")]);
  assertEquals(card.name, "[ORG REQUEST] Students Feeding Students");
  assertEquals(card.desc.includes("https://projects.propublica.org/nonprofits/organizations/863739484"), true);
  assertEquals(card.desc.includes("organization_requests.id = r1"), true);
});

Deno.test("reviewReason auto-adds only 501(c)(3) public charities", () => {
  assertEquals(reviewReason({ subsectionCode: 3, foundationCode: 15 }), null);
  assertEquals(reviewReason({ subsectionCode: 3, foundationCode: 4 }), "private foundation");
  assertEquals(reviewReason({ subsectionCode: 4, foundationCode: 0 }), "not a 501(c)(3) public charity");
  assertEquals(reviewReason({ subsectionCode: 6, foundationCode: null }), "not a 501(c)(3) public charity");
  assertEquals(reviewReason({ subsectionCode: 3, foundationCode: null }), "not a 501(c)(3) public charity");
  assertEquals(reviewReason({ subsectionCode: null, foundationCode: 15 }), "not a 501(c)(3) public charity");
});

Deno.test("not_found for an EIN request names the EIN, not 'request it with the EIN'", () => {
  const n = notificationFor({ ...row, ein: "123456789" }, { status: "not_found" });
  assertEquals(n?.text.includes("EIN 123456789"), true);
  assertEquals(n?.text.includes("request it again with the EIN"), false);
});

Deno.test("normalizeName folds accents instead of dropping letters", () => {
  assertEquals(normalizeName("Café Hope"), "cafe hope");
  assertEquals(normalizeName("Café Hope") === normalizeName("CAF HOPE INC"), false);
  assertEquals(normalizeName("Fundación Niños"), "fundacion ninos");
});

Deno.test("normalizeName drops apostrophes as IRS names do", () => {
  assertEquals(normalizeName("Children's Home Society"), normalizeName("CHILDRENS HOME SOCIETY"));
});
