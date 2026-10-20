import assert from "node:assert/strict";
import { test } from "node:test";
import { noStoreJson } from "./auth-response";

test("success and error responses are marked no-store", async () => {
  for (const [body, status] of [[{ ok: true }, 200], [{ error: "x" }, 401], [{ error: "y" }, 500]] as const) {
    const response = noStoreJson(body, status);
    assert.equal(response.status, status);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    assert.deepEqual(await response.json(), body);
  }
});

test("status defaults to 200", () => {
  assert.equal(noStoreJson({}).status, 200);
});
