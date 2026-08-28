"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Ban, ExternalLink, GitPullRequest, Pause, Play, Send } from "lucide-react";
import type { Run, RunStepRow } from "@/lib/db/schema";
import type { ControlAction, RunConfig } from "@/lib/runs/types";
import { getRunAdapter } from "@/lib/runs/adapters";
import { attributionByTool, attributionBySkill, stepTypeCounts } from "@/lib/runs/attribution";
import { RunStatusBadge } from "@/components/run-status-badge";
import { Button } from "@/components/ui/button";
import { BarSeries, type BarDatum } from "@/components/charts/bar-series";
import { DonutChart, type DonutDatum } from "@/components/charts/donut-chart";
import { formatDuration, formatTokens, formatUsd, timeAgo } from "@/lib/format";
import { MonoText } from "@/components/mono-text";

const STEP_TYPE_COLORS = [
  "var(--accent-blue)",
  "var(--accent-orange)",
  "var(--accent-purple)",
  "var(--accent-green)",
  "var(--accent-amber)",
];

const inputClass =
  "w-full rounded-md border border-outline-variant bg-surface px-2.5 py-1.5 text-xs text-on-surface placeholder:text-on-surface-variant/60 outline-none transition-colors focus:border-outline";

const STEP_LABEL: Record<RunStepRow["type"], string> = {
  system: "System",
  message: "Message",
  tool_use: "Tool call",
  tool_result: "Tool result",
  usage: "Usage",
  gate: "Gate",
  verify: "Verification",
  error: "Error",
};

/** True once a run can no longer change or receive control actions. */
function isTerminal(status: Run["status"]): boolean {
  return status === "done" || status === "failed" || status === "cancelled";
}

export function RunCockpit({
  owner,
  repoName,
  initial,
}: {
  owner: string;
  repoName: string;
  initial: { run: Run; steps: RunStepRow[] };
}) {
  const [run, setRun] = useState<Run>(initial.run);
  const [steps, setSteps] = useState<RunStepRow[]>(initial.steps);
  const [connected, setConnected] = useState(false);
  const [pendingAction, setPendingAction] = useState<ControlAction | null>(null);
  const [controlError, setControlError] = useState<string | null>(null);
  const [guidance, setGuidance] = useState("");
  const wsRef = useRef<WebSocket | null>(null);
  const [openingPr, setOpeningPr] = useState(false);
  const [prResult, setPrResult] = useState<{ url: string; number: number } | null>(null);
  const [prError, setPrError] = useState<string | null>(null);

  useEffect(() => {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(
      `${proto}//${window.location.host}/api/runs/stream?runId=${encodeURIComponent(run.id)}`,
    );
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onmessage = (ev) => {
      let msg: { type: string; run?: Run; step?: RunStepRow; steps?: RunStepRow[]; ok?: boolean; reason?: string; action?: ControlAction };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.type === "init" && msg.run) {
        setRun(msg.run);
        if (msg.steps) setSteps(msg.steps as RunStepRow[]);
      } else if (msg.type === "status" && msg.run) {
        setRun(msg.run);
      } else if (msg.type === "step" && msg.step) {
        setSteps((prev) => [...prev, msg.step as RunStepRow]);
      } else if (msg.type === "control_result") {
        setPendingAction(null);
        if (!msg.ok) setControlError(msg.reason ?? "Control action rejected.");
      }
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [run.id]);

  function sendControl(action: ControlAction, payload?: { text?: string }) {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    setControlError(null);
    setPendingAction(action);
    ws.send(JSON.stringify({ action, payload }));
  }

  function handleSendGuidance() {
    const text = guidance.trim();
    if (!text) return;
    sendControl("inject", { text });
    setGuidance("");
  }

  async function handleOpenDraftPr() {
    if (!run.actionItemId) return;
    setOpeningPr(true);
    setPrError(null);
    try {
      const res = await fetch("/api/pulls", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actionItemId: run.actionItemId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to open draft PR.");
      const item = data.actionItem as { githubPrUrl?: string | null; githubPrNumber?: number | null };
      if (item.githubPrUrl && item.githubPrNumber) {
        setPrResult({ url: item.githubPrUrl, number: item.githubPrNumber });
      }
    } catch (err) {
      setPrError(err instanceof Error ? err.message : "Failed to open draft PR.");
    } finally {
      setOpeningPr(false);
    }
  }

  const adapter = getRunAdapter(run.agentId);
  const canPause = adapter?.supportsStructuredStream ?? false;
  const terminal = isTerminal(run.status);

  // configJson carries the run's own RunConfig — interactive is only real
  // (and inject only listened for server-side) when the run was actually
  // started that way, regardless of what the adapter can support in general.
  const isInteractive = useMemo(() => {
    try {
      return Boolean((JSON.parse(run.configJson ?? "{}") as RunConfig).interactive);
    } catch {
      return false;
    }
  }, [run.configJson]);
  const canInject = (adapter?.supportsInjection ?? false) && isInteractive;

  const byTool = useMemo(() => attributionByTool(steps), [steps]);
  const bySkill = useMemo(() => attributionBySkill(steps), [steps]);
  const byType = useMemo(() => stepTypeCounts(steps), [steps]);
  const tokensByToolData: BarDatum[] = byTool.map((r) => ({ label: r.key, value: r.tokens }));
  const stepsByTypeData: DonutDatum[] = byType.map((r, i) => ({
    label: r.key,
    value: r.count,
    color: STEP_TYPE_COLORS[i % STEP_TYPE_COLORS.length],
  }));

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-outline-variant px-4 py-3 sm:px-6">
        <div className="flex items-center gap-3">
          <Link
            href={`/project/${owner}/${repoName}`}
            className="flex items-center gap-1 text-xs text-on-surface-variant hover:text-on-surface"
          >
            <ArrowLeft className="size-3.5" />
            {owner}/{repoName}
          </Link>
          <span className="text-on-surface-variant">/</span>
          <RunStatusBadge status={run.status} />
          <span className="text-xs text-on-surface-variant">
            {run.agentId}
            {run.model ? ` · ${run.model}` : ""}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {run.status === "done" && run.actionItemId && !prResult && (
            <Button size="sm" variant="outline" disabled={openingPr} onClick={handleOpenDraftPr}>
              <GitPullRequest className="size-3.5" /> {openingPr ? "Opening…" : "Open draft PR"}
            </Button>
          )}
          {prResult && (
            <a
              href={prResult.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded-md border border-outline-variant px-2 py-1 text-xs text-accent-purple hover:bg-white/5"
            >
              <GitPullRequest className="size-3.5" /> View PR #{prResult.number} <ExternalLink className="size-3" />
            </a>
          )}
          {!terminal && canPause && run.status === "running" && (
            <Button size="sm" variant="outline" disabled={pendingAction !== null} onClick={() => sendControl("pause")}>
              <Pause className="size-3.5" /> Pause
            </Button>
          )}
          {!terminal && canPause && run.status === "paused" && (
            <Button size="sm" variant="outline" disabled={pendingAction !== null} onClick={() => sendControl("resume")}>
              <Play className="size-3.5" /> Resume
            </Button>
          )}
          {!terminal && (
            <Button size="sm" variant="destructive" disabled={pendingAction !== null} onClick={() => sendControl("cancel")}>
              <Ban className="size-3.5" /> Cancel
            </Button>
          )}
        </div>
      </div>

      {prError && (
        <div className="border-b border-outline-variant bg-accent-orange-bg px-4 py-2 text-xs text-accent-orange sm:px-6">
          {prError}
        </div>
      )}

      {controlError && (
        <div className="border-b border-outline-variant bg-accent-orange-bg px-4 py-2 text-xs text-accent-orange sm:px-6">
          {controlError}
        </div>
      )}

      {/* Running meters */}
      <div className="grid grid-cols-2 gap-3 border-b border-outline-variant px-4 py-3 text-xs sm:grid-cols-4 sm:px-6">
        <Meter label="Tokens" value={formatTokens(run.totalTokens)} />
        <Meter label="Est. cost" value={formatUsd(run.costEstimate)} />
        <Meter label="Duration" value={formatDuration(run.durationMs)} />
        <Meter
          label="Verification"
          value={run.verifyPassed == null ? "—" : run.verifyPassed ? "Passed" : "Failed"}
        />
      </div>

      {!connected && !terminal && (
        <div className="border-b border-outline-variant bg-surface-container-low px-4 py-1.5 text-[11px] text-on-surface-variant sm:px-6">
          Reconnecting…
        </div>
      )}

      {!terminal && canInject && (
        <div className="flex items-center gap-2 border-b border-outline-variant px-4 py-2 sm:px-6">
          <input
            value={guidance}
            onChange={(e) => setGuidance(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSendGuidance();
              }
            }}
            placeholder="Send follow-up guidance…"
            className={inputClass}
          />
          <Button size="sm" variant="outline" disabled={!guidance.trim() || pendingAction !== null} onClick={handleSendGuidance}>
            <Send className="size-3.5" /> Send
          </Button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-4 sm:p-6">
        {/* Attribution */}
        {steps.length > 0 && (
          <div className="mb-5 flex flex-col gap-4 rounded-lg border border-outline-variant p-3 sm:flex-row sm:gap-6">
            <div className="flex-1">
              <p className="mb-2 text-[11px] font-bold uppercase tracking-wide text-on-surface-variant">
                Tokens by tool
              </p>
              <BarSeries data={tokensByToolData} title="Tokens by tool" height={48} emptyText="No tool calls yet." />
            </div>
            <div className="flex-1">
              <p className="mb-2 text-[11px] font-bold uppercase tracking-wide text-on-surface-variant">
                Steps by type
              </p>
              <DonutChart data={stepsByTypeData} title="Steps by type" />
            </div>
            {(byTool.length > 0 || bySkill.length > 0) && (
              <div className="flex-1">
                <p className="mb-2 text-[11px] font-bold uppercase tracking-wide text-on-surface-variant">
                  Cost by tool / skill
                </p>
                <ul className="flex flex-col gap-1 text-xs">
                  {byTool.map((r) => (
                    <li key={`tool-${r.key}`} className="flex items-center justify-between gap-2 text-on-surface-variant">
                      <MonoText size="sm">{r.key}</MonoText>
                      <span>{formatUsd(r.costMicroUsd)}</span>
                    </li>
                  ))}
                  {bySkill.map((r) => (
                    <li key={`skill-${r.key}`} className="flex items-center justify-between gap-2 text-on-surface-variant">
                      <span className="rounded bg-accent-purple-bg px-1.5 py-0.5 text-[10px] text-accent-purple">
                        {r.key}
                      </span>
                      <span>{formatUsd(r.costMicroUsd)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {/* Step timeline */}
        {steps.length === 0 ? (
          <p className="text-xs text-on-surface-variant">No steps recorded yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {steps.map((step) => (
              <StepRow key={step.id} step={step} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Meter({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] font-medium uppercase tracking-wide text-on-surface-variant">{label}</span>
      <span className="font-medium text-on-surface">{value}</span>
    </div>
  );
}

function StepRow({ step }: { step: RunStepRow }) {
  return (
    <li className="rounded-md border border-outline-variant px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-on-surface-variant">{STEP_LABEL[step.type]}</span>
        {step.tool && <MonoText size="sm" muted>{step.tool}</MonoText>}
        {step.skill && (
          <span className="rounded bg-accent-purple-bg px-1.5 py-0.5 text-[10px] text-accent-purple">
            {step.skill}
          </span>
        )}
        <span className="ml-auto text-[10px] text-on-surface-variant">{timeAgo(step.createdAt)}</span>
      </div>
      {step.title && <p className="mt-1 text-on-surface">{step.title}</p>}
      {(step.promptTokens != null || step.costEstimate != null) && (
        <p className="mt-1 text-[10px] text-on-surface-variant">
          {step.promptTokens != null &&
            `${formatTokens((step.promptTokens ?? 0) + (step.completionTokens ?? 0))} · `}
          {formatUsd(step.costEstimate)}
        </p>
      )}
    </li>
  );
}
