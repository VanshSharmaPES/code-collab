import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { SpoolLine } from "./ingest-data";
import { createFileSpool, spoolFileName } from "./ingest-spool";

// Scratch space inside the git-ignored tmp/ directory; removed after each test.
async function withTempDir(work: (dir: string) => Promise<void>) {
  await mkdir("tmp", { recursive: true });
  const dir = await mkdtemp(join("tmp", "test-spool-"));
  try {
    await work(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const line = (n: number): SpoolLine => ({
  repo: "o/r",
  sha: n.toString(16).padStart(40, "0"),
  committed_at: "2026-01-01T00:00:00Z",
  author_login: n % 2 ? "octocat" : null,
  files: [{ filename: `f${n}`, status: "added", additions: 1, deletions: 0, changes: 1, previous_filename: null }],
});

test("spoolFileName maps owner/name to a safe file name and rejects path tricks", () => {
  assert.equal(spoolFileName("pallets/flask"), "pallets__flask.commit-files.jsonl");
  for (const bad of ["../x/y", "a/../b", "/etc/passwd", "a/b/c", "a/.."]) assert.throws(() => spoolFileName(bad), /Invalid repository/, bad);
});

test("append writes one JSON line per commit; has() sees them; a new instance reloads them", async () => {
  await withTempDir(async (dir) => {
    const spool = createFileSpool(dir);
    assert.equal(await spool.has("o/r", line(1).sha), false);
    await spool.append("o/r", [line(1), line(2)]);
    assert.equal(await spool.has("o/r", line(1).sha), true);

    const text = await readFile(join(dir, "o__r.commit-files.jsonl"), "utf8");
    assert.deepEqual(text.trimEnd().split("\n").map((l) => JSON.parse(l)), [line(1), line(2)]);
    assert.ok(text.endsWith("\n"));

    const reopened = createFileSpool(dir);
    assert.equal(await reopened.has("o/r", line(2).sha), true);
    assert.equal(await reopened.has("o/r", line(3).sha), false);
  });
});

test("duplicates are never written twice, within a run or across runs", async () => {
  await withTempDir(async (dir) => {
    const spool = createFileSpool(dir);
    await spool.append("o/r", [line(1), line(1), line(2)]);
    await spool.append("o/r", [line(2)]);
    await createFileSpool(dir).append("o/r", [line(1), line(3)]);
    const lines = (await readFile(join(dir, "o__r.commit-files.jsonl"), "utf8")).trimEnd().split("\n");
    assert.equal(lines.length, 3);
  });
});

test("an interrupted half-written last line is ignored and appending still works", async () => {
  await withTempDir(async (dir) => {
    await createFileSpool(dir).append("o/r", [line(1)]);
    await appendFile(join(dir, "o__r.commit-files.jsonl"), '{"sha":"deadbeef", "files": [');
    const spool = createFileSpool(dir);
    assert.equal(await spool.has("o/r", line(1).sha), true);
    assert.equal(await spool.has("o/r", "deadbeef"), false);
  });
});

test("repositories get separate files, and nothing is created until something is appended", async () => {
  await withTempDir(async (dir) => {
    const spool = createFileSpool(dir);
    await spool.has("o/r", line(1).sha);
    assert.deepEqual(await readdir(dir), []);
    await spool.append("o/r", [line(1)]);
    await spool.append("p/q", [line(1)]);
    assert.deepEqual((await readdir(dir)).sort(), ["o__r.commit-files.jsonl", "p__q.commit-files.jsonl"]);
    await spool.append("o/r", []);
  });
});

test("lines written in the earlier format (no author_login) are still read, so reruns skip them", async () => {
  await withTempDir(async (dir) => {
    await appendFile(join(dir, "o__r.commit-files.jsonl"), JSON.stringify({ repo: "o/r", sha: line(5).sha, committed_at: "2026-01-01T00:00:00Z", files: [] }) + "\n");
    const spool = createFileSpool(dir);
    assert.equal(await spool.has("o/r", line(5).sha), true);
    await spool.append("o/r", [line(5), line(6)]);
    const lines = (await readFile(join(dir, "o__r.commit-files.jsonl"), "utf8")).trimEnd().split("\n");
    assert.equal(lines.length, 2, "the old line is not rewritten or duplicated");
    assert.ok(!("author_login" in JSON.parse(lines[0])), "existing lines are left exactly as they were");
    assert.equal(JSON.parse(lines[1]).author_login, null);
  });
});

test("spool lines carry the public login only, never a name or email field", async () => {
  await withTempDir(async (dir) => {
    await createFileSpool(dir).append("o/r", [line(1), line(2)]);
    for (const l of (await readFile(join(dir, "o__r.commit-files.jsonl"), "utf8")).trimEnd().split("\n")) {
      assert.deepEqual(Object.keys(JSON.parse(l)).sort(), ["author_login", "committed_at", "files", "repo", "sha"]);
    }
  });
});

// ---- recovery after an interrupted write ----

const parsedShas = (text: string) =>
  text.split("\n").filter(Boolean).map((l) => {
    try {
      return (JSON.parse(l) as { sha: string }).sha;
    } catch {
      return "UNREADABLE";
    }
  });

test("a record appended after a half-written last line stays readable, and existing bytes are untouched", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "o__r.commit-files.jsonl");
    const complete = JSON.stringify(line(1)) + "\n";
    const partial = `{"repo":"o/r","sha":"${line(2).sha.slice(0, 12)}`; // the process was killed here: no closing, no newline
    await appendFile(file, complete + partial);
    const before = await readFile(file, "utf8");

    const spool = createFileSpool(dir);
    await spool.append("o/r", [line(3)]);

    const after = await readFile(file, "utf8");
    assert.ok(after.startsWith(before), "nothing already in the file was truncated or rewritten");
    assert.deepEqual(parsedShas(after), [line(1).sha, "UNREADABLE", line(3).sha], "the new record sits on its own line");

    const reopened = createFileSpool(dir);
    assert.equal(await reopened.has("o/r", line(3).sha), true, "the new record is recoverable by the next run");
    assert.equal(await reopened.has("o/r", line(1).sha), true);
    assert.equal(await reopened.has("o/r", line(2).sha), false, "the half-written record is still just ignored");
  });
});

test("a complete last record that only lacks its newline is kept and terminated, not glued to the next one", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "o__r.commit-files.jsonl");
    await appendFile(file, JSON.stringify(line(1))); // fully written, killed before the newline
    await createFileSpool(dir).append("o/r", [line(2)]);
    assert.deepEqual(parsedShas(await readFile(file, "utf8")), [line(1).sha, line(2).sha]);
    const reopened = createFileSpool(dir);
    assert.equal(await reopened.has("o/r", line(1).sha), true);
    assert.equal(await reopened.has("o/r", line(2).sha), true);
  });
});

test("no extra newline is added when the file is missing, empty, or already ends with one", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "o__r.commit-files.jsonl");
    await createFileSpool(dir).append("o/r", [line(1)]); // file does not exist yet
    assert.ok((await readFile(file, "utf8")).startsWith("{"), "no leading newline in a new file");

    await createFileSpool(dir).append("o/r", [line(2)]); // ends with a newline already
    const text = await readFile(file, "utf8");
    assert.ok(!text.includes("\n\n"), "no blank line between records");
    assert.deepEqual(parsedShas(text), [line(1).sha, line(2).sha]);

    const emptyDir = join(dir, "empty");
    await mkdir(emptyDir);
    await appendFile(join(emptyDir, "o__r.commit-files.jsonl"), "");
    await createFileSpool(emptyDir).append("o/r", [line(3)]);
    assert.ok((await readFile(join(emptyDir, "o__r.commit-files.jsonl"), "utf8")).startsWith("{"), "no leading newline in an empty file");
  });
});

test("recovery keeps deduplication: records already present are not appended again", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "o__r.commit-files.jsonl");
    await appendFile(file, JSON.stringify(line(1)) + "\n" + '{"repo":"o/r","sha":"half');
    const spool = createFileSpool(dir);
    await spool.append("o/r", [line(1), line(2), line(2)]);
    await spool.append("o/r", [line(2), line(3)]);
    assert.deepEqual(parsedShas(await readFile(file, "utf8")), [line(1).sha, "UNREADABLE", line(2).sha, line(3).sha]);
  });
});
