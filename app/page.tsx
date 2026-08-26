import { getRepoCards, type RepoCardData } from "@/lib/repos";
import { getPortfolioSummary, type PortfolioSummary } from "@/lib/portfolio";
import { PageHeader } from "@/components/page-header";

// This dashboard's data (GitHub state, sync status) changes on every visit —
// never let the build bake in a stale snapshot.
export const dynamic = "force-dynamic";
import { GitHubConfigError, GitHubRateLimitError } from "@/lib/github";
import { RepoGrid } from "@/components/repo-grid";
import { PortfolioStrip } from "@/components/portfolio-strip";
import { ConfigNotice } from "@/components/config-notice";
import { RateLimitNotice } from "@/components/rate-limit-notice";

type LoadError =
  | { type: "config"; message: string }
  | { type: "rate_limit"; resetAt: number };

export default async function HubPage() {
  let repos: RepoCardData[] | null = null;
  let portfolio: PortfolioSummary | null = null;
  let error: LoadError | null = null;

  try {
    repos = await getRepoCards();
    portfolio = await getPortfolioSummary(repos);
  } catch (err) {
    if (err instanceof GitHubConfigError) {
      error = { type: "config", message: err.message };
    } else if (err instanceof GitHubRateLimitError) {
      error = { type: "rate_limit", resetAt: err.resetAt };
    } else {
      throw err;
    }
  }

  if (error) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center px-4">
        {error.type === "config" ? (
          <ConfigNotice message={error.message} />
        ) : (
          <RateLimitNotice resetAt={error.resetAt} />
        )}
      </div>
    );
  }

  return (
    <div className="px-4 py-6 sm:px-6">
      <PageHeader title="Overview" description="Your side-projects, at a glance." />
      {portfolio && <PortfolioStrip summary={portfolio} />}
      <RepoGrid repos={repos!} />
    </div>
  );
}
