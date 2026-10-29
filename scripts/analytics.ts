// Read-only analytics over the MongoDB collections (P2-11).
// Usage: npm run analytics -- monthly|events|files [--repo=owner/name] [--repository=ID] [--since=YYYY-MM-DD] [--until=YYYY-MM-DD] [--limit=N]
// Nothing is written. Only the "codecollab" database on a local server is opened.
import { MongoClient } from "mongodb";
import { COLLECTIONS, assertSafeMongoTarget } from "../src/lib/mongo-config";
import { monthlyActivity, monthlyEvents, topFiles } from "../src/lib/mongo-analytics";
import { parseAnalyticsArgs } from "./analytics-data";
import { describeError } from "./seed-data";

async function main() {
  const args = parseAnalyticsArgs(process.argv.slice(2));
  const target = assertSafeMongoTarget(process.env);
  console.log(`Analytics (${args.report}) on ${target.description}`);
  const client = new MongoClient(target.url, { serverSelectionTimeoutMS: 5000 });
  try {
    await client.connect();
    const db = client.db(target.database);
    const range = { since: args.since, until: args.until };
    const rows =
      args.report === "monthly" ? await monthlyActivity(db.collection(COLLECTIONS.commitFiles), { repo: args.repo, ...range })
      : args.report === "files" ? await topFiles(db.collection(COLLECTIONS.commitFiles), { repo: args.repo, ...range }, args.limit)
      : await monthlyEvents(db.collection(COLLECTIONS.activityEvents), { repositoryId: args.repositoryId, ...range });
    if (rows.length === 0) console.log("No data for this selection.");
    else console.table(rows);
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error("Analytics failed:", describeError(err, [process.env.MONGO_URL]));
  process.exitCode = 1;
});
