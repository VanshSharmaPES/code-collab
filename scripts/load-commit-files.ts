// Loads the ingestion spool (tmp/ingest/*.commit-files.jsonl) into the MongoDB commit_files collection (P2-09/P2-11).
// One document per commit, keyed by (repo, sha), so rerunning is safe and picks up new lines. Dry run by default.
// The spool holds only author_login and file metadata (no names, emails or patch text); nothing else is added.
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { MongoClient } from "mongodb";
import { COLLECTIONS, assertSafeMongoTarget } from "../src/lib/mongo-config";
import { describeError } from "./seed-data";

const BATCH = 500;
const FILE_KEYS = ["filename", "status", "additions", "deletions", "changes", "previous_filename"] as const;

export type CommitFilesDoc = {
  repo: string;
  sha: string;
  committedAt: Date;
  authorLogin: string | null;
  files: Record<string, string | number | null>[];
};

// Returns null for a line that is not a complete, well-formed record (e.g. a half-written last line).
export function toCommitFilesDoc(line: string): CommitFilesDoc | null {
  let raw: Record<string, unknown> | null;
  try {
    raw = JSON.parse(line) as Record<string, unknown> | null;
  } catch {
    return null;
  }
  const committedAt = new Date(String(raw?.committed_at));
  if (typeof raw?.repo !== "string" || typeof raw?.sha !== "string" || Number.isNaN(committedAt.getTime()) || !Array.isArray(raw.files)) return null;
  const files = (raw.files as Record<string, unknown>[]).map((f) => {
    const out: Record<string, string | number | null> = {};
    for (const key of FILE_KEYS) {
      const v = f?.[key] as unknown;
      out[key] = typeof v === "string" || typeof v === "number" ? v : null;
    }
    return out;
  });
  return { repo: raw.repo, sha: raw.sha, committedAt, authorLogin: typeof raw.author_login === "string" ? raw.author_login : null, files };
}

async function main() {
  const apply = process.argv.slice(2).includes("--apply");
  for (const arg of process.argv.slice(2)) if (arg !== "--apply") throw new Error(`Unknown argument: ${arg}. Supported: --apply.`);
  const target = assertSafeMongoTarget(process.env);
  const dir = resolve("tmp/ingest");
  const names = (await readdir(dir)).filter((n) => n.endsWith(".commit-files.jsonl")).sort();
  console.log(`Load commit files (${apply ? "apply" : "dry-run"}) from ${dir} into ${target.description}`);

  const client = new MongoClient(target.url, { serverSelectionTimeoutMS: 5000 });
  try {
    if (apply) await client.connect();
    const collection = client.db(target.database).collection<CommitFilesDoc>(COLLECTIONS.commitFiles);
    for (const name of names) {
      const docs = (await readFile(join(dir, name), "utf8")).split("\n").filter((l) => l.trim()).map(toCommitFilesDoc);
      const valid = docs.filter((d): d is CommitFilesDoc => d !== null);
      let inserted = 0;
      if (apply) {
        for (let i = 0; i < valid.length; i += BATCH) {
          const res = await collection.bulkWrite(
            valid.slice(i, i + BATCH).map((d) => ({ updateOne: { filter: { repo: d.repo, sha: d.sha }, update: { $setOnInsert: d }, upsert: true } })),
            { ordered: false },
          );
          inserted += res.upsertedCount;
        }
      }
      console.log(`  ${name}: ${valid.length} records${docs.length > valid.length ? `, ${docs.length - valid.length} skipped (incomplete)` : ""}${apply ? `, ${inserted} new` : ""}`);
    }
    console.log(apply ? "Done." : "Dry run only: nothing was written. Re-run with --apply.");
  } finally {
    await client.close();
  }
}

// Only run the CLI when executed directly, so tests can import toCommitFilesDoc.
if (process.argv[1]?.endsWith("load-commit-files.ts")) {
  main().catch((err) => {
    console.error("Load failed:", describeError(err, [process.env.MONGO_URL]));
    process.exitCode = 1;
  });
}
