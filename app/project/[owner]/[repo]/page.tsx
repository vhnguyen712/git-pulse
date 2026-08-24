import { getWorkspaceData, type WorkspaceData } from "@/lib/workspace";

// Always reflect live commit/analysis state — never statically cached.
export const dynamic = "force-dynamic";
import { GitHubConfigError, GitHubRateLimitError } from "@/lib/github";
import { ConfigNotice } from "@/components/config-notice";
import { RateLimitNotice } from "@/components/rate-limit-notice";
import { Workspace } from "@/components/workspace";

type LoadError =
  | { type: "config"; message: string }
  | { type: "rate_limit"; resetAt: number };

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ owner: string; repo: string }>;
}) {
  const { owner, repo } = await params;

  let data: WorkspaceData | null = null;
  let error: LoadError | null = null;

  try {
    data = await getWorkspaceData(owner, repo);
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

  return <Workspace owner={owner} repoName={repo} initial={data!} />;
}
