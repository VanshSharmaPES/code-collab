import assert from "node:assert/strict";
import { test } from "node:test";
import { isJsonContentType, readLimitedBody } from "./request-body";

const LIMIT = 4096;

function post(body: BodyInit | null, headers: Record<string, string> = {}) {
  return new Request("http://localhost/x", { method: "POST", body, headers });
}

test("accepts application/json with or without parameters, case-insensitively", () => {
  for (const value of [
    "application/json",
    "application/json; charset=utf-8",
    "application/json;charset=UTF-8",
    "  Application/JSON ; charset=utf-8",
  ]) {
    assert.equal(isJsonContentType(value), true, value);
  }
});

test("rejects other media types and a missing header", () => {
  for (const value of [
    null,
    "",
    "text/plain",
    "application/x-www-form-urlencoded",
    "multipart/form-data; boundary=x",
    "application/jsonp",
    "application/json-patch+json",
    "application/vnd.api+json",
    "text/plain; application/json",
    "x/application/json",
  ]) {
    assert.equal(isJsonContentType(value), false, String(value));
  }
});

test("reads a body within the limit, including exactly at the limit", async () => {
  assert.deepEqual(await readLimitedBody(post('{"a":1}'), LIMIT), { ok: true, text: '{"a":1}' });
  assert.deepEqual(await readLimitedBody(post("x".repeat(LIMIT)), LIMIT), { ok: true, text: "x".repeat(LIMIT) });
  assert.deepEqual(await readLimitedBody(post(null), LIMIT), { ok: true, text: "" });
});

test("rejects a body over the limit when Content-Length is absent", async () => {
  const result = await readLimitedBody(post("x".repeat(LIMIT + 1)), LIMIT);
  assert.deepEqual(result, { ok: false, reason: "too-large" });
});

test("rejects early on a declared Content-Length over the limit", async () => {
  const request = post("small", { "content-length": String(LIMIT + 1) });
  assert.deepEqual(await readLimitedBody(request, LIMIT), { ok: false, reason: "too-large" });
});

test("a false small Content-Length does not bypass the limit", async () => {
  const request = post("x".repeat(LIMIT * 2), { "content-length": "5" });
  assert.deepEqual(await readLimitedBody(request, LIMIT), { ok: false, reason: "too-large" });
});

test("ignores a malformed Content-Length and still enforces the limit", async () => {
  const bad = { "content-length": "abc" };
  assert.deepEqual(await readLimitedBody(post("ok", bad), LIMIT), { ok: true, text: "ok" });
  assert.deepEqual(await readLimitedBody(post("x".repeat(LIMIT + 1), bad), LIMIT), {
    ok: false,
    reason: "too-large",
  });
});

test("counts bytes, not characters", async () => {
  // 3000 two-byte characters: 3000 chars but 6000 bytes.
  const result = await readLimitedBody(post("é".repeat(3000)), LIMIT);
  assert.deepEqual(result, { ok: false, reason: "too-large" });
  assert.deepEqual(await readLimitedBody(post("é".repeat(2048)), LIMIT), { ok: true, text: "é".repeat(2048) });
});

test("stops reading a long stream soon after the limit", async () => {
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 1;
      controller.enqueue(new Uint8Array(1024));
      if (pulled >= 1000) controller.close();
    },
  });
  const request = new Request("http://localhost/x", { method: "POST", body: stream, duplex: "half" } as RequestInit);
  assert.deepEqual(await readLimitedBody(request, LIMIT), { ok: false, reason: "too-large" });
  assert.ok(pulled < 20, `read ${pulled} chunks, expected it to stop early`);
});
