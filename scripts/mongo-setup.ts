// Creates the CodeCollab MongoDB collections and indexes (P2-09). Dry run by default; --apply writes.
// Only the "codecollab" database on a local server is ever opened. Safe to rerun: an index that already
// exists with the same definition is left alone; a different definition under the same name fails loudly.
import { MongoClient } from "mongodb";
import { assertSafeMongoTarget } from "../src/lib/mongo-config";
import { runMongoSetup } from "./mongo-setup-data";
import { describeError } from "./seed-data";

async function main() {
  const args = process.argv.slice(2);
  for (const arg of args) if (arg !== "--apply") throw new Error(`Unknown argument: ${arg}. Supported: --apply.`);
  const apply = args.includes("--apply");
  const target = assertSafeMongoTarget(process.env);
  console.log(`MongoDB setup (${apply ? "apply" : "dry-run"}) on ${target.description}`);

  const client = new MongoClient(target.url, { serverSelectionTimeoutMS: 5000 });
  try {
    await client.connect();
    await runMongoSetup(client.db(target.database), apply, console.log);
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error("MongoDB setup failed:", describeError(err, [process.env.MONGO_URL]));
  process.exitCode = 1;
});
