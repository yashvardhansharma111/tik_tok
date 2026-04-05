/**
 * Groq-backed TikTok caption generation (shared by /api/ai/caption/generate and batch upload).
 */

export function cleanCaption(text: string) {
  let s = text.trim();
  s = s.replace(/^["']+/, "").replace(/["']+$/, "").trim();
  if (s.length > 220) s = s.slice(0, 220).trim();
  return s;
}

export type GenerateCaptionOptions = {
  /** 0-based index when generating N distinct captions for the same video. */
  variationIndex?: number;
  variationTotal?: number;
  temperature?: number;
};

export async function generateTikTokCaption(
  prompt: string,
  options?: GenerateCaptionOptions
): Promise<string> {
  const GROQ_API_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_API_KEY) {
    throw new Error("Missing GROQ_API_KEY in environment variables");
  }

  const defaultModel = "llama-3.1-8b-instant";
  const model = process.env.GROQ_MODEL || defaultModel;

  const vi = options?.variationIndex;
  const vt = options?.variationTotal;
  const multi =
    typeof vi === "number" &&
    typeof vt === "number" &&
    vt > 1 &&
    vi >= 0 &&
    vi < vt;

  const baseTopic = prompt.trim() || "General TikTok content";

  const userMessage = multi
    ? `The same short video will be posted to ${vt} different TikTok accounts. You are writing caption #${vi + 1} of ${vt}.

CRITICAL: This caption must read COMPLETELY DIFFERENT from the others — new hook line, different sentence structure, and a FRESH set of 3-5 hashtags (at most one hashtag may overlap with what another variation might use).

Base topic / vibe to preserve: ${baseTopic}

Return ONLY the caption text (no quotes), 1-2 short sentences, 3-5 hashtags at the end.`
    : prompt
      ? `Topic/keywords: ${prompt}\n\nWrite a TikTok caption for this topic. Return ONLY the caption text (no quotes), 1-2 short sentences, include 3-5 relevant hashtags at the end.`
      : `Write a general TikTok caption. Return ONLY the caption text (no quotes), 1-2 short sentences, include 3-5 relevant hashtags at the end.`;

  const temperature = options?.temperature ?? (multi ? 0.92 : 0.7);

  const run = async (useModel: string) => {
    const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: useModel,
        messages: [
          {
            role: "system",
            content:
              "You are a TikTok caption generator. Output only the caption text. No markdown. No bullet points. No surrounding quotes.",
          },
          { role: "user", content: userMessage },
        ],
        temperature,
        max_tokens: 180,
      }),
    });
    return resp;
  };

  let resp = await run(model);

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    if (errText.includes("model_decommissioned")) {
      const fallbackModel =
        model === "llama3-8b-8192"
          ? "llama-3.1-8b-instant"
          : model === "llama3-70b-8192"
            ? "llama-3.3-70b-versatile"
            : defaultModel;
      if (fallbackModel !== model) {
        resp = await run(fallbackModel);
      } else {
        throw new Error(errText.slice(0, 300));
      }
    } else {
      throw new Error(errText.slice(0, 300) || "Groq request failed");
    }
  }

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(errText.slice(0, 300) || "Groq request failed");
  }

  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("No caption returned from AI");
  }

  return cleanCaption(content);
}
