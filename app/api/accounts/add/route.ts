/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { AccountModel } from "@/lib/models/Account";
import { UserModel } from "@/lib/models/User";
import mongoose from "mongoose";
import { getCurrentUser } from "@/lib/currentUser";
import { countAccountsForUser, userHasAccountAccess } from "@/lib/accountAccess";
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

  try {
    const parsed = JSON.parse(session) as { cookies?: unknown };
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.cookies)) {
      return NextResponse.json(
        { error: "session must be valid Playwright storageState JSON (object with a cookies array)" },
        { status: 400 }
      );
    }
  } catch {
    return NextResponse.json({ error: "session must be valid JSON (Playwright storageState export)" }, { status: 400 });
  }

  await connectDB();
  const ownerId = (user as { _id: unknown })._id as mongoose.Types.ObjectId;
  const isAdmin = (user as { role?: string }).role === "admin";

  const existing = await AccountModel.findOne({ username }).lean();
  if (existing && !isAdmin && !userHasAccountAccess(existing as { ownerId?: unknown; ownerIds?: unknown }, ownerId)) {
    return NextResponse.json(
      { error: "This TikTok username is already linked to other users. Ask an admin to add you as a co-owner." },
      { status: 403 }
    );
  }

  const alreadyHasAccess = existing && userHasAccountAccess(existing as { ownerId?: unknown; ownerIds?: unknown }, ownerId);
  if (!existing || !alreadyHasAccess) {
    const u = await UserModel.findById(ownerId).select({ maxLinkedAccounts: 1 }).lean();
    const max = (u as { maxLinkedAccounts?: number | null } | null)?.maxLinkedAccounts ?? null;
    const count = await countAccountsForUser(AccountModel, ownerId);
    if (max != null && count >= max) {
      return NextResponse.json(
        {
          error: `Account limit reached (${max}). Remove an account or ask an admin to raise your limit.`,
        },
        { status: 403 }
      );
    }
  }

  const account = await AccountModel.findOneAndUpdate(
    { username },
    {
      $set: { username, session, proxy: proxy || undefined, status: "active" },
      $addToSet: { ownerIds: ownerId },
      $setOnInsert: { ownerId },
    },
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
