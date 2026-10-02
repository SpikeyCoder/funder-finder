// Run: deno test supabase/functions/request-organization/
import { assertEquals } from "jsr:@std/assert@1";
import { validate } from "./index.ts";

Deno.test("validate cleans and accepts a full request", () => {
  assertEquals(
    validate({ name: "  Students\tFeeding   Students ", ein: "86-3739484", state: "hi", email: " A@B.org " }),
    { query: "Students Feeding Students", ein: "863739484", state: "HI", requester_email: "a@b.org" },
  );
});

Deno.test("validate treats blank optional fields as absent", () => {
  assertEquals(validate({ name: "Sit Stay Read", ein: "", state: " ", email: "" }), {
    query: "Sit Stay Read", ein: null, state: null, requester_email: null,
  });
});

Deno.test("validate rejects bad input", () => {
  assertEquals(validate(null), "Invalid request body");
  assertEquals(validate({ name: "x" }), "Organization name must be 2–200 characters");
  assertEquals(validate({ name: "a".repeat(201) }), "Organization name must be 2–200 characters");
  assertEquals(validate({ name: "Org", ein: "12345" }), "EIN must be 9 digits");
  assertEquals(validate({ name: "Org", state: "Washington" }), "State must be a 2-letter code");
  assertEquals(validate({ name: "Org", email: "not-an-email" }), "Invalid email address");
});
