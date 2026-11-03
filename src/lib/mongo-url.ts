// The web application's MongoDB target. Pure: no driver import, so tests can use it.
//
// This is deliberately not assertSafeMongoTarget (mongo-config.ts). That guard is for the setup, ingestion and
// maintenance scripts: it refuses NODE_ENV=production, remote hosts and any database but the local "codecollab".
// The running application is the opposite case: in production it must reach the server that MONGO_URL names.
// The script guard stays as it is. Messages never contain the URL, because it can carry a password.

export type WebMongoTarget = { url: string; database: string };

export function parseWebMongoUrl(raw: string | undefined): WebMongoTarget {
  if (raw === undefined || raw.trim() === "") throw new Error("MongoDB is not configured: MONGO_URL is not set.");
  if (/\s/.test(raw)) throw new Error("MongoDB is not configured: MONGO_URL contains whitespace.");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("MongoDB is not configured: MONGO_URL could not be parsed.");
  }
  if (url.protocol !== "mongodb:" && url.protocol !== "mongodb+srv:") throw new Error("MongoDB is not configured: MONGO_URL must start with mongodb:// or mongodb+srv://.");
  let database: string;
  try {
    database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  } catch {
    throw new Error("MongoDB is not configured: MONGO_URL has invalid percent-encoding.");
  }
  if (database === "" || database.includes("/")) throw new Error("MongoDB is not configured: MONGO_URL must name one database, as in mongodb://host/codecollab.");
  return { url: raw, database };
}
