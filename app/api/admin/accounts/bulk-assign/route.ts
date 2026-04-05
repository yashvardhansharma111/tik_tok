/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectDB } from "@/lib/db";
import { AccountModel } from "@/lib/models/Account";
import { UserModel } from "@/lib/models/User";
import { requireAdmin } from "@/lib/currentUser";

/**
 * POST body: `{ userId: string, mode: "exclusive" | "addToAll" }`
 * - exclusive: every TikTok account is owned ONLY by this user (testing: one user gets full list).
 * - addToAll: add this user to ownerIds on every account (shared / dev — multiple users per login).
 */
export async function POST(request: Request) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const userIdRaw = typeof body.userId === "string" ? body.userId.trim() : "";
  const mode = body.mode === "addToAll" ? "addToAll" : body.mode === "exclusive" ? "exclusive" : null;

  if (!userIdRaw || !mongoose.Types.ObjectId.isValid(userIdRaw)) {
    return NextResponse.json({ error: "Valid userId is required" }, { status: 400 });
  }
  if (!mode) {
    return NextResponse.json({ error: 'mode must be "exclusive" or "addToAll"' }, { status: 400 });
  }

  const userId = new mongoose.Types.ObjectId(userIdRaw);

  await connectDB();
  const targetUser = await UserModel.findById(userId).select({ maxLinkedAccounts: 1, email: 1 }).lean();
  if (!targetUser) {
    return NextResponse.json({ error: "User not found" }, { status: 400 });
  }

  const total = await AccountModel.countDocuments({});
  const max = (targetUser as { maxLinkedAccounts?: number | null }).maxLinkedAccounts ?? null;
  if (total > 0 && max != null && max < total) {
    return NextResponse.json(
      {
        error: `This user’s max linked accounts (${max}) is lower than the number of TikTok accounts (${total}). Raise “max accounts” for this user in the table above, then retry.`,
      },
      { status: 403 }
    );
  }

  if (mode === "exclusive") {
    const r = await AccountModel.updateMany({}, { $set: { ownerId: userId, ownerIds: [userId] } });
    return NextResponse.json({
      ok: true,
      mode: "exclusive",
      matched: r.matchedCount,
      modified: r.modifiedCount,
      userEmail: (targetUser as any).email,
    });
  }

  await AccountModel.updateMany({}, { $addToSet: { ownerIds: userId } });
  await AccountModel.updateMany({ $or: [{ ownerId: null }, { ownerId: { $exists: false } }] }, { $set: { ownerId: userId } });

  return NextResponse.json({
    ok: true,
    mode: "addToAll",
    totalAccounts: total,
    userEmail: (targetUser as any).email,
  });
}
