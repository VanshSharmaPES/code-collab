import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { assertSafeMongoTarget } from "./mongo-config";
import { parseWebMongoUrl } from "./mongo-url";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

test("the web app accepts its configured MongoDB URL, including a remote host in production", () => {
  assert.deepEqual(parseWebMongoUrl("mongodb://localhost:27017/codecollab"), { url: "mongodb://localhost:27017/codecollab", database: "codecollab" });
  assert.equal(parseWebMongoUrl("mongodb://u:p@db.example.com:27017/appdb?authSource=admin").database, "appdb");
  assert.equal(parseWebMongoUrl("mongodb+srv://u:p@cluster.example.com/codecollab").database, "codecollab");
});

test("a missing or invalid MONGO_URL fails clearly, and the message never contains the URL or its password", () => {
  const secret = "hunter2-secret";
  for (const raw of [undefined, "", "   ", "not a url", `mongodb://u:${secret}@h/ db`, `http://u:${secret}@h/codecollab`, `mongodb://u:${secret}@h`, `mongodb://u:${secret}@h/`, `mongodb://u:${secret}@h/a/b`, `mongodb://u:${secret}@h/%E0%A4%A`]) {
    assert.throws(() => parseWebMongoUrl(raw), (e: Error) => /^MongoDB is not configured: /.test(e.message) && !e.message.includes(secret) && !e.message.includes("@h"));
  }
});

test("the maintenance-script guard is unchanged: it still refuses production, remote hosts and other databases", () => {
  const ok = { MONGO_URL: "mongodb://localhost:27017/codecollab" };
  assert.equal(assertSafeMongoTarget(ok).database, "codecollab");
  assert.throws(() => assertSafeMongoTarget({ ...ok, NODE_ENV: "production" }), /NODE_ENV is production/);
  assert.throws(() => assertSafeMongoTarget({ MONGO_URL: "mongodb://db.example.com/codecollab" }), /single local address/);
  assert.throws(() => assertSafeMongoTarget({ MONGO_URL: "mongodb://localhost/other" }), /must be named/);
  assert.throws(() => assertSafeMongoTarget({}), /MONGO_URL is not set/);
});

test("the web client uses the web parser, never the script guard, and the scripts never use the web parser", () => {
  assert.match(read("./mongo.ts"), /parseWebMongoUrl/);
  assert.doesNotMatch(read("./mongo.ts"), /assertSafeMongoTarget/);
  assert.doesNotMatch(read("./comments-server.ts"), /assertSafeMongoTarget/);
});

test("the comments load behind a Suspense boundary with a loading fallback and their own error state", () => {
  const src = read("../app/comments/comment-thread.tsx");
  assert.match(src, /<Suspense fallback=\{[^]*Loading comments/);
  assert.match(src, /<CommentThreadContent \{\.\.\.props\} \/>/);
  assert.match(src, /catch \(err\)[^]*failed = true/);
  assert.match(src, /Comments could not be loaded right now/);
});
