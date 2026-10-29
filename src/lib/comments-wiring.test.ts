import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

test("the comment action checks the session itself and never takes the author from the form", () => {
  const src = read("../app/comments/actions.ts");
  assert.match(src, /await requireSession\(\)/);
  assert.match(src, /session\.userId/);
  assert.doesNotMatch(src, /get\("author/);
});

test("comment text is rendered as an escaped React child, never as raw HTML", () => {
  assert.doesNotMatch(read("../app/comments/comment-thread.tsx"), /dangerouslySetInnerHTML/);
});

test("both detail pages show the thread for their own, already authorized, row", () => {
  assert.match(read("../app/issues/[id]/page.tsx"), /<CommentThread targetType="issue" targetId=\{issue\.id\}/);
  assert.match(read("../app/pull-requests/[id]/page.tsx"), /<CommentThread targetType="pull_request" targetId=\{pr\.id\}/);
});
