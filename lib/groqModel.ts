/**
 * Shared Groq model resolution.
 *
 * GROQ_MODEL must be an API model *id* (e.g. "openai/gpt-oss-120b"), not the
 * display name shown in the Groq console ("GPT-OSS 120B") — the API rejects
 * display names with `model_not_found`.
 *
 * The gpt-oss family are reasoning models: they emit chain-of-thought into
 * `message.reasoning`, which is billed against `max_tokens`. With a small
 * budget the reasoning consumes it all and `message.content` comes back empty,
 * so we force `reasoning_effort: "low"` and floor the token budget.
 */

export const DEFAULT_GROQ_MODEL = "openai/gpt-oss-120b";

/** Fallback used when the configured model is missing/decommissioned. */
export const FALLBACK_GROQ_MODEL = "openai/gpt-oss-20b";

export function resolveGroqModel(): string {
  const raw = (process.env.GROQ_MODEL || "").trim();
  if (!raw) return DEFAULT_GROQ_MODEL;
  // Tolerate the console display name ("GPT-OSS 120B") instead of hard-failing.
  const normalized = raw.toLowerCase().replace(/\s+/g, "-");
  if (normalized === "gpt-oss-120b" || normalized === "gpt-oss-20b") {
    return `openai/${normalized}`;
  }
  return raw;
}

export function isReasoningModel(model: string): boolean {
  return /gpt-oss/i.test(model);
}

/** Extra body params + a safe token budget for the given model. */
export function groqRequestExtras(
  model: string,
  maxTokens: number
): { reasoning_effort?: "low"; max_tokens: number } {
  if (!isReasoningModel(model)) return { max_tokens: maxTokens };
  // Reserve headroom so reasoning tokens can't starve the answer.
  return { reasoning_effort: "low", max_tokens: Math.max(maxTokens, 512) };
}
