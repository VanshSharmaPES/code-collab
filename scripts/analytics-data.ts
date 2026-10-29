// Argument handling for the analytics CLI (P2-11). Pure, so it can be tested without a server.
import { DEFAULT_TOP_FILES, MAX_TOP_FILES } from "../src/lib/mongo-analytics";

export const REPORTS = ["monthly", "events", "files"] as const;
export type Report = (typeof REPORTS)[number];
export type AnalyticsArgs = { report: Report; repo?: string; repositoryId?: string; since?: Date; until?: Date; limit: number };

// YYYY-MM-DD only, read as midnight UTC, and it must be a real calendar day (2026-02-30 is refused).
export function parseDay(value: string, name: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const d = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
  if (!m || !d || d.toISOString().slice(0, 10) !== value) throw new Error(`${name} must be a real date written YYYY-MM-DD.`);
  return d;
}

export function parseAnalyticsArgs(argv: readonly string[]): AnalyticsArgs {
  const [report, ...flags] = argv;
  if (!(REPORTS as readonly string[]).includes(report)) throw new Error(`First argument must be one of: ${REPORTS.join(", ")}.`);
  const args: AnalyticsArgs = { report: report as Report, limit: DEFAULT_TOP_FILES };
  for (const flag of flags) {
    const eq = flag.indexOf("=");
    const key = eq === -1 ? flag : flag.slice(0, eq);
    const value = eq === -1 ? "" : flag.slice(eq + 1);
    if (key === "--repo" && /^[\w.-]+\/[\w.-]+$/.test(value)) args.repo = value;
    else if (key === "--repository" && /^[1-9]\d{0,17}$/.test(value)) args.repositoryId = value;
    else if (key === "--since") args.since = parseDay(value, "--since");
    else if (key === "--until") args.until = parseDay(value, "--until");
    else if (key === "--limit" && /^[1-9]\d{0,3}$/.test(value) && Number(value) <= MAX_TOP_FILES) args.limit = Number(value);
    else throw new Error(`Unsupported or invalid argument: ${key}. Supported: --repo=owner/name, --repository=ID, --since=YYYY-MM-DD, --until=YYYY-MM-DD (exclusive), --limit=1..${MAX_TOP_FILES}.`);
  }
  if (args.report === "events" && args.repo) throw new Error("events are filtered with --repository=ID, not --repo.");
  if (args.report !== "events" && args.repositoryId) throw new Error("--repository applies to events only; use --repo=owner/name.");
  return args;
}
