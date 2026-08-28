import { notFound } from "next/navigation";
import { getRunView } from "@/lib/runs/view";
import { RunCockpit } from "@/components/run-cockpit";

// A run's status/timeline changes live — never statically cached.
export const dynamic = "force-dynamic";

export default async function RunPage({
  params,
}: {
  params: Promise<{ owner: string; repo: string; runId: string }>;
}) {
  const { owner, repo, runId } = await params;
  const view = await getRunView(runId);
  if (!view) notFound();

  return <RunCockpit owner={owner} repoName={repo} initial={view} />;
}
