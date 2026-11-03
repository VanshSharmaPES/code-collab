// Local JSON Lines spool for changed-file details (P2-06). The schema has no table for
// them; the plan puts them in MongoDB (P2-09/P2-10), which loads from these files later.
// One file per repository, one line per commit, keyed by sha so reruns never duplicate.
import { appendFile, mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseRepoSlug, type Spool, type SpoolLine } from "./ingest-data";

export function spoolFileName(slug: string): string {
  return `${parseRepoSlug(slug).replace("/", "__")}.commit-files.jsonl`;
}

// True when appending right now cannot glue a record onto an unfinished line: the file is
// missing, empty, or its last byte is a newline. Only the final byte is read.
async function endsOnLineBoundary(file: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(file, "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw err;
  }
  try {
    const { size } = await handle.stat();
    if (size === 0) return true;
    const last = Buffer.alloc(1);
    await handle.read(last, 0, 1, size - 1);
    return last[0] === 0x0a;
  } finally {
    await handle.close();
  }
}

export function createFileSpool(dir: string): Spool {
  const loaded = new Map<string, Set<string>>();

  async function shasFor(slug: string): Promise<Set<string>> {
    const existing = loaded.get(slug);
    if (existing) return existing;
    const shas = new Set<string>();
    try {
      for (const line of (await readFile(join(dir, spoolFileName(slug)), "utf8")).split("\n")) {
        if (!line.trim()) continue;
        try {
          const sha = (JSON.parse(line) as { sha?: unknown }).sha;
          if (typeof sha === "string") shas.add(sha);
        } catch {
          // A half-written last line from an interrupted run is ignored.
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    loaded.set(slug, shas);
    return shas;
  }

  return {
    async has(slug, sha) {
      return (await shasFor(slug)).has(sha);
    },
    async append(slug, lines: SpoolLine[]) {
      const shas = await shasFor(slug);
      const seenInBatch = new Set<string>();
      const fresh = lines.filter((line) => {
        if (shas.has(line.sha) || seenInBatch.has(line.sha)) return false;
        seenInBatch.add(line.sha);
        return true;
      });
      if (fresh.length === 0) return;
      await mkdir(dir, { recursive: true });
      const file = join(dir, spoolFileName(slug));
      // An interrupted earlier run can leave a last line without its newline. Finish that
      // line first (it stays unreadable and is ignored on load) so the new records are not
      // glued onto it. Existing bytes are never changed: this only adds to the end.
      const prefix = (await endsOnLineBoundary(file)) ? "" : "\n";
      await appendFile(file, prefix + fresh.map((line) => JSON.stringify(line)).join("\n") + "\n");
      for (const line of fresh) shas.add(line.sha);
    },
  };
}
