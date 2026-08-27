"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import type { SettingsResponse } from "@/app/api/settings/route";
import { AGENT_LIST } from "@/lib/terminal/agents";
import { cn } from "@/lib/utils";

type Source = "settings" | "env" | "none";

function SourceTag({ source }: { source: Source }) {
  if (source === "settings") {
    return <span className="text-[11px] text-accent-green">saved in Settings</span>;
  }
  if (source === "env") {
    return <span className="text-[11px] text-accent-blue">from .env.local</span>;
  }
  return <span className="text-[11px] text-on-surface-variant">not configured</span>;
}

function Field({
  label,
  hint,
  children,
  source,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  source: Source;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium text-on-surface">{label}</label>
        <SourceTag source={source} />
      </div>
      {children}
      {hint && <p className="text-[11px] text-on-surface-variant">{hint}</p>}
    </div>
  );
}

const inputClass =
  "w-full rounded-md border border-outline-variant bg-surface px-2.5 py-1.5 text-xs text-on-surface placeholder:text-on-surface-variant/60 outline-none transition-colors focus:border-outline";

interface TestResult {
  ok: boolean;
  warning?: boolean;
  message: string;
}

function TestConnectionRow({
  testing,
  result,
  onTest,
}: {
  testing: boolean;
  result: TestResult | null;
  onTest: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={onTest}
        disabled={testing}
        className="flex items-center gap-1.5 rounded-md border border-outline-variant px-2.5 py-1.5 text-xs text-on-surface transition-colors hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {testing && <Loader2 className="size-3 animate-spin" />}
        Test connection
      </button>
      {result && (
        <span
          className={cn(
            "flex items-center gap-1 text-xs",
            !result.ok
              ? "text-accent-orange"
              : result.warning
                ? "text-accent-amber"
                : "text-accent-green",
          )}
        >
          {result.ok ? (
            <CheckCircle2 className="size-3" />
          ) : (
            <XCircle className="size-3" />
          )}
          {result.message}
        </span>
      )}
    </div>
  );
}

export function SettingsForm() {
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const [githubToken, setGithubToken] = useState("");
  const [llmBaseUrl, setLlmBaseUrl] = useState("");
  const [llmApiKey, setLlmApiKey] = useState("");
  const [llmModel, setLlmModel] = useState("");
  const [cronSecret, setCronSecret] = useState("");
  const [costInput, setCostInput] = useState("");
  const [costOutput, setCostOutput] = useState("");
  const [autoSyncEnabled, setAutoSyncEnabled] = useState(false);
  /** Interval as a raw input string so the field can be cleared; parsed on submit. */
  const [autoSyncInterval, setAutoSyncInterval] = useState("");
  /** Per-agent CLI command override, keyed by agent id — blank means "use the default". */
  const [agentCommands, setAgentCommands] = useState<Record<string, string>>({});

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const [testingGithub, setTestingGithub] = useState(false);
  const [githubTestResult, setGithubTestResult] = useState<TestResult | null>(null);

  const [testingLlm, setTestingLlm] = useState(false);
  const [llmTestResult, setLlmTestResult] = useState<TestResult | null>(null);

  const [clearSettingsChecked, setClearSettingsChecked] = useState(false);
  const [clearSyncDataChecked, setClearSyncDataChecked] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearResult, setClearResult] = useState<TestResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function loadSettings() {
      const res = await fetch("/api/settings");
      const body = (await res.json()) as SettingsResponse;
      if (cancelled) return;
      setData(body);
      setLlmBaseUrl(body.llmBaseUrl ?? "");
      setLlmModel(body.llmModel ?? "");
      setCostInput(body.costPerMillionInput ?? "");
      setCostOutput(body.costPerMillionOutput ?? "");
      setAutoSyncEnabled(body.autoSyncEnabled);
      setAutoSyncInterval(
        body.autoSyncIntervalMinutes != null ? String(body.autoSyncIntervalMinutes) : "",
      );
      setAgentCommands(
        Object.fromEntries(
          AGENT_LIST.map((a) => [a.id, body.agentOverrides[a.id]?.command ?? ""]),
        ),
      );
      setLoading(false);
    }
    loadSettings();
    return () => {
      cancelled = true;
    };
  }, []);

  async function save(payload: Record<string, unknown>) {
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setSaveError(body.error ?? "Failed to save settings.");
        return;
      }
      const body = (await res.json()) as SettingsResponse;
      setData(body);
      setLlmBaseUrl(body.llmBaseUrl ?? "");
      setLlmModel(body.llmModel ?? "");
      setCostInput(body.costPerMillionInput ?? "");
      setCostOutput(body.costPerMillionOutput ?? "");
      setAutoSyncEnabled(body.autoSyncEnabled);
      setAutoSyncInterval(
        body.autoSyncIntervalMinutes != null ? String(body.autoSyncIntervalMinutes) : "",
      );
      setAgentCommands(
        Object.fromEntries(
          AGENT_LIST.map((a) => [a.id, body.agentOverrides[a.id]?.command ?? ""]),
        ),
      );
      setGithubToken("");
      setLlmApiKey("");
      setCronSecret("");
      setSaved(true);
    } catch {
      setSaveError("Network error while saving.");
    } finally {
      setSaving(false);
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmedInterval = autoSyncInterval.trim();
    const parsedInterval = trimmedInterval === "" ? null : Number(trimmedInterval);
    const payload: Record<string, unknown> = {
      llmBaseUrl: llmBaseUrl.trim(),
      llmModel: llmModel.trim(),
      costPerMillionInput: costInput.trim(),
      costPerMillionOutput: costOutput.trim(),
      autoSyncEnabled,
      // Null clears it back to the built-in default; ignore a non-numeric entry.
      autoSyncIntervalMinutes:
        parsedInterval != null && Number.isFinite(parsedInterval) && parsedInterval > 0
          ? Math.floor(parsedInterval)
          : null,
      agentOverrides: Object.fromEntries(
        AGENT_LIST.map((a) => [a.id, { command: agentCommands[a.id]?.trim() || undefined }]),
      ),
    };
    if (githubToken.trim() !== "") payload.githubToken = githubToken.trim();
    if (llmApiKey.trim() !== "") payload.llmApiKey = llmApiKey.trim();
    if (cronSecret.trim() !== "") payload.cronSecret = cronSecret.trim();
    save(payload);
  }

  async function handleTestGithub() {
    setTestingGithub(true);
    setGithubTestResult(null);
    try {
      // Tests whatever is currently typed (even if unsaved); falls back
      // server-side to the saved/env token when the field is left blank.
      const res = await fetch("/api/settings/test-github", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: githubToken.trim() }),
      });
      const body = await res.json().catch(() => ({}));
      if (body.ok) {
        setGithubTestResult({ ok: true, message: `Connected as @${body.login}.` });
      } else {
        setGithubTestResult({ ok: false, message: body.error ?? "Connection failed." });
      }
    } catch {
      setGithubTestResult({ ok: false, message: "Network error while testing." });
    } finally {
      setTestingGithub(false);
    }
  }

  async function handleTestLlm() {
    setTestingLlm(true);
    setLlmTestResult(null);
    try {
      // Same idea as GitHub's test: check the typed values, falling back
      // per-field to the saved/env value when a field is left blank.
      const res = await fetch("/api/settings/test-llm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseUrl: llmBaseUrl.trim(),
          apiKey: llmApiKey.trim(),
          model: llmModel.trim(),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (body.ok) {
        setLlmTestResult({ ok: true, warning: body.warning, message: body.message });
      } else {
        setLlmTestResult({ ok: false, message: body.error ?? "Connection failed." });
      }
    } catch {
      setLlmTestResult({ ok: false, message: "Network error while testing." });
    } finally {
      setTestingLlm(false);
    }
  }

  function clearDataSummary(): string {
    const parts: string[] = [];
    if (clearSettingsChecked) parts.push("saved settings (GitHub token, LLM config, cron secret)");
    if (clearSyncDataChecked) parts.push("all synced projects, AI summaries, and action items");
    return parts.join(" and ");
  }

  function requestClearData() {
    if (!clearSettingsChecked && !clearSyncDataChecked) return;
    setClearResult(null);
    setConfirmingClear(true);
  }

  function cancelClearData() {
    setConfirmingClear(false);
  }

  async function confirmClearData() {
    if (!clearSettingsChecked && !clearSyncDataChecked) {
      setConfirmingClear(false);
      return;
    }
    setConfirmingClear(false);
    setClearing(true);
    setClearResult(null);
    try {
      const res = await fetch("/api/settings/clear-data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clearSettings: clearSettingsChecked,
          clearSyncData: clearSyncDataChecked,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setClearResult({ ok: false, message: body.error ?? "Failed to clear data." });
        return;
      }

      if (clearSettingsChecked) {
        const settingsRes = await fetch("/api/settings");
        const settingsBody = (await settingsRes.json()) as SettingsResponse;
        setData(settingsBody);
        setLlmBaseUrl(settingsBody.llmBaseUrl ?? "");
        setLlmModel(settingsBody.llmModel ?? "");
        setCostInput(settingsBody.costPerMillionInput ?? "");
        setCostOutput(settingsBody.costPerMillionOutput ?? "");
        setAgentCommands(
          Object.fromEntries(
            AGENT_LIST.map((a) => [a.id, settingsBody.agentOverrides[a.id]?.command ?? ""]),
          ),
        );
        setGithubToken("");
        setLlmApiKey("");
        setCronSecret("");
      }

      setClearSettingsChecked(false);
      setClearSyncDataChecked(false);
      setClearResult({ ok: true, message: "Data cleared." });
    } catch {
      setClearResult({ ok: false, message: "Network error while clearing data." });
    } finally {
      setClearing(false);
    }
  }

  if (loading || !data) {
    return <p className="text-xs text-on-surface-variant">Loading settings…</p>;
  }

  return (
    <div className="flex flex-col gap-5">
      <form onSubmit={handleSubmit} className="flex flex-col gap-5">
        <div className="flex flex-col gap-4 rounded-lg border border-outline-variant bg-surface p-4">
          <h2 className="font-heading text-sm font-semibold text-on-surface">GitHub</h2>

          <Field
            label="Personal Access Token"
            source={data.githubTokenSource}
            hint="Fine-grained PAT — Contents: Read-only, Metadata: Read-only, Issues: Read & Write."
          >
            <input
              type="password"
              className={inputClass}
              value={githubToken}
              onChange={(e) => setGithubToken(e.target.value)}
              placeholder={
                data.githubTokenMasked ? `${data.githubTokenMasked} (unchanged)` : "ghp_…"
              }
              autoComplete="off"
            />
          </Field>

          <TestConnectionRow
            testing={testingGithub}
            result={githubTestResult}
            onTest={handleTestGithub}
          />
        </div>

        <div className="flex flex-col gap-4 rounded-lg border border-outline-variant bg-surface p-4">
          <h2 className="font-heading text-sm font-semibold text-on-surface">
            LLM (OpenAI-compatible)
          </h2>

          <Field
            label="Base URL"
            source={data.llmBaseUrlSource}
            hint="e.g. https://api.openai.com/v1, an OpenRouter/Groq/Together endpoint, or a local Ollama URL."
          >
            <input
              type="text"
              className={inputClass}
              value={llmBaseUrl}
              onChange={(e) => setLlmBaseUrl(e.target.value)}
              placeholder="https://api.openai.com/v1"
            />
          </Field>

          <Field label="API Key" source={data.llmApiKeySource}>
            <input
              type="password"
              className={inputClass}
              value={llmApiKey}
              onChange={(e) => setLlmApiKey(e.target.value)}
              placeholder={
                data.llmApiKeyMasked ? `${data.llmApiKeyMasked} (unchanged)` : "sk-…"
              }
              autoComplete="off"
            />
          </Field>

          <Field
            label="Model"
            source={data.llmModelSource}
            hint="Model name as expected by the endpoint above."
          >
            <input
              type="text"
              className={inputClass}
              value={llmModel}
              onChange={(e) => setLlmModel(e.target.value)}
              placeholder="gpt-4o-mini"
            />
          </Field>

          <TestConnectionRow testing={testingLlm} result={llmTestResult} onTest={handleTestLlm} />

          <div className="grid grid-cols-2 gap-3 border-t border-outline-variant pt-3">
            <Field
              label="Cost / 1M input tokens"
              source={data.costPerMillionInputSource}
              hint="Optional — used only to estimate cost from stored token counts."
            >
              <input
                type="text"
                inputMode="decimal"
                className={inputClass}
                value={costInput}
                onChange={(e) => setCostInput(e.target.value)}
                placeholder="e.g. 0.15"
              />
            </Field>
            <Field
              label="Cost / 1M output tokens"
              source={data.costPerMillionOutputSource}
            >
              <input
                type="text"
                inputMode="decimal"
                className={inputClass}
                value={costOutput}
                onChange={(e) => setCostOutput(e.target.value)}
                placeholder="e.g. 0.60"
              />
            </Field>
          </div>
        </div>

        <div className="flex flex-col gap-4 rounded-lg border border-outline-variant bg-surface p-4">
          <h2 className="font-heading text-sm font-semibold text-on-surface">Agent CLIs</h2>
          <p className="text-[11px] text-on-surface-variant">
            Each agent runs its default command, resolved on PATH. Set a path here only if it
            isn&apos;t on PATH or you want to point it at a different binary.
          </p>

          {AGENT_LIST.map((agent) => (
            <Field
              key={agent.id}
              label={agent.label}
              source={agentCommands[agent.id]?.trim() ? "settings" : "none"}
            >
              <input
                type="text"
                className={inputClass}
                value={agentCommands[agent.id] ?? ""}
                onChange={(e) =>
                  setAgentCommands((prev) => ({ ...prev, [agent.id]: e.target.value }))
                }
                placeholder={agent.command}
                autoComplete="off"
              />
            </Field>
          ))}
        </div>

        <div className="flex flex-col gap-4 rounded-lg border border-outline-variant bg-surface p-4">
          <h2 className="font-heading text-sm font-semibold text-on-surface">Automation</h2>

          <label className="flex items-start gap-2 text-xs text-on-surface">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={autoSyncEnabled}
              onChange={(e) => setAutoSyncEnabled(e.target.checked)}
            />
            <span>
              Auto-sync stale projects in the background
              <span className="mt-0.5 block text-[11px] text-on-surface-variant">
                While the app is running, re-sync every pinned project pushed to since its last sync
                — no external scheduler needed.
              </span>
            </span>
          </label>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-on-surface">Interval (minutes)</label>
            <input
              type="number"
              min={5}
              step={1}
              className={cn(inputClass, "max-w-40", !autoSyncEnabled && "opacity-50")}
              value={autoSyncInterval}
              onChange={(e) => setAutoSyncInterval(e.target.value)}
              placeholder="30"
              disabled={!autoSyncEnabled}
              autoComplete="off"
            />
            <p className="text-[11px] text-on-surface-variant">
              How often to sweep. Blank uses the default (30 min); anything under 5 minutes is
              floored to 5.
            </p>
          </div>

          <Field
            label="Cron secret"
            source={data.cronSecretSource}
            hint="Alternative to the in-app scheduler above: required by POST /api/cron/sync as a Bearer token, for triggering auto-sync from Windows Task Scheduler or another external scheduler."
          >
            <input
              type="password"
              className={inputClass}
              value={cronSecret}
              onChange={(e) => setCronSecret(e.target.value)}
              placeholder={
                data.cronSecretMasked ? `${data.cronSecretMasked} (unchanged)` : "any random string"
              }
              autoComplete="off"
            />
          </Field>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={saving}
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-on-primary transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save settings"}
          </button>
          {saved && <span className="text-xs text-accent-green">Saved.</span>}
          {saveError && <span className="text-xs text-accent-orange">{saveError}</span>}
        </div>
      </form>

      <div className="flex flex-col gap-4 rounded-lg border border-accent-orange/40 bg-surface p-4">
        <div>
          <h2 className="font-heading text-sm font-semibold text-accent-orange">Danger Zone</h2>
          <p className="text-[11px] text-on-surface-variant">
            Permanently deletes data from{" "}
            <code className="font-mono">.gitpulse/data.db</code>. This cannot be undone.
          </p>
        </div>

        <label className="flex items-start gap-2 text-xs text-on-surface">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={clearSettingsChecked}
            onChange={(e) => setClearSettingsChecked(e.target.checked)}
          />
          <span>
            Clear settings data
            <span className="block text-[11px] text-on-surface-variant">
              GitHub token, LLM config, cron secret, and cost estimates saved above.
            </span>
          </span>
        </label>

        <label className="flex items-start gap-2 text-xs text-on-surface">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={clearSyncDataChecked}
            onChange={(e) => setClearSyncDataChecked(e.target.checked)}
          />
          <span>
            Clear sync data
            <span className="block text-[11px] text-on-surface-variant">
              All pinned projects, cached AI summaries, and action items.
            </span>
          </span>
        </label>

        {confirmingClear ? (
          <div className="flex flex-col gap-2 rounded-md border border-accent-orange bg-accent-orange/10 p-3">
            <p className="text-xs text-on-surface">
              This will permanently delete {clearDataSummary()}. This cannot be undone.
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={confirmClearData}
                disabled={clearing}
                className="flex items-center gap-1.5 rounded-md bg-accent-orange px-3 py-1.5 text-xs font-medium text-on-primary transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {clearing && <Loader2 className="size-3 animate-spin" />}
                Yes, delete
              </button>
              <button
                type="button"
                onClick={cancelClearData}
                disabled={clearing}
                className="rounded-md border border-outline-variant px-3 py-1.5 text-xs text-on-surface transition-colors hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={requestClearData}
              disabled={clearing || (!clearSettingsChecked && !clearSyncDataChecked)}
              className="flex items-center gap-1.5 rounded-md border border-accent-orange px-3 py-1.5 text-xs font-medium text-accent-orange transition-colors hover:bg-accent-orange/10 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Clear data
            </button>
            {clearResult && (
              <span
                className={cn(
                  "text-xs",
                  clearResult.ok ? "text-accent-green" : "text-accent-orange",
                )}
              >
                {clearResult.message}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
