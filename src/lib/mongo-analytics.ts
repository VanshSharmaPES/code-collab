// MongoDB aggregation pipelines (P2-11): builders for the pipelines, and thin typed runners. Pure: no driver import.
//
// Documents they read (see mongo-config.ts and the writers):
//   commit_files    { repo "owner/name", sha, committedAt: Date, authorLogin: string|null,
//                     files: [{ filename, status, additions, deletions, changes, previous_filename }] }   (scripts/load-commit-files.ts)
//   activity_events { outboxId, type, aggregateType, aggregateId, repositoryId, actorId, occurredAt: Date, data }   (scripts/outbox-data.ts)
//
// Conventions:
//   * A month is a UTC calendar month written "YYYY-MM"; a commit at 2026-01-31T23:30Z counts for January.
//   * A date range is half-open: `since` is included, `until` is not.
//   * Documents whose timestamp is missing or not a BSON date, or whose repo / sha / outboxId is missing, are
//     left out instead of failing the whole aggregation or filling a "null" bucket.
//   * Both collections have a unique index that prevents duplicates (P2-09). Each pipeline also collapses duplicate
//     documents by that key, so a database set up without the index, or a replayed load, cannot inflate the numbers.
//   * Documents are assumed to list a file at most once per commit, which is how GitHub reports commits.

export type Pipeline = Record<string, unknown>[];
export type AnalyticsFilter = { repo?: string; since?: Date; until?: Date };
export type EventFilter = { repositoryId?: string; type?: string; since?: Date; until?: Date };

export type MonthlyActivityRow = { month: string; repo: string; commits: number; filesChanged: number; additions: number; deletions: number; activeAuthors: number };
export type MonthlyEventRow = { month: string; type: string; events: number };
export type TopFileRow = { repo: string; filename: string; modifications: number; additions: number; deletions: number; lastModified: Date };

export const DEFAULT_TOP_FILES = 20;
export const MAX_TOP_FILES = 500;

const MONTH = (field: string) => ({ $dateToString: { format: "%Y-%m", date: field, timezone: "UTC" } });

function dateRange(since?: Date, until?: Date): Record<string, unknown> {
  for (const d of [since, until]) if (d !== undefined && (!(d instanceof Date) || Number.isNaN(d.getTime()))) throw new RangeError("since and until must be valid dates.");
  if (since && until && since >= until) throw new RangeError("since must be before until.");
  return { $type: "date", ...(since ? { $gte: since } : {}), ...(until ? { $lt: until } : {}) };
}

// Keeps one document per key (the first one seen) so a duplicate cannot be counted twice.
const dedupeBy = (key: Record<string, string>): Pipeline => [
  { $group: { _id: key, doc: { $first: "$$ROOT" } } },
  { $replaceRoot: { newRoot: "$doc" } },
];

function commitMatch(filter: AnalyticsFilter, extra: Record<string, unknown> = {}): Pipeline {
  return [{
    $match: {
      repo: filter.repo !== undefined ? filter.repo : { $type: "string" },
      sha: { $type: "string" },
      committedAt: dateRange(filter.since, filter.until),
      ...extra,
    },
  }];
}

// Per repository and UTC month: commits, files changed, lines added and removed, distinct authors (accounts only).
export function monthlyActivityPipeline(filter: AnalyticsFilter = {}): Pipeline {
  return [
    ...commitMatch(filter),
    ...dedupeBy({ repo: "$repo", sha: "$sha" }),
    {
      $group: {
        _id: { month: MONTH("$committedAt"), repo: "$repo" },
        commits: { $sum: 1 },
        filesChanged: { $sum: { $cond: [{ $isArray: "$files" }, { $size: "$files" }, 0] } },
        additions: { $sum: { $sum: "$files.additions" } }, // non-numbers and a missing files field add nothing
        deletions: { $sum: { $sum: "$files.deletions" } },
        authors: { $addToSet: "$authorLogin" },
      },
    },
    {
      $project: {
        _id: 0,
        month: "$_id.month",
        repo: "$_id.repo",
        commits: 1,
        filesChanged: 1,
        additions: 1,
        deletions: 1,
        activeAuthors: { $size: { $setDifference: ["$authors", [null]] } },
      },
    },
    { $sort: { month: 1, repo: 1 } },
  ];
}

// The files touched by the most commits, per repository. Ties are broken by repository then file name.
export function topFilesPipeline(filter: AnalyticsFilter = {}, limit: number = DEFAULT_TOP_FILES): Pipeline {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_TOP_FILES) throw new RangeError(`limit must be a whole number from 1 to ${MAX_TOP_FILES}.`);
  return [
    ...commitMatch(filter, { files: { $type: "array" } }),
    ...dedupeBy({ repo: "$repo", sha: "$sha" }),
    { $unwind: "$files" },
    { $match: { "files.filename": { $type: "string", $ne: "" } } },
    {
      $group: {
        _id: { repo: "$repo", filename: "$files.filename" },
        modifications: { $sum: 1 },
        additions: { $sum: "$files.additions" },
        deletions: { $sum: "$files.deletions" },
        lastModified: { $max: "$committedAt" },
      },
    },
    { $sort: { modifications: -1, "_id.repo": 1, "_id.filename": 1 } },
    { $limit: limit },
    { $project: { _id: 0, repo: "$_id.repo", filename: "$_id.filename", modifications: 1, additions: 1, deletions: 1, lastModified: 1 } },
  ];
}

// Events from the outbox worker per UTC month and type, one count per outbox row however often it was delivered.
export function monthlyEventsPipeline(filter: EventFilter = {}): Pipeline {
  return [
    {
      $match: {
        outboxId: { $type: "string" },
        type: filter.type !== undefined ? filter.type : { $type: "string" },
        ...(filter.repositoryId !== undefined ? { repositoryId: filter.repositoryId } : {}),
        occurredAt: dateRange(filter.since, filter.until),
      },
    },
    ...dedupeBy({ outboxId: "$outboxId" }),
    { $group: { _id: { month: MONTH("$occurredAt"), type: "$type" }, events: { $sum: 1 } } },
    { $project: { _id: 0, month: "$_id.month", type: "$_id.type", events: 1 } },
    { $sort: { month: 1, type: 1 } },
  ];
}

// The part of a driver Collection the runners use.
export type Aggregatable = { aggregate(pipeline: Pipeline): { toArray(): Promise<unknown[]> } };

export async function monthlyActivity(commitFiles: Aggregatable, filter: AnalyticsFilter = {}): Promise<MonthlyActivityRow[]> {
  return (await commitFiles.aggregate(monthlyActivityPipeline(filter)).toArray()) as MonthlyActivityRow[];
}

export async function topFiles(commitFiles: Aggregatable, filter: AnalyticsFilter = {}, limit?: number): Promise<TopFileRow[]> {
  return (await commitFiles.aggregate(topFilesPipeline(filter, limit)).toArray()) as TopFileRow[];
}

export async function monthlyEvents(activityEvents: Aggregatable, filter: EventFilter = {}): Promise<MonthlyEventRow[]> {
  return (await activityEvents.aggregate(monthlyEventsPipeline(filter)).toArray()) as MonthlyEventRow[];
}
