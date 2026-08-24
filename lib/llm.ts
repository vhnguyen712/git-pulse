import OpenAI from "openai";
import { analysisSchema, type Analysis } from "./schema";
import type { BuiltContext } from "./context";
import { logger } from "./logging";
import { resolveSettings } from "./settings";

/**
 * OpenAI-compatible client, pointed at a configurable base URL so it works
 * against OpenAI itself, OpenRouter, Groq, Together, or a local Ollama
 * OpenAI-compat endpoint. Base URL/key/model are resolved from the Settings
 * page (DB) or LLM_BASE_URL/LLM_API_KEY/LLM_MODEL (.env.local) as a fallback.
 */

export class LlmConfigError extends Error {}
export class LlmOutputError extends Error {}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface AnalyzeResult {
  analysis: Analysis;
  /** null when the backend didn't report usage (some OpenAI-compatible proxies omit it). */
  usage: TokenUsage | null;
}

function sumUsage(usages: (TokenUsage | null)[]): TokenUsage | null {
  const present = usages.filter((u): u is TokenUsage => u !== null);
  if (present.length === 0) return null;
  return present.reduce(
    (acc, u) => ({
      promptTokens: acc.promptTokens + u.promptTokens,
      completionTokens: acc.completionTokens + u.completionTokens,
      totalTokens: acc.totalTokens + u.totalTokens,
    }),
    { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  );
}

// Cached by (baseURL, apiKey) so a change made in Settings takes effect on
// the next call, with no explicit cache-bust wiring needed.
let cachedClient: { key: string; client: OpenAI } | null = null;

async function getClientAndModel(): Promise<{ client: OpenAI; model: string }> {
  const { llmApiKey, llmBaseUrl, llmModel } = await resolveSettings();
  if (!llmApiKey) {
    throw new LlmConfigError(
      "No LLM API key configured. Add one in Settings, or set LLM_API_KEY in .env.local.",
    );
  }
  if (!llmModel) {
    throw new LlmConfigError(
      "No LLM model configured. Add one in Settings, or set LLM_MODEL in .env.local.",
    );
  }

  const cacheKey = `${llmBaseUrl ?? ""}::${llmApiKey}`;
  if (cachedClient && cachedClient.key === cacheKey) {
    return { client: cachedClient.client, model: llmModel };
  }
  const client = new OpenAI({ apiKey: llmApiKey, baseURL: llmBaseUrl ?? undefined });
  cachedClient = { key: cacheKey, client };
  return { client, model: llmModel };
}

/**
 * Validates base URL/key/model that haven't been saved yet — used by the
 * Settings page's "Test connection" so a user can check freshly-typed LLM
 * credentials before committing them. Deliberately bypasses the cached
 * client. Uses the lightweight `/models` list endpoint rather than a chat
 * completion, so testing doesn't burn tokens or cost money.
 */
export async function testLlmConnection(opts: {
  baseUrl: string | null;
  apiKey: string;
  model: string;
}): Promise<{ modelFound: boolean; modelCount: number }> {
  const client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseUrl ?? undefined });
  const list = await client.models.list();
  const ids = list.data.map((m) => m.id);
  return { modelFound: ids.includes(opts.model), modelCount: ids.length };
}

const SYSTEM_PROMPT = `You are a Technical Lead analyzing a personal Git repository.
You are given commit messages, a list of changed files (possibly with diffs), the
README, and currently open issues. Analyze the project's state and return ONLY
valid JSON matching this schema — no prose, no markdown fences:

{
  "summary": {
    "key_achievements": string[],
    "fixes_and_refactoring": string[],
    "architectural_changes": string[]
  },
  "next_steps": [
    { "title": string, "description": string, "priority": "high"|"medium"|"low", "type": "feature"|"bug"|"refactor" }
  ],
  "brainstorm_ideas": [
    { "title": string, "category": "architecture"|"enhancement"|"performance", "rationale": string }
  ]
}

If information is insufficient for a field, return an empty array rather than inventing content.`;

const CHUNK_SUMMARY_PROMPT = `You are summarizing one batch of commits from a larger
range. Return a short bullet list (plain text, no JSON) of what changed in this
batch — features, fixes, refactors. Be terse; this will be combined with other
batches later.`;

interface ChatResult {
  content: string;
  usage: TokenUsage | null;
}

function usageFromCompletion(completion: OpenAI.Chat.ChatCompletion): TokenUsage | null {
  const u = completion.usage;
  if (!u) return null;
  return {
    promptTokens: u.prompt_tokens,
    completionTokens: u.completion_tokens,
    totalTokens: u.total_tokens,
  };
}

async function chatJson(userContent: string, retryHint?: string): Promise<ChatResult> {
  const { client, model } = await getClientAndModel();

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userContent },
  ];
  if (retryHint) {
    messages.push({ role: "user", content: retryHint });
  }

  const completion = await client.chat.completions.create({
    model,
    messages,
    response_format: { type: "json_object" },
    temperature: 0.3,
  });

  return {
    content: completion.choices[0]?.message?.content ?? "",
    usage: usageFromCompletion(completion),
  };
}

async function chatText(systemPrompt: string, userContent: string): Promise<ChatResult> {
  const { client, model } = await getClientAndModel();
  const completion = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
    temperature: 0.3,
  });
  return {
    content: completion.choices[0]?.message?.content ?? "",
    usage: usageFromCompletion(completion),
  };
}

// Some backends (proxies in front of chat models, local endpoints) ignore
// response_format: json_object and wrap their output in a markdown code
// fence anyway. Strip it before parsing rather than failing on it.
export function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const match = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  return match ? match[1].trim() : trimmed;
}

export function parseAndValidate(raw: string): Analysis {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(raw));
  } catch {
    throw new LlmOutputError("Model did not return valid JSON.");
  }
  const result = analysisSchema.safeParse(parsed);
  if (!result.success) {
    throw new LlmOutputError(
      `Model JSON did not match the expected schema: ${result.error.message}`,
    );
  }
  return result.data;
}

/**
 * Runs the analysis prompt for a single-call context, validating the result
 * and retrying once with a corrective nudge if the model returns malformed
 * or schema-invalid JSON.
 */
async function analyzeSingle(text: string): Promise<AnalyzeResult> {
  const first = await chatJson(text);
  try {
    return { analysis: parseAndValidate(first.content), usage: first.usage };
  } catch (err) {
    logger.warn("LLM output failed validation, retrying once", err);
    const retry = await chatJson(
      text,
      "Your previous response was not valid JSON matching the schema. Return ONLY the JSON object, with no surrounding text or markdown fences.",
    );
    return {
      analysis: parseAndValidate(retry.content), // let this throw if it fails again
      usage: sumUsage([first.usage, retry.usage]),
    };
  }
}

/**
 * Map-reduce path for large commit ranges: summarize each batch, then feed
 * the combined bullet notes (+ file list/readme/issues) into one final call
 * against the same schema.
 */
async function analyzeMapReduce(
  chunks: string[],
  readmeAndIssues: string,
): Promise<AnalyzeResult> {
  const batchResults = await Promise.all(
    chunks.map((chunk) => chatText(CHUNK_SUMMARY_PROMPT, chunk)),
  );
  const combined = [
    "## Combined batch summaries",
    batchResults.map((r, i) => `### Batch ${i + 1}\n${r.content}`).join("\n\n"),
    readmeAndIssues,
  ]
    .filter(Boolean)
    .join("\n\n");

  const final = await analyzeSingle(combined);
  return {
    analysis: final.analysis,
    usage: sumUsage([...batchResults.map((r) => r.usage), final.usage]),
  };
}

export async function analyze(context: BuiltContext): Promise<AnalyzeResult> {
  if (context.mode === "single") {
    return analyzeSingle(context.text);
  }
  return analyzeMapReduce(context.chunks, context.readmeAndIssues);
}
