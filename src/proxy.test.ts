import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { config, proxy } from "./proxy";

test("the proxy guards the dashboard, contributions and the other signed-in pages", () => {
  for (const path of ["/dashboard", "/contributions", "/contributions/:path*", "/issues", "/pull-requests", "/users"]) assert.ok(config.matcher.includes(path), path);
});

// Where the visitor is sent (the home page today, a login page later) is deliberately not pinned here: the test checks that a
// redirect to a page of this site happens and the dashboard is not rendered.
test("a visitor without a session cookie is redirected to the sign-in target before anything is rendered", async () => {
  const res = await proxy(new NextRequest("http://localhost/dashboard"));
  assert.equal(res.status, 307);
  const target = new URL(res.headers.get("location") ?? "");
  assert.equal(target.origin, "http://localhost", "the redirect stays on this site");
  assert.notEqual(target.pathname, "/dashboard", "it does not send the visitor back to the page they asked for");
});

test("a garbage session cookie is treated as no session", async () => {
  const res = await proxy(new NextRequest("http://localhost/dashboard", { headers: { cookie: "cc_session=not-a-token" } }));
  assert.equal(res.status, 307);
});
