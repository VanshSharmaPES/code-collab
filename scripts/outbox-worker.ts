// Outbox worker (P2-10). Default: print the outbox status (read-only). --apply: deliver due rows to MongoDB.
// Usage: npm run outbox [-- --apply [--once] [--interval=2000]]
// Runs until Ctrl-C (it finishes the batch in hand first); --once drains what is due and exits.
import { MongoClient } from "mongodb";
import { Client } from "pg";
import { assertSafeMongoTarget } from "../src/lib/mongo-config";
import { STATUS_SQL, createMongoSink, processBatch } from "./outbox-data";
import { assertSafeTarget, describeError, describeTarget, registerClientErrorHandler, toClientConfig } from "./seed-data";

let dbPassword: string | undefined;
const secrets = () => [process.env.DATABASE_URL, process.env.MONGO_URL, dbPassword];

function parseArgs(argv: readonly string[]) {
  let apply = false, once = false, interval = 2000;
  for (const arg of argv) {
    if (arg === "--apply") apply = true;
    else if (arg === "--once") once = true;
    else if (arg.startsWith("--interval=")) {
      const v = arg.slice("--interval=".length);
      if (!/^[1-9]\d{2,5}$/.test(v)) throw new Error("--interval must be 100 to 999999 milliseconds.");
      interval = Number(v);
    } else throw new Error(`Unknown argument: ${arg}. Supported: --apply, --once, --interval=MS.`);
  }
  return { apply, once, interval };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pgTarget = assertSafeTarget(process.env);
  dbPassword = pgTarget.password;
  const mongoTarget = assertSafeMongoTarget(process.env);
  console.log(`Outbox worker (${args.apply ? "apply" : "status"}): ${describeTarget(pgTarget)} -> ${mongoTarget.description}`);

  const pg = new Client(toClientConfig(pgTarget));
  registerClientErrorHandler(pg, secrets());
  await pg.connect();
  const mongo = new MongoClient(mongoTarget.url, { serverSelectionTimeoutMS: 5000 });
  try {
    if (!args.apply) {
      console.log("  outbox:", JSON.stringify((await pg.query(STATUS_SQL)).rows[0]));
      console.log("Status only: nothing was delivered. Re-run with --apply.");
      return;
    }
    await mongo.connect();
    const sink = createMongoSink(mongo.db(mongoTarget.database));
    const describe = (err: unknown) => describeError(err, secrets());
    let stop = false;
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { stop = true; });

    while (!stop) {
      const r = await processBatch(pg, sink, describe);
      if (r.claimed > 0) console.log(`  claimed ${r.claimed}: delivered ${r.delivered}, failed ${r.failed}${r.parked ? `, parked ${r.parked}` : ""}${r.deferred ? `, deferred ${r.deferred}` : ""}`);
      if (args.once && r.claimed === 0) break;
      if (r.claimed === 0 || r.delivered === 0) await sleep(args.interval); // idle, or only failures: back off
    }
    console.log("  outbox:", JSON.stringify((await pg.query(STATUS_SQL)).rows[0]));
  } finally {
    await mongo.close();
    await pg.end();
  }
}

main().catch((err) => {
  console.error("Outbox worker failed:", describeError(err, secrets()));
  process.exitCode = 1;
});
