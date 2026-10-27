// The steps of the MongoDB setup (P2-09), kept apart from the runner so they can be tested without a server.
// Create-only: nothing here drops, renames or deletes a collection, an index or a document.
import { COLLECTIONS, INDEXES, type IndexSpec } from "../src/lib/mongo-config";

// The part of the driver's Db that the setup uses; the real Db satisfies it.
export type MongoDbLike = {
  listCollections(filter: object, options: { nameOnly: true }): { toArray(): Promise<{ name: string }[]> };
  createCollection(name: string): Promise<unknown>;
  collection(name: string): { createIndex(keys: Record<string, 1 | -1>, options: Record<string, unknown>): Promise<unknown> };
};

const INDEX_OPTIONS_CONFLICT = 85; // same keys under another name, or the same name with other options
const INDEX_KEY_SPECS_CONFLICT = 86; // same name with other keys

export function indexOptions(spec: IndexSpec): Record<string, unknown> {
  return {
    name: spec.name,
    ...(spec.unique ? { unique: true } : {}),
    ...(spec.expireAfterSeconds !== undefined ? { expireAfterSeconds: spec.expireAfterSeconds } : {}),
  };
}

// Creates what is missing and leaves what exists alone. createIndex with an identical definition is a no-op on the
// server; a conflicting definition is reported by name and nothing is changed, so a person decides what to do.
export async function runMongoSetup(db: MongoDbLike, apply: boolean, log: (line: string) => void): Promise<void> {
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
  for (const name of Object.values(COLLECTIONS)) {
    if (existing.has(name)) log(`  collection ${name}: exists`);
    else if (apply) { await db.createCollection(name); log(`  collection ${name}: created`); }
    else log(`  collection ${name}: would be created`);
  }
  for (const spec of INDEXES) {
    if (!apply) { log(`  index ${spec.collection}.${spec.name}: would be ensured`); continue; }
    try {
      await db.collection(spec.collection).createIndex(spec.keys, indexOptions(spec));
    } catch (err) {
      const code = (err as { code?: number }).code;
      if (code === INDEX_OPTIONS_CONFLICT || code === INDEX_KEY_SPECS_CONFLICT) {
        throw new Error(`Index ${spec.collection}.${spec.name} already exists with a different definition. Nothing was changed; inspect it in mongosh and resolve it by hand.`);
      }
      throw err;
    }
    log(`  index ${spec.collection}.${spec.name}: ensured`);
  }
  log(apply ? "Done." : "Dry run only: nothing was written. Re-run with --apply.");
}
