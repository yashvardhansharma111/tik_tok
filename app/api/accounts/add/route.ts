/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { AccountModel } from "@/lib/models/Account";
import { getCurrentUser } from "@/lib/currentUser";
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const session = typeof body.session === "string" ? body.session : "";
  const proxy = typeof body.proxy === "string" ? body.proxy.trim() : "";

  if (!username || !session) {
    return NextResponse.json({ error: "username and session are required" }, { status: 400 });
  }

  await connectDB();
  const ownerId = (user as { _id: unknown })._id;
  const account = await AccountModel.findOneAndUpdate(
    { username },
    { username, session, proxy: proxy || undefined, status: "active", ownerId },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();

  return NextResponse.json({
    id: String((account as any)._id),
    username: (account as any).username,
    proxy: (account as any).proxy || "",
    status: (account as any).status,
    hasSession: true,
  });
}
