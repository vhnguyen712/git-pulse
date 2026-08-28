"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { Run, RunStepRow } from "@/lib/db/schema";
import { attributionByTool } from "@/lib/runs/attribution";
import { RunStatusBadge } from "@/components/run-status-badge";
import { formatDuration, formatTokens, formatUsd, timeAgo } from "@/lib/format";

interface RunDetail {
  run: Run;
  steps: RunStepRow[];
}

/** Side-by-side comparison of two runs — cost, tokens, duration, outcome, and top tools by usage. */
export function RunCompare({
  owner,
  repoName,
  runIds,
}: {
  owner: string;
  repoName: string;
  runIds: [string, string];
}) {
  const [details, setDetails] = useState<RunDetail[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [firstId, secondId] = runIds;
  useEffect(() => {
    let cancelled = false;
    Promise.all(
      [firstId, secondId].map(async (id) => {
        const res = await fetch(`/api/runs/${id}`);
        if (!res.ok) throw new Error("Failed to load a run for comparison.");
        return (await res.json()) as RunDetail;
      }),
    )
      .then((loaded) => {
        if (!cancelled) {
          setDetails(loaded);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load runs.");
      });
    return () => {
      cancelled = true;
    };
  }, [firstId, secondId]);

  // Loaded data may lag a runIds change by one render (the effect above hasn't
  // resolved yet) — checking the ids themselves (not just presence) avoids
  // flashing the previous comparison's data under the new selection.
  const isCurrent = details?.length === runIds.length && details.every((d, i) => d.run.id === runIds[i]);

  if (error) return <p className="text-xs text-accent-orange">{error}</p>;
  if (!isCurrent || !details) return <p className="text-xs text-on-surface-variant">Loading comparison…</p>;

  const rows: { label: string; render: (d: RunDetail) => React.ReactNode }[] = [
    { label: "Status", render: (d) => <RunStatusBadge status={d.run.status} /> },
    { label: "Agent", render: (d) => `${d.run.agentId}${d.run.model ? ` · ${d.run.model}` : ""}` },
    { label: "Tokens", render: (d) => formatTokens(d.run.totalTokens) },
    { label: "Est. cost", render: (d) => formatUsd(d.run.costEstimate) },
    { label: "Duration", render: (d) => formatDuration(d.run.durationMs) },
    { label: "Steps", render: (d) => String(d.steps.length) },
    {
      label: "Verification",
      render: (d) => (d.run.verifyPassed == null ? "—" : d.run.verifyPassed ? "Passed" : "Failed"),
    },
    {
      label: "Top tool (tokens)",
      render: (d) => {
        const top = attributionByTool(d.steps)[0];
        return top ? `${top.key} (${formatTokens(top.tokens)})` : "—";
      },
    },
    { label: "Started", render: (d) => timeAgo(d.run.createdAt) },
  ];

  return (
    <div className="overflow-x-auto rounded-lg border border-outline-variant">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-outline-variant text-on-surface-variant">
            <th className="px-3 py-2 text-left font-medium"> </th>
            {details.map((d) => (
              <th key={d.run.id} className="px-3 py-2 text-left font-medium">
                <Link
                  href={`/project/${owner}/${repoName}/runs/${d.run.id}`}
                  className="text-on-surface hover:underline"
                >
                  Run {d.run.id.slice(0, 8)}
                </Link>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label} className="border-b border-outline-variant last:border-0">
              <td className="px-3 py-1.5 text-on-surface-variant">{row.label}</td>
              {details.map((d) => (
                <td key={d.run.id} className="px-3 py-1.5 text-on-surface">
                  {row.render(d)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
