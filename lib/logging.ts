/**
 * Minimal logger that redacts secrets before anything reaches stdout/stderr.
 * This app runs local + single-user, but logs still get pasted into GitHub
 * issues / shared for debugging — never let a token slip out that way.
 */

const REDACT_KEYS = new Set([
  "authorization",
  "token",
  "apikey",
  "api_key",
  "githubtoken",
  "github_token",
  "llmapikey",
  "llm_api_key",
]);

function redactValue(value: unknown): unknown {
  if (typeof value === "string") {
    // Redact common token shapes even when not under a suspicious key.
    if (/^(ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|sk-|Bearer\s)/.test(value)) {
      return "[REDACTED]";
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    return redactObject(value as Record<string, unknown>);
  }
  return value;
}

function redactObject(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj)) {
    if (REDACT_KEYS.has(key.toLowerCase())) {
      out[key] = "[REDACTED]";
    } else {
      out[key] = redactValue(val);
    }
  }
  return out;
}

function safeArgs(args: unknown[]): unknown[] {
  return args.map(redactValue);
}

export const logger = {
  info: (...args: unknown[]) => console.info(...safeArgs(args)),
  warn: (...args: unknown[]) => console.warn(...safeArgs(args)),
  error: (...args: unknown[]) => console.error(...safeArgs(args)),
  debug: (...args: unknown[]) => console.debug(...safeArgs(args)),
};
