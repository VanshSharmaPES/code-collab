import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession } from "@/lib/session";
import { parseId } from "@/lib/issue-input";
import { EVIDENCE_LIMIT, commitUrl, getMemberEvidence, type MemberEvidence } from "@/lib/contributions";
import { formatDate, formatLabel } from "@/lib/format";

export const metadata: Metadata = { title: "Member contributions | CodeCollab" };

const H2 = "mt-8 text-lg font-semibold";
const TH = "px-3 py-2 font-medium";
const ROW = "border-b border-zinc-200 dark:border-zinc-800";

function Section({ title, shown, total, children }: { title: string; shown: number; total: number; children: React.ReactNode }) {
  return (
    <section>
      <h2 className={H2}>{title} <span className="text-sm font-normal text-zinc-600 dark:text-zinc-400">({total})</span></h2>
      {shown === 0 ? (
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">None.</p>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm">{children}</table>
          {total > shown && <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">Showing the {shown} most recent of {total}.</p>}
        </div>
      )}
    </section>
  );
}

export default async function MemberContributionPage({ params }: { params: Promise<{ projectId: string; userId: string }> }) {
  const session = await requireSession();
  const p = await params;
  const projectId = parseId(p.projectId);
  const userId = parseId(p.userId);
  if (projectId === null || userId === null) notFound();

  let data: MemberEvidence | null;
  try {
    data = await getMemberEvidence(projectId, userId, session.userId);
  } catch (err) {
    console.error("Member contribution page: could not load the evidence:", err instanceof Error ? err.message : err);
    return (
      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-10">
        <p role="alert" className="text-red-700 dark:text-red-400">This member&apos;s contributions could not be loaded right now. Please try again later.</p>
      </main>
    );
  }
  if (data === null) notFound();
  const { member: m } = data;

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-10">
      <p className="text-sm"><Link href={`/contributions?project=${projectId}`} className="underline">← All members</Link></p>
      <h1 className="mt-4 text-2xl font-semibold tracking-tight">{m.full_name}</h1>
      <dl className="mt-4 grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm">
        <dt className="font-medium">Role</dt><dd className="capitalize">{m.role}</dd>
        <dt className="font-medium">Commits</dt><dd>{m.commits}</dd>
        <dt className="font-medium">PRs opened / merged</dt><dd>{m.prs_opened} / {m.prs_merged}</dd>
        <dt className="font-medium">Reviews given</dt><dd>{m.reviews_given}</dd>
        <dt className="font-medium">Issues closed</dt><dd>{m.issues_closed}</dd>
        <dt className="font-medium">Score</dt><dd className="font-medium">{m.score}</dd>
      </dl>
      <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">Each list below shows the records counted above (the {EVIDENCE_LIMIT} most recent).</p>

      <Section title="Commits" shown={data.commits.length} total={m.commits}>
        <thead><tr className="border-b border-zinc-300 dark:border-zinc-700">
          <th scope="col" className={TH}>Commit</th><th scope="col" className={TH}>Message</th><th scope="col" className={TH}>Repository</th>
          <th scope="col" className={`${TH} text-right`}>+/−</th><th scope="col" className={TH}>Date</th>
        </tr></thead>
        <tbody>
          {data.commits.map((c) => {
            const url = commitUrl(c.github_url, c.sha);
            return (
              <tr key={c.id} className={ROW}>
                <td className="px-3 py-2 font-mono">{url ? <a href={url} className="underline" rel="noreferrer">{c.sha.slice(0, 7)}</a> : c.sha.slice(0, 7)}</td>
                <td className="px-3 py-2">{c.message.split("\n")[0]}</td>
                <td className="px-3 py-2">{c.repository_name}</td>
                <td className="px-3 py-2 text-right tabular-nums">+{c.additions} −{c.deletions}</td>
                <td className="px-3 py-2">{formatDate(c.committed_at)}</td>
              </tr>
            );
          })}
        </tbody>
      </Section>

      <Section title="Pull requests opened" shown={data.pullRequests.length} total={m.prs_opened}>
        <thead><tr className="border-b border-zinc-300 dark:border-zinc-700">
          <th scope="col" className={TH}>Pull request</th><th scope="col" className={TH}>Repository</th><th scope="col" className={TH}>Status</th><th scope="col" className={TH}>Updated</th>
        </tr></thead>
        <tbody>
          {data.pullRequests.map((r) => (
            <tr key={r.id} className={ROW}>
              <td className="px-3 py-2"><Link href={`/pull-requests/${r.id}`} className="underline">#{r.number} {r.title}</Link></td>
              <td className="px-3 py-2">{r.repository_name}</td>
              <td className="px-3 py-2 capitalize">{formatLabel(r.status)}</td>
              <td className="px-3 py-2">{formatDate(r.updated_at)}</td>
            </tr>
          ))}
        </tbody>
      </Section>

      <Section title="Reviews given" shown={data.reviews.length} total={m.reviews_given}>
        <thead><tr className="border-b border-zinc-300 dark:border-zinc-700">
          <th scope="col" className={TH}>Pull request</th><th scope="col" className={TH}>Repository</th><th scope="col" className={TH}>Verdict</th><th scope="col" className={TH}>Date</th>
        </tr></thead>
        <tbody>
          {data.reviews.map((r) => (
            <tr key={r.id} className={ROW}>
              <td className="px-3 py-2"><Link href={`/pull-requests/${r.pull_request_id}`} className="underline">#{r.number} {r.title}</Link></td>
              <td className="px-3 py-2">{r.repository_name}</td>
              <td className="px-3 py-2 capitalize">{formatLabel(r.verdict)}</td>
              <td className="px-3 py-2">{formatDate(r.submitted_at)}</td>
            </tr>
          ))}
        </tbody>
      </Section>

      <Section title="Issues closed by merged pull requests" shown={data.issues.length} total={m.issues_closed}>
        <thead><tr className="border-b border-zinc-300 dark:border-zinc-700">
          <th scope="col" className={TH}>Issue</th><th scope="col" className={TH}>Repository</th><th scope="col" className={TH}>Closed by</th><th scope="col" className={TH}>Closed</th>
        </tr></thead>
        <tbody>
          {data.issues.map((i) => (
            <tr key={i.id} className={ROW}>
              <td className="px-3 py-2"><Link href={`/issues/${i.id}`} className="underline">#{i.number} {i.title}</Link></td>
              <td className="px-3 py-2">{i.repository_name}</td>
              <td className="px-3 py-2"><Link href={`/pull-requests/${i.pull_request_id}`} className="underline">PR #{i.pull_request_number}</Link></td>
              <td className="px-3 py-2">{formatDate(i.closed_at)}</td>
            </tr>
          ))}
        </tbody>
      </Section>
    </main>
  );
}
