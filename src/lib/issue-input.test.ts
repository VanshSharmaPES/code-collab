import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_BODY_LENGTH, MAX_TITLE_LENGTH, parseId, parseIssueForm } from "./issue-input";

const form = (fields: Record<string, string>) => ({ get: (name: string) => fields[name] ?? null });
const valid = { repositoryId: "4", title: "  Crash on start  ", body: "line1\r\nline2", status: "in_progress", priority: "high" };

test("a valid form is trimmed and normalised", () => {
  const r = parseIssueForm(form(valid), { requireRepository: true });
  assert.ok(r.ok);
  assert.deepEqual(r.input, { title: "Crash on start", body: "line1\nline2", status: "in_progress", priority: "high" });
  assert.equal(r.repositoryId, "4");
});

test("status and priority default to open/medium; an empty body becomes NULL", () => {
  const r = parseIssueForm(form({ title: "x", body: "   " }), { requireRepository: false });
  assert.ok(r.ok);
  assert.deepEqual(r.input, { title: "x", body: null, status: "open", priority: "medium" });
  assert.equal(r.repositoryId, null);
});

test("invalid values are rejected with a message per field and the typed values are kept", () => {
  const r = parseIssueForm(form({ repositoryId: "0", title: "", body: "a\0b", status: "done", priority: "urgent" }), { requireRepository: true });
  assert.ok(!r.ok);
  assert.deepEqual(Object.keys(r.errors).sort(), ["body", "priority", "repositoryId", "status", "title"]);
  assert.equal(r.values.status, "done");
});

test("length limits and single-line titles", () => {
  assert.ok(!parseIssueForm(form({ title: "x".repeat(MAX_TITLE_LENGTH + 1) }), { requireRepository: false }).ok);
  assert.ok(parseIssueForm(form({ title: "x".repeat(MAX_TITLE_LENGTH) }), { requireRepository: false }).ok);
  assert.ok(!parseIssueForm(form({ title: "a\nb" }), { requireRepository: false }).ok);
  assert.ok(!parseIssueForm(form({ title: "x", body: "y".repeat(MAX_BODY_LENGTH + 1) }), { requireRepository: false }).ok);
});

test("the repository is only required when creating", () => {
  assert.ok(!parseIssueForm(form({ title: "x" }), { requireRepository: true }).ok);
  assert.ok(parseIssueForm(form({ title: "x" }), { requireRepository: false }).ok);
});

test("non-string form entries (files) are treated as empty", () => {
  const r = parseIssueForm({ get: () => new Blob(["x"]) }, { requireRepository: false });
  assert.ok(!r.ok);
});

test("parseId accepts only plain positive integers in bigint range", () => {
  for (const ok of ["1", "42", "999999999999999999"]) assert.equal(parseId(ok), ok);
  for (const bad of ["", "0", "01", "-1", "1.5", "1e3", " 1", "1 ", "9999999999999999999", "abc", "1;DROP"]) assert.equal(parseId(bad), null, bad);
});
