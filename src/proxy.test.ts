import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { config, proxy } from "./proxy";

test("the proxy guards the dashboard, contributions and the other signed-in pages", () => {
  for (const path of ["/dashboard", "/contributions", "/contributions/:path*", "/issues", "/pull-requests", "/users"]) assert.ok(config.matcher.includes(path), path);
});

test("a visitor without a session cookie is redirected to the home page before anything is rendered", async () => {
  const res = await proxy(new NextRequest("http://localhost/dashboard"));
  assert.equal(res.status, 307);
  assert.equal(new URL(res.headers.get("location") ?? "").pathname, "/");
});

test("a garbage session cookie is treated as no session", async () => {
  const res = await proxy(new NextRequest("http://localhost/dashboard", { headers: { cookie: "cc_session=not-a-token" } }));
  assert.equal(res.status, 307);
});
