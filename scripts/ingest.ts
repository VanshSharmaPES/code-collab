// CLI for GitHub ingestion (P2-06). Dry run by default; pass --apply to write.
// Usage: npm run ingest [-- owner/name ...] [-- --limit=N] [-- --apply]
// Needs GITHUB_TOKEN for --apply, and a local `codecollab` DATABASE_URL (same guard as the seed).
import { resolve } from "node:path";
import { Client } from "pg";
import { createGitHubClient } from "./github-client";
import { ingestRepository, loadUserIds, parseIngestArgs, planRepository, readGitHubToken, REQUESTS_PER_HOUR } from "./ingest-data";
import { createFileSpool } from "./ingest-spool";
import { assertSafeTarget, describeError, describeTarget, registerClientErrorHandler, toClientConfig } from "./seed-data";

// Values that must never appear in output; filled in as they become known.
let parsedDbPassword: string | undefined;
const secrets = () => [process.env.DATABASE_URL, process.env.GITHUB_TOKEN, parsedDbPassword];

async function main() {
  const args = parseIngestArgs(process.argv.slice(2));
  const target = assertSafeTarget(process.env);
  parsedDbPassword = target.password;
  const token = readGitHubToken(process.env, args.apply);

  console.log(`GitHub ingestion (${args.apply ? "apply" : "dry-run"}) into ${describeTarget(target)}`);
  console.log(`  repositories: ${args.repos.join(", ")}${args.limit ? `  (limit ${args.limit} per kind)` : ""}`);
  const github = createGitHubClient({ token, log: (line) => console.log(`  ${line}`) });

  if (!args.apply) {
    let total = 0;
    for (const slug of args.repos) {
      const plan = await planRepository(github, slug, args.limit);
      total += plan.requests.total;
      console.log(`  ${slug}: ${plan.commits} commits, ${plan.pulls} pull requests, ~${plan.issues} issues (default branch ${plan.defaultBranch}${plan.archived ? ", ARCHIVED" : ""})`);
      console.log(`    about ${plan.requests.total} requests (${plan.requests.commitDetails} commit details)`);
    }
    console.log(`  total: about ${total} requests, roughly ${(total / REQUESTS_PER_HOUR).toFixed(1)} hours at ${REQUESTS_PER_HOUR}/hour (an upper bound: stored commits are skipped on a rerun).`);
    console.log(`  checked with ${github.requestCount} read-only metadata requests${token ? "" : " (unauthenticated: 60/hour)"}.`);
    console.log("Dry run only: nothing was written. Re-run with --apply to ingest.");
    return;
  }

  const client = new Client(toClientConfig(target));
  registerClientErrorHandler(client, secrets());
  try {
    await client.connect();
    const spool = createFileSpool(resolve("tmp/ingest"));
    const userIds = await loadUserIds(client);
    console.log(`  ${userIds.size} existing users can be matched by GitHub username`);
    for (const slug of args.repos) {
      const s = await ingestRepository({ github, db: client, spool, userIds, log: (line) => console.log(`  ${line}`) }, slug, args.limit);
      console.log(`${slug}: commits ${s.commits.inserted} inserted / ${s.commits.alreadyStored} already stored / ${s.commits.invalid} invalid; ` +
        `issues ${s.issues.upserted} upserted; pull requests ${s.pulls.upserted} upserted`);
    }
    console.log(`Done (${github.requestCount} GitHub requests). Changed-file details are in tmp/ingest/.`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  // One redacted line: message plus error code. No stack, SQL, parameters, URL or token.
  console.error("Ingestion failed:", describeError(err, secrets()));
  process.exitCode = 1;
});
