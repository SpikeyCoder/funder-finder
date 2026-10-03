// Run: deno test supabase/functions/_shared/cron_auth_test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { cronAuthorized } from "./cron_auth.ts";

Deno.test("cronAuthorized fails closed and accepts both header forms", () => {
  const req = (h: Record<string, string>) => new Request("https://x", { method: "POST", headers: h });
  assertEquals(cronAuthorized(req({ "x-cron-secret": "s3cret" }), ""), false);
  assertEquals(cronAuthorized(req({}), "s3cret"), false);
  assertEquals(cronAuthorized(req({ "x-cron-secret": "wrong!" }), "s3cret"), false);
  assertEquals(cronAuthorized(req({ "x-cron-secret": "s3cret" }), "s3cret"), true);
  assertEquals(cronAuthorized(req({ authorization: "Bearer cron:s3cret" }), "s3cret"), true);
});
