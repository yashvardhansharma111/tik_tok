/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectDB } from "@/lib/db";
import { AccountModel } from "@/lib/models/Account";
import { UserModel } from "@/lib/models/User";
import { getCurrentUser } from "@/lib/currentUser";
import { accountAccessibleByUser } from "@/lib/accountAccess";

function mapAccount(a: any) {
  return {
    id: String(a._id),
    username: a.username,
    proxy: a.proxy || "",
    status: a.status,
    lastUsedAt: a.lastUsedAt,
    hasSession: Boolean(a.session),
  };
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  await connectDB();
  const ownerId = (user as { _id: mongoose.Types.ObjectId })._id;
  const isAdmin = (user as { role?: string }).role === "admin";

  const filter = isAdmin ? {} : accountAccessibleByUser(ownerId);
  const [accounts, totalInDatabase, linkedCount] = await Promise.all([
    AccountModel.find(filter).sort({ createdAt: -1 }).lean(),
    AccountModel.countDocuments({}),
    AccountModel.countDocuments(accountAccessibleByUser(ownerId)),
  ]);

  const listScope = isAdmin ? "all_in_database" : "owner_only";

  const userDoc = await UserModel.findById(ownerId).select({ maxLinkedAccounts: 1 }).lean();
  const maxLinkedAccounts =
    (userDoc as { maxLinkedAccounts?: number | null } | null)?.maxLinkedAccounts ?? null;

  console.info("[api/accounts GET]", {
    listCount: accounts.length,
    totalInDatabase,
    linkedCount,
    listScope,
    maxLinkedAccounts,
    isAdmin,
    ownerId: String(ownerId),
    filter: isAdmin ? "all rows" : "ownerId match",
    whyUiShowsThisMany:
      listScope === "owner_only"
        ? `UI lists Account rows for this user (${accounts.length}). DB total ${totalInDatabase} (all tenants). ` +
          (maxLinkedAccounts != null
            ? `Admin cap: max ${maxLinkedAccounts} linked for this user (${linkedCount} used).`
            : "No admin cap (unlimited links).") +
          ` Shared TikTok logins use ownerIds; remaining DB rows belong to other users.`
        : `Admin UI lists all accounts (${accounts.length}). linkedCount is only for the admin user's ownerId (${linkedCount}).`,
  });
  const canAddMore = maxLinkedAccounts == null || linkedCount < maxLinkedAccounts;

  return NextResponse.json({
    accounts: accounts.map(mapAccount),
    linkedCount,
    maxLinkedAccounts,
    canAddMore,
    totalInDatabase,
    listScope,
  });
}
