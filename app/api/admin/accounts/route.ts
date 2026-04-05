/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectDB } from "@/lib/db";
import { effectiveOwnerIds } from "@/lib/accountAccess";
import { AccountModel } from "@/lib/models/Account";
import { UserModel } from "@/lib/models/User";
import { requireAdmin } from "@/lib/currentUser";

/** List every TikTok account with owner info — admin assigns accounts to users for multi-server splits. */
export async function GET() {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  await connectDB();
  const accounts = await AccountModel.find({}).sort({ username: 1 }).lean();

  const allOwnerIdStrs = new Set<string>();
  for (const a of accounts) {
    for (const id of effectiveOwnerIds(a as { ownerId?: unknown; ownerIds?: unknown })) {
      allOwnerIdStrs.add(id);
    }
  }

  const users =
    allOwnerIdStrs.size > 0
      ? await UserModel.find(
          { _id: { $in: [...allOwnerIdStrs].map((id) => new mongoose.Types.ObjectId(id)) } },
          { email: 1 }
        ).lean()
      : [];
  const emailById = new Map(users.map((u) => [String((u as any)._id), (u as any).email as string]));

  return NextResponse.json(
    accounts.map((a) => {
      const ids = effectiveOwnerIds(a as { ownerId?: unknown; ownerIds?: unknown });
      return {
        id: String((a as any)._id),
        username: (a as any).username,
        /** @deprecated use ownerIds — first legacy primary */
        ownerId: ids[0] ?? null,
        ownerIds: ids,
        ownerEmails: ids.map((oid) => emailById.get(oid) ?? "(unknown)"),
      };
    })
  );
}
