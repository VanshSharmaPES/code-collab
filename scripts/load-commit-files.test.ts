import assert from "node:assert/strict";
import { test } from "node:test";
import { toCommitFilesDoc } from "./load-commit-files";

test("spool lines become commit_files documents: only known keys, bad lines skipped", () => {
  const line = JSON.stringify({
    repo: "pallets/flask", sha: "abc", committed_at: "2026-01-02T03:04:05Z", author_login: "someone", patch: "SECRET", author_email: "x@y.zz",
    files: [{ filename: "a.py", status: "modified", additions: 2, deletions: 1, changes: 3, previous_filename: null, patch: "@@ diff" }],
  });
  const doc = toCommitFilesDoc(line);
  assert.deepEqual(doc, {
    repo: "pallets/flask", sha: "abc", committedAt: new Date("2026-01-02T03:04:05Z"), authorLogin: "someone",
    files: [{ filename: "a.py", status: "modified", additions: 2, deletions: 1, changes: 3, previous_filename: null }],
  });
  assert.doesNotMatch(JSON.stringify(doc), /SECRET|@@|y\.zz/);
  for (const bad of ['{"repo":"a","sha"', "", "null", '{"repo":"a","sha":"b","committed_at":"nope","files":[]}', '{"repo":"a","sha":"b","committed_at":"2026-01-01","files":{}}']) {
    assert.equal(toCommitFilesDoc(bad), null, bad);
  }
});
