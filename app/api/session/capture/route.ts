import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { getCurrentUser } from "@/lib/currentUser";
import { AccountModel } from "@/lib/models/Account";
import { captureTikTokStorageState } from "@/automation/captureTikTokSession";

export const maxDuration = 300;

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const accountId = typeof body.accountId === "string" ? body.accountId.trim() : "";
  const proxy = typeof body.proxy === "string" ? body.proxy.trim() : "";
  if (!username && !accountId) {
    return NextResponse.json({ error: "username or accountId is required" }, { status: 400 });
  }

  try {
    await connectDB();
    const sessionJson = await captureTikTokStorageState(proxy || undefined);
    const ownerId = (user as { _id: unknown })._id;
    const filter = accountId ? { _id: accountId, ownerId } : { username, ownerId };
    const update: Record<string, unknown> = {
      ...(username ? { username } : {}),
      session: sessionJson,
      proxy: proxy || undefined,
      status: "active",
      ownerId,
    };

    const account = await AccountModel.findOneAndUpdate(filter, update, {
      upsert: true,
      returnDocument: "after",
      setDefaultsOnInsert: true,
    }).lean();

    return NextResponse.json({
      ok: true,
      id: String((account as { _id: unknown })._id),
      username: (account as { username: string }).username,
      hasSession: true,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Capture failed";
    console.error("[SessionCapture] failed", e);
    const hintBase =
      "A browser window should open. Log in fully, then navigate to For You or your profile. Keep the window open until capture completes.";
    const hintNetwork =
      /ERR_CONNECTION_TIMED_OUT|ERR_NAME_NOT_RESOLVED|ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED/i.test(
        msg
      )
        ? " Network blocked TikTok (common in India). Set PROXY_SERVER + PROXY_USERNAME + PROXY_PASSWORD in .env, or pass proxy in the Capture form."
        : "";

    return NextResponse.json(
      {
        error: msg,
        hint: `${hintBase}${hintNetwork}`,
      },
      { status: 500 }
    );
  }
}
