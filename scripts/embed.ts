// Embeds issues, commits and pull requests for similarity search (P2-17). Dry run by default: it only counts what is pending.
// Usage: npm run embed [-- --apply] [--kind=issues|commits|pull-requests|all] [--limit=N]
// --apply loads the local model (about 25 MB, downloaded the first time) and writes to the embeddings table.
// Needs db/schema/08_embeddings.sql applied first. Only the local "codecollab" database is ever opened.
import { Client } from "pg";
import { embedTexts } from "../src/lib/embedder";
import { MODEL_NAME, TABLE_EXISTS_SQL, countPending, embedKind, parseEmbedArgs } from "./embed-data";
import { assertSafeTarget, describeError, describeTarget, registerClientErrorHandler, toClientConfig } from "./seed-data";

let dbPassword: string | undefined;
const secrets = () => [process.env.DATABASE_URL, dbPassword];

async function main() {
  const args = parseEmbedArgs(process.argv.slice(2));
  const target = assertSafeTarget(process.env);
  dbPassword = target.password;
  console.log(`Embeddings (${args.apply ? "apply" : "dry-run"}), model ${MODEL_NAME}, on ${describeTarget(target)}`);

  const client = new Client(toClientConfig(target));
  registerClientErrorHandler(client, secrets());
  await client.connect();
  try {
    if (!(await client.query(TABLE_EXISTS_SQL)).rows[0]?.ok) throw new Error("The embeddings table is missing. Apply db/schema/08_embeddings.sql first.");
    for (const kind of args.kinds) console.log(`  ${kind}: ${await countPending(client, kind)} pending`);
    if (!args.apply) { console.log("Dry run only: nothing was embedded. Re-run with --apply (try --limit=100 first)."); return; }
    for (const kind of args.kinds) {
      const r = await embedKind(client, kind, embedTexts, { limit: args.limit, log: console.log });
      console.log(`  ${kind} done: ${r.embedded} embedded, ${r.unchanged} unchanged, ${r.empty} empty (limit ${args.limit})`);
    }
  } finally {
    await client.end();
  }
}

if (process.argv[1]?.endsWith("embed.ts")) {
  main().catch((err) => {
    console.error("Embedding failed:", describeError(err, secrets()));
    process.exitCode = 1;
  });
}
