import type { Metadata } from "next";
import Link from "next/link";
import { requireSession } from "@/lib/session";
import { embedTexts } from "@/lib/embedder";
import { MAX_QUERY_LENGTH, MIN_QUERY_LENGTH, parseSearchQuery, searchKeyword, searchSemantic, type SearchHit } from "@/lib/search";

export const metadata: Metadata = { title: "Search | CodeCollab" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const KIND_LABEL = { issue: "Issue", pull_request: "Pull request", commit: "Commit" } as const;

function Results({ title, note, hits, failed, scoreLabel }: { title: string; note: string; hits: SearchHit[] | null; failed: string; scoreLabel: (score: number) => string }) {
  return (
    <section>
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">{note}</p>
      {hits === null ? (
        <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-400">{failed}</p>
      ) : hits.length === 0 ? (
        <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">No results.</p>
      ) : (
        <ol className="mt-3 flex flex-col gap-3 text-sm">
          {hits.map((h) => (
            <li key={`${h.kind}-${h.id}`}>
              <div className="flex items-baseline justify-between gap-3">
                <span>
                  <span className="mr-2 text-xs uppercase tracking-wide text-zinc-600 dark:text-zinc-400">{KIND_LABEL[h.kind]}</span>
                  {h.kind === "issue" ? <Link href={`/issues/${h.id}`} className="underline">#{h.number} {h.title}</Link>
                    : h.kind === "pull_request" ? <Link href={`/pull-requests/${h.id}`} className="underline">#{h.number} {h.title}</Link>
                    : <span>{h.title}</span>}
                </span>
                <span className="shrink-0 tabular-nums text-zinc-600 dark:text-zinc-400">{scoreLabel(h.score)}</span>
              </div>
              <div className="text-xs text-zinc-600 dark:text-zinc-400">{h.repository_name}</div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export default async function SearchPage({ searchParams }: { searchParams: SearchParams }) {
  await requireSession();
  const sp = await searchParams;
  const raw = typeof sp.q === "string" ? sp.q : "";
  const text = parseSearchQuery(raw);

  let keyword: SearchHit[] | null = [];
  let semantic: SearchHit[] | null = [];
  if (text !== null) {
    // The two searches are independent: if one cannot run, the other is still shown.
    const [k, s] = await Promise.allSettled([
      searchKeyword(text),
      embedTexts([text]).then(([vector]) => searchSemantic(vector)),
    ]);
    keyword = k.status === "fulfilled" ? k.value : null;
    semantic = s.status === "fulfilled" ? s.value : null;
    if (k.status === "rejected") console.error("Search page: keyword search failed:", k.reason instanceof Error ? k.reason.message : k.reason);
    if (s.status === "rejected") console.error("Search page: semantic search failed:", s.reason instanceof Error ? s.reason.message : s.reason);
  }

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Search</h1>
      <form method="get" className="mt-6 flex flex-wrap items-end gap-3 text-sm">
        <label className="flex-1">Search issues, pull requests and commits
          <input name="q" defaultValue={raw} maxLength={MAX_QUERY_LENGTH} className="mt-1 w-full rounded border border-zinc-300 bg-transparent px-3 py-2 dark:border-zinc-700" />
        </label>
        <button type="submit" className="rounded border border-zinc-400 px-4 py-2">Search</button>
      </form>

      {raw !== "" && text === null && (
        <p role="alert" className="mt-4 text-sm text-red-700 dark:text-red-400">Enter {MIN_QUERY_LENGTH} to {MAX_QUERY_LENGTH} characters.</p>
      )}
      {text !== null && (
        <div className="mt-8 grid gap-8 md:grid-cols-2">
          <Results title="Keyword search" note="Matches the words you typed (PostgreSQL full-text search)." hits={keyword}
            failed="Keyword search is not available right now." scoreLabel={(s) => s.toFixed(3)} />
          <Results title="Semantic search" note="Matches the meaning, using a local sentence-transformer and pgvector. The number is cosine similarity." hits={semantic}
            failed="Semantic search is not available right now. Embeddings may not have been created yet (npm run embed)." scoreLabel={(s) => s.toFixed(3)} />
        </div>
      )}
    </main>
  );
}
