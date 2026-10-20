// Seed skeleton (P2-05): a handful of users and projects, nothing else.
// The full synthetic dataset is db/seed/dev_synthetic.sql (P1-06); this stays separate:
// different email domain and project-name prefix, so neither can touch the other's rows.

export const SEED_EMAIL_DOMAIN = "skeleton.codecollab.test";
export const SEED_PROJECT_PREFIX = "Skeleton: ";
// The only database this script will write to (the name db/setup.md creates).
export const SEED_DATABASE_NAME = "codecollab";
const MENTOR_ROLE = "mentor";

type Role = "student" | "lead" | "mentor";

export type SeedUser = { email: string; fullName: string; role: Role; githubUsername: string };
export type SeedProject = { name: string; description: string; status: "active" | "archived"; mentorEmail: string };

export const SEED_USERS: readonly SeedUser[] = [
  { email: `mentor.one@${SEED_EMAIL_DOMAIN}`, fullName: "Skeleton Mentor", role: "mentor", githubUsername: "skeleton-mentor" },
  { email: `lead.one@${SEED_EMAIL_DOMAIN}`, fullName: "Skeleton Lead", role: "lead", githubUsername: "skeleton-lead" },
  { email: `student.one@${SEED_EMAIL_DOMAIN}`, fullName: "Skeleton Student One", role: "student", githubUsername: "skeleton-student-1" },
  { email: `student.two@${SEED_EMAIL_DOMAIN}`, fullName: "Skeleton Student Two", role: "student", githubUsername: "skeleton-student-2" },
];

export const SEED_PROJECTS: readonly SeedProject[] = [
  {
    name: `${SEED_PROJECT_PREFIX}Campus Events`,
    description: "Sample project created by the seed skeleton.",
    status: "active",
    mentorEmail: `mentor.one@${SEED_EMAIL_DOMAIN}`,
  },
  {
    name: `${SEED_PROJECT_PREFIX}Study Groups`,
    description: "Sample project created by the seed skeleton.",
    status: "active",
    mentorEmail: `mentor.one@${SEED_EMAIL_DOMAIN}`,
  },
];

// Insert-only. The conflict targets are the UNIQUE columns in db/schema/01_core.sql
// (users.email, projects.name): re-seeding an existing row is skipped, but any other
// unique violation (e.g. a taken github_username) raises an error and rolls back.
// Values are always bound parameters.
export const INSERT_USER_SQL =
  "INSERT INTO users (email, full_name, password_hash, role, github_username) " +
  "VALUES ($1, $2, $3, $4, $5) ON CONFLICT (email) DO NOTHING";

// The mentor is looked up by email and must have the mentor role (the schema only
// enforces that the user exists). No mentor row means no insert; runSeed then tells
// "project already exists" apart from "mentor missing or wrong role".
export const INSERT_PROJECT_SQL =
  "INSERT INTO projects (name, description, status, mentor_id, created_by) " +
  "SELECT $1::text, $2::text, $3::text, m.id, m.id FROM users m " +
  "WHERE m.email = $4::text AND m.role = $5::text ON CONFLICT (name) DO NOTHING";

export const PROJECT_EXISTS_SQL = "SELECT 1 FROM projects WHERE name = $1::text";

// ---- safety guards ----

type Env = Record<string, string | undefined>;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export type DbTarget = { host: string; port: number; user: string; password: string; database: string };

// Validates DATABASE_URL and returns the exact fields the connection is built from, so
// there is no second URL parser that could disagree with this check. Throws (without
// echoing the URL or any credentials) unless this is a non-production run against the
// local `codecollab` database.
export function assertSafeTarget(env: Env): DbTarget {
  // Defence in depth only: the local-target checks below are what actually protect.
  if (env.NODE_ENV?.trim().toLowerCase() === "production") {
    throw new Error("Refusing to seed: NODE_ENV is production.");
  }
  const raw = env.DATABASE_URL;
  if (!raw) {
    throw new Error("Refusing to seed: DATABASE_URL is not set.");
  }
  if (/\s/.test(raw)) {
    throw new Error("Refusing to seed: DATABASE_URL contains whitespace.");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Refusing to seed: DATABASE_URL could not be parsed.");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("Refusing to seed: DATABASE_URL must start with postgresql://.");
  }
  // pg would honour these overrides; this script uses only the URL's own fields.
  for (const key of ["host", "hostaddr", "port"]) {
    if (url.searchParams.has(key)) {
      throw new Error(`Refusing to seed: DATABASE_URL must not set "${key}" as a query parameter.`);
    }
  }
  if (!LOCAL_HOSTS.has(url.hostname)) {
    throw new Error("Refusing to seed: the database host is not local (localhost, 127.0.0.1 or ::1).");
  }
  let user: string;
  let password: string;
  let database: string;
  try {
    user = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
    database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  } catch {
    throw new Error("Refusing to seed: DATABASE_URL has invalid percent-encoding.");
  }
  if (!user) {
    throw new Error("Refusing to seed: DATABASE_URL has no user.");
  }
  if (database !== SEED_DATABASE_NAME) {
    throw new Error(`Refusing to seed: the database must be named "${SEED_DATABASE_NAME}".`);
  }
  return {
    host: url.hostname.replace(/^\[|\]$/g, ""),
    port: url.port ? Number(url.port) : 5432,
    user,
    password,
    database,
  };
}

// What is shown before a run. Never includes the user or password.
export function describeTarget(target: DbTarget): string {
  const host = target.host.includes(":") ? `[${target.host}]` : target.host;
  return `${host}:${target.port}/${target.database}`;
}

// The only place connection settings are built, so what is shown is what is used.
export function toClientConfig(target: DbTarget) {
  return {
    host: target.host,
    port: target.port,
    user: target.user,
    password: target.password,
    database: target.database,
    connectionTimeoutMillis: 5000,
  };
}

// Same 8..128 range as login accepts, so seeded accounts can actually sign in.
export function readSeedPassword(env: Env): string {
  const password = env.SEED_PASSWORD;
  if (!password) throw new Error("SEED_PASSWORD is not set.");
  if (password.length < 8 || password.length > 128) throw new Error("SEED_PASSWORD must be 8 to 128 characters.");
  return password;
}

// Dry run is the default; writing needs the explicit --apply flag. Unknown flags are errors.
export function parseArgs(argv: readonly string[]): { apply: boolean } {
  const unknown = argv.filter((arg) => arg !== "--apply");
  if (unknown.length > 0) throw new Error(`Unknown argument(s): ${unknown.join(" ")}. Only --apply is supported.`);
  return { apply: argv.includes("--apply") };
}

// ---- error output ----

const MAX_ERROR_LENGTH = 300;

// Secrets shorter than 4 characters are not redacted: that would mangle ordinary text.
export function redactSecrets(text: string, secrets: readonly (string | undefined)[]): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret || secret.length < 4) continue;
    for (const form of new Set([secret, encodeURIComponent(secret)])) out = out.split(form).join("[redacted]");
  }
  return out;
}

// One safe line for the console: the message with secrets removed, plus the error code
// (e.g. 23505, ECONNREFUSED) when there is one. Never a stack, SQL, parameters or detail.
export function describeError(err: unknown, secrets: readonly (string | undefined)[]): string {
  if (!(err instanceof Error)) return "unknown error";
  const code = (err as { code?: unknown }).code;
  // Some errors (e.g. AggregateError from a refused connection) have an empty message.
  const base = err.message.trim() === "" ? err.name : err.message;
  const message = redactSecrets(base, secrets).slice(0, MAX_ERROR_LENGTH);
  return typeof code === "string" && /^[A-Za-z0-9_]{1,32}$/.test(code) ? `${message} [${code}]` : message;
}

// Without a listener, an error on an idle connection would crash with a raw stack trace.
export function registerClientErrorHandler(
  client: { on(event: "error", listener: (err: Error) => void): unknown },
  secrets: readonly (string | undefined)[],
  log: (line: string) => void = (line) => console.error(line),
): void {
  client.on("error", (err) => log(`Database connection error: ${describeError(err, secrets)}`));
}

// ---- runner ----

export type SeedClient = { query(text: string, params?: readonly unknown[]): Promise<{ rowCount: number | null }> };

// Passed in dry-run mode: any accidental use fails loudly.
export const NO_CLIENT: SeedClient = {
  query: async () => {
    throw new Error("Database access attempted in dry-run mode.");
  },
};

export type SeedOptions = {
  apply: boolean;
  password: string;
  hash: (password: string) => Promise<string>;
};

export type SeedSummary = {
  mode: "dry-run" | "apply";
  users: { planned: number; inserted: number; skipped: number };
  projects: { planned: number; inserted: number; skipped: number };
};

export async function runSeed(client: SeedClient, options: SeedOptions): Promise<SeedSummary> {
  const summary: SeedSummary = {
    mode: options.apply ? "apply" : "dry-run",
    users: { planned: SEED_USERS.length, inserted: 0, skipped: 0 },
    projects: { planned: SEED_PROJECTS.length, inserted: 0, skipped: 0 },
  };
  if (!options.apply) return summary;

  // Hash before opening the transaction so the slow part never holds it open.
  const hashes = await Promise.all(SEED_USERS.map(() => options.hash(options.password)));

  await client.query("BEGIN");
  try {
    for (const [i, user] of SEED_USERS.entries()) {
      const result = await client.query(INSERT_USER_SQL, [user.email, user.fullName, hashes[i], user.role, user.githubUsername]);
      if (result.rowCount === 1) summary.users.inserted += 1;
      else summary.users.skipped += 1;
    }
    for (const project of SEED_PROJECTS) {
      const result = await client.query(INSERT_PROJECT_SQL, [
        project.name,
        project.description,
        project.status,
        project.mentorEmail,
        MENTOR_ROLE,
      ]);
      if (result.rowCount === 1) {
        summary.projects.inserted += 1;
        continue;
      }
      // Nothing inserted: either the project already exists (fine) or the mentor is
      // missing / not a mentor (an error, not a skip).
      const existing = await client.query(PROJECT_EXISTS_SQL, [project.name]);
      if ((existing.rowCount ?? 0) > 0) {
        summary.projects.skipped += 1;
      } else {
        throw new Error(`Project "${project.name}" was not inserted: mentor ${project.mentorEmail} is missing or does not have the mentor role.`);
      }
    }
    await client.query("COMMIT");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The original error matters more than a failed rollback.
    }
    throw err;
  }
  return summary;
}
