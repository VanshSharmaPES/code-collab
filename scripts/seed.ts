// CLI for the seed skeleton. Dry run by default; pass --apply to write.
// Usage: SEED_PASSWORD=... npm run seed [-- --apply]
import { Client } from "pg";
import { hashPassword } from "../src/lib/password";
import {
  NO_CLIENT,
  assertSafeTarget,
  describeError,
  describeTarget,
  parseArgs,
  readSeedPassword,
  registerClientErrorHandler,
  runSeed,
  toClientConfig,
} from "./seed-data";

// Values that must never appear in output; filled in as they become known.
let parsedDbPassword: string | undefined;
const secrets = () => [process.env.DATABASE_URL, process.env.SEED_PASSWORD, parsedDbPassword];

async function main() {
  const { apply } = parseArgs(process.argv.slice(2));
  const target = assertSafeTarget(process.env);
  parsedDbPassword = target.password;
  const password = readSeedPassword(process.env);

  // Shown before anything connects, so a failing run still says where it was aimed.
  console.log(`Seed skeleton (${apply ? "apply" : "dry-run"}) on ${describeTarget(target)}`);

  // Built from the validated fields only: what is shown above is what is connected to.
  const client = apply ? new Client(toClientConfig(target)) : null;
  if (client) registerClientErrorHandler(client, secrets());
  try {
    await client?.connect();
    const summary = await runSeed(client ?? NO_CLIENT, { apply, password, hash: hashPassword });
    console.log(`  users:    ${summary.users.planned} planned, ${summary.users.inserted} inserted, ${summary.users.skipped} skipped`);
    console.log(`  projects: ${summary.projects.planned} planned, ${summary.projects.inserted} inserted, ${summary.projects.skipped} skipped`);
    if (!apply) console.log("Dry run only: nothing was written. Re-run with --apply to insert.");
  } finally {
    await client?.end();
  }
}

main().catch((err) => {
  // One redacted line: message plus error code. No stack, SQL, parameters or URL.
  console.error("Seed failed:", describeError(err, secrets()));
  process.exitCode = 1;
});
