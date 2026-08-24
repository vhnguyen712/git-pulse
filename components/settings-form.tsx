"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import type { SettingsResponse } from "@/app/api/settings/route";
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

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const [testingGithub, setTestingGithub] = useState(false);
  const [githubTestResult, setGithubTestResult] = useState<TestResult | null>(null);

  const [testingLlm, setTestingLlm] = useState(false);
  const [llmTestResult, setLlmTestResult] = useState<TestResult | null>(null);

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
      setLoading(false);
    }
    loadSettings();
    return () => {
      cancelled = true;
    };
  }, []);

  async function save(payload: Record<string, string>) {
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
    const payload: Record<string, string> = {
      llmBaseUrl: llmBaseUrl.trim(),
      llmModel: llmModel.trim(),
      costPerMillionInput: costInput.trim(),
      costPerMillionOutput: costOutput.trim(),
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

  if (loading || !data) {
    return <p className="text-xs text-on-surface-variant">Loading settings…</p>;
  }

  return (
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
        <h2 className="font-heading text-sm font-semibold text-on-surface">Automation</h2>

        <Field
          label="Cron secret"
          source={data.cronSecretSource}
          hint="Required by POST /api/cron/sync as a Bearer token — used to trigger auto-sync from Windows Task Scheduler or another local scheduler."
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
  );
}
