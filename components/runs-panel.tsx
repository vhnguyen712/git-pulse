"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Play } from "lucide-react";
import type { ActionItem, Run } from "@/lib/db/schema";
import { AGENT_LIST } from "@/lib/terminal/agents";
import { RunStatusBadge } from "@/components/run-status-badge";
import { RunCompare } from "@/components/run-compare";
import { Button } from "@/components/ui/button";
import { formatTokens, formatUsd, timeAgo } from "@/lib/format";

const inputClass =
  "w-full rounded-md border border-outline-variant bg-surface px-2.5 py-1.5 text-xs text-on-surface placeholder:text-on-surface-variant/60 outline-none transition-colors focus:border-outline";

/**
 * The Runs tab: lists this project's instrumented agent runs (see
 * docs/build-plan.md) and lets the user launch a new one — either freeform or
 * seeded from one of the project's action items.
 */
export function RunsPanel({
  projectId,
  owner,
  repoName,
  actionItems,
}: {
  projectId: string;
  owner: string;
  repoName: string;
  actionItems: ActionItem[];
}) {
  const router = useRouter();
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const [agentId, setAgentId] = useState(AGENT_LIST[0]?.id ?? "claude");
  const [actionItemId, setActionItemId] = useState<string>("");
  const [prompt, setPrompt] = useState("");
  const [verify, setVerify] = useState(false);
  const [interactive, setInteractive] = useState(false);
  const [budgetTokens, setBudgetTokens] = useState("");
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const [compareIds, setCompareIds] = useState<string[]>([]);
  function toggleCompare(runId: string) {
    setCompareIds((prev) => {
      if (prev.includes(runId)) return prev.filter((id) => id !== runId);
      if (prev.length >= 2) return prev; // cap at two — deselect one first
      return [...prev, runId];
    });
  }

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(`/api/runs?projectId=${encodeURIComponent(projectId)}`);
        if (!res.ok) throw new Error("Failed to load runs.");
        const data = (await res.json()) as { runs: Run[] };
        if (!cancelled) setRuns(data.runs);
      } catch (err) {
        if (!cancelled) setListError(err instanceof Error ? err.message : "Failed to load runs.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  function handleActionItemChange(id: string) {
    setActionItemId(id);
    const item = actionItems.find((i) => i.id === id);
    if (item) setPrompt([item.title, item.description ?? ""].filter(Boolean).join("\n\n"));
  }

  async function handleStart(e: React.FormEvent) {
    e.preventDefault();
    if (!prompt.trim()) return;
    setStarting(true);
    setStartError(null);
    try {
      const res = await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          actionItemId: actionItemId || undefined,
          agentId,
          config: {
            prompt: prompt.trim(),
            verify,
            interactive,
            budgetTokens: budgetTokens ? Number(budgetTokens) : undefined,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to start run.");
      router.push(`/project/${owner}/${repoName}/runs/${data.runId}`);
    } catch (err) {
      setStartError(err instanceof Error ? err.message : "Failed to start run.");
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <form onSubmit={handleStart} className="flex flex-col gap-3 rounded-lg border border-outline-variant p-3">
        <p className="text-[11px] font-bold uppercase tracking-wide text-on-surface-variant">Start a run</p>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-[11px] text-on-surface-variant">
            Agent
            <select value={agentId} onChange={(e) => setAgentId(e.target.value)} className={inputClass}>
              {AGENT_LIST.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
          </label>

          {actionItems.length > 0 && (
            <label className="flex flex-col gap-1 text-[11px] text-on-surface-variant">
              Seed from action item (optional)
              <select
                value={actionItemId}
                onChange={(e) => handleActionItemChange(e.target.value)}
                className={inputClass}
              >
                <option value="">— freeform —</option>
                {actionItems.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        <label className="flex flex-col gap-1 text-[11px] text-on-surface-variant">
          Prompt
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={3}
            placeholder="What should the agent do?"
            className={inputClass}
          />
        </label>

        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-1.5 text-[11px] text-on-surface-variant">
            <input type="checkbox" checked={verify} onChange={(e) => setVerify(e.target.checked)} />
            Verify on completion (runs the repo&apos;s own test/lint — no extra agent tokens)
          </label>
          <label className="flex items-center gap-1.5 text-[11px] text-on-surface-variant">
            <input type="checkbox" checked={interactive} onChange={(e) => setInteractive(e.target.checked)} />
            Interactive (keep the run open to send follow-up guidance — supported agents only)
          </label>
          <label className="flex items-center gap-1.5 text-[11px] text-on-surface-variant">
            Token budget
            <input
              type="number"
              inputMode="numeric"
              min={0}
              value={budgetTokens}
              onChange={(e) => setBudgetTokens(e.target.value)}
              placeholder="none"
              className={`${inputClass} w-24`}
            />
          </label>
        </div>

        {startError && <p className="text-xs text-accent-orange">{startError}</p>}

        <Button type="submit" size="sm" disabled={starting || !prompt.trim()} className="w-fit">
          <Play className="size-3.5" /> {starting ? "Starting…" : "Start run"}
        </Button>
      </form>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <p className="text-[11px] font-bold uppercase tracking-wide text-on-surface-variant">Runs</p>
          {compareIds.length > 0 && (
            <p className="text-[11px] text-on-surface-variant">
              {compareIds.length === 2 ? "Comparing 2 runs" : "Select one more run to compare"}
              {" · "}
              <button type="button" className="underline hover:no-underline" onClick={() => setCompareIds([])}>
                clear
              </button>
            </p>
          )}
        </div>
        {loading ? (
          <p className="text-xs text-on-surface-variant">Loading…</p>
        ) : listError ? (
          <p className="text-xs text-accent-orange">{listError}</p>
        ) : runs.length === 0 ? (
          <p className="text-xs text-on-surface-variant">No runs yet.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {runs.map((run) => (
              <li key={run.id} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  aria-label={`Select run ${run.id.slice(0, 8)} for comparison`}
                  checked={compareIds.includes(run.id)}
                  disabled={!compareIds.includes(run.id) && compareIds.length >= 2}
                  onChange={() => toggleCompare(run.id)}
                />
                <Link
                  href={`/project/${owner}/${repoName}/runs/${run.id}`}
                  className="flex flex-1 flex-wrap items-center gap-2 rounded-md border border-outline-variant px-3 py-2 text-xs hover:bg-white/[0.03]"
                >
                  <RunStatusBadge status={run.status} />
                  <span className="text-on-surface">{run.agentId}</span>
                  <span className="text-on-surface-variant">{formatTokens(run.totalTokens)}</span>
                  <span className="text-on-surface-variant">{formatUsd(run.costEstimate)}</span>
                  <span className="ml-auto text-[10px] text-on-surface-variant">{timeAgo(run.createdAt)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      {compareIds.length === 2 && (
        <div className="flex flex-col gap-2">
          <p className="text-[11px] font-bold uppercase tracking-wide text-on-surface-variant">Compare</p>
          <RunCompare owner={owner} repoName={repoName} runIds={[compareIds[0], compareIds[1]]} />
        </div>
      )}
    </div>
  );
}
