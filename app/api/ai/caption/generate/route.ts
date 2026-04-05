import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/currentUser";
import { generateTikTokCaption } from "@/lib/aiCaption";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";

  try {
    const caption = await generateTikTokCaption(prompt);
    return NextResponse.json({ caption });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Caption generation failed";
    if (msg.includes("GROQ_API_KEY")) {
      return NextResponse.json({ error: msg }, { status: 500 });
    }
    if (msg.length > 10 && !msg.includes("No caption")) {
      return NextResponse.json({ error: "Groq request failed", details: msg.slice(0, 300) }, { status: 502 });
    }
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
