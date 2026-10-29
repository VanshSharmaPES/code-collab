// MongoDB layout for CodeCollab (P2-09): the target guard, collection names and indexes.
// Pure data and checks, no driver import, so scripts and tests can share it.

export const MONGO_DATABASE_NAME = "codecollab";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export type MongoTarget = { url: string; database: string; description: string };

// Same rule as the PostgreSQL guard: a local server and the database named "codecollab", nothing else.
// The server on this machine is shared with other projects, so no other database is ever opened.
export function assertSafeMongoTarget(env: Record<string, string | undefined>): MongoTarget {
  if (env.NODE_ENV?.trim().toLowerCase() === "production") throw new Error("Refusing to use MongoDB: NODE_ENV is production.");
  const raw = env.MONGO_URL;
  if (!raw) throw new Error("Refusing to use MongoDB: MONGO_URL is not set.");
  if (/\s/.test(raw)) throw new Error("Refusing to use MongoDB: MONGO_URL contains whitespace.");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Refusing to use MongoDB: MONGO_URL could not be parsed.");
  }
  if (url.protocol !== "mongodb:") throw new Error("Refusing to use MongoDB: MONGO_URL must start with mongodb:// (one local server).");
  if (!LOCAL_HOSTS.has(url.hostname)) { // a comma-separated host list parses as one unknown host and is refused here
    throw new Error("Refusing to use MongoDB: the host must be a single local address (localhost, 127.0.0.1 or ::1).");
  }
  let database: string;
  try {
    database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  } catch {
    throw new Error("Refusing to use MongoDB: MONGO_URL has invalid percent-encoding.");
  }
  if (database !== MONGO_DATABASE_NAME) throw new Error(`Refusing to use MongoDB: the database must be named "${MONGO_DATABASE_NAME}".`);
  return { url: raw, database, description: `${url.hostname}:${url.port || 27017}/${database}` };
}

export const COLLECTIONS = {
  activityEvents: "activity_events", // event stream, filled by the outbox worker (P2-10)
  comments: "comments", // nested comment threads (the comment UI is a later task)
  commitFiles: "commit_files", // per-commit changed-file metadata, loaded from the ingestion spool
  notifications: "notifications", // expiring notifications
} as const;

// A notification disappears when its own `expiresAt` passes (TTL index with expireAfterSeconds 0).
export const NOTIFICATION_TTL_INDEX = "notifications_expires_at_ttl";

// Applied when the notifications collection is created. A TTL index only expires documents whose `expiresAt` is a BSON
// date; a string or number there would never expire. Only the types are enforced, not the presence of the fields: no
// writer of notifications exists yet to show that every document carries both. Existing collections are not changed.
export const NOTIFICATION_VALIDATOR = {
  $jsonSchema: {
    bsonType: "object",
    properties: { createdAt: { bsonType: "date" }, expiresAt: { bsonType: "date" } },
  },
} as const;

export type IndexSpec = {
  collection: string;
  name: string;
  keys: Record<string, 1 | -1>;
  unique?: boolean;
  expireAfterSeconds?: number;
};

export const INDEXES: readonly IndexSpec[] = [
  // outboxId makes delivery idempotent: the same outbox row can never produce two events.
  { collection: COLLECTIONS.activityEvents, name: "activity_outbox_id_unique", keys: { outboxId: 1 }, unique: true },
  { collection: COLLECTIONS.activityEvents, name: "activity_repository_time", keys: { repositoryId: 1, occurredAt: -1 } },
  { collection: COLLECTIONS.activityEvents, name: "activity_type_time", keys: { type: 1, occurredAt: -1 } },
  { collection: COLLECTIONS.comments, name: "comments_target_time", keys: { targetType: 1, targetId: 1, createdAt: 1 } },
  { collection: COLLECTIONS.comments, name: "comments_parent", keys: { parentId: 1 } },
  // One document per commit; the unique key makes reloading the spool safe.
  { collection: COLLECTIONS.commitFiles, name: "commit_files_repo_sha_unique", keys: { repo: 1, sha: 1 }, unique: true },
  { collection: COLLECTIONS.commitFiles, name: "commit_files_repo_time", keys: { repo: 1, committedAt: -1 } },
  { collection: COLLECTIONS.commitFiles, name: "commit_files_repo_filename", keys: { repo: 1, "files.filename": 1 } },
  { collection: COLLECTIONS.notifications, name: "notifications_user_time", keys: { userId: 1, createdAt: -1 } },
  { collection: COLLECTIONS.notifications, name: NOTIFICATION_TTL_INDEX, keys: { expiresAt: 1 }, expireAfterSeconds: 0 },
];
