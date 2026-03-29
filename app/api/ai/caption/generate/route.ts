import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/currentUser";

export const runtime = "nodejs";

function cleanCaption(text: string) {
  let s = text.trim();
  // If the model returns quoted strings, remove outer quotes.
  s = s.replace(/^["']+/, "").replace(/["']+$/, "").trim();
  // Keep it reasonably short for TikTok UI.
  if (s.length > 220) s = s.slice(0, 220).trim();
  return s;
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";

  const GROQ_API_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_API_KEY) {
    return NextResponse.json({ error: "Missing GROQ_API_KEY in environment variables" }, { status: 500 });
  }

  const defaultModel = "llama-3.1-8b-instant";
  const model = process.env.GROQ_MODEL || defaultModel;

  const userMessage = prompt
    ? `Topic/keywords: ${prompt}\n\nWrite a TikTok caption for this topic. Return ONLY the caption text (no quotes), 1-2 short sentences, include 3-5 relevant hashtags at the end.`
    : `Write a general TikTok caption. Return ONLY the caption text (no quotes), 1-2 short sentences, include 3-5 relevant hashtags at the end.`;

  try {
    const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content:
              "You are a TikTok caption generator. Output only the caption text. No markdown. No bullet points. No surrounding quotes.",
          },
          { role: "user", content: userMessage },
        ],
        temperature: 0.7,
        max_tokens: 180,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");

      // If the model was decommissioned, try a known compatible replacement once.
      if (errText.includes("model_decommissioned")) {
        const fallbackModel =
          model === "llama3-8b-8192"
            ? "llama-3.1-8b-instant"
            : model === "llama3-70b-8192"
              ? "llama-3.3-70b-versatile"
              : defaultModel;

        if (fallbackModel !== model) {
          const retryResp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${GROQ_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: fallbackModel,
              messages: [
                {
                  role: "system",
                  content:
                    "You are a TikTok caption generator. Output only the caption text. No markdown. No bullet points. No surrounding quotes.",
                },
                { role: "user", content: userMessage },
              ],
              temperature: 0.7,
              max_tokens: 180,
            }),
          });
          if (retryResp.ok) {
            const retryData = await retryResp.json();
            const content2 = retryData?.choices?.[0]?.message?.content;
            if (typeof content2 === "string" && content2.trim()) {
              return NextResponse.json({ caption: cleanCaption(content2) });
            }
          }
        }
      }

      return NextResponse.json(
        { error: "Groq request failed", details: errText?.slice(0, 300) || undefined },
        { status: 502 }
      );
    }

    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      return NextResponse.json({ error: "No caption returned from AI" }, { status: 502 });
    }

    return NextResponse.json({ caption: cleanCaption(content) });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Caption generation failed" },
      { status: 500 }
    );
  }
}

