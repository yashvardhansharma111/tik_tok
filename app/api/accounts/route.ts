/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextRequest, NextResponse } from "next/server";
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
    hasSession: a.hasSession ?? Boolean(a.session),
  };
}

const ACCOUNTS_DEFAULT_LIMIT = 50;
const ACCOUNTS_MAX_LIMIT = 2000;

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  await connectDB();
  const ownerId = (user as { _id: mongoose.Types.ObjectId })._id;
  const isAdmin = (user as { role?: string }).role === "admin";

  const sp = req.nextUrl.searchParams;
  const page = Math.max(1, parseInt(sp.get("page") ?? "1", 10) || 1);
  const limitParam = sp.get("limit");
  const limit =
    limitParam === null || limitParam === ""
      ? ACCOUNTS_DEFAULT_LIMIT
      : Math.min(ACCOUNTS_MAX_LIMIT, Math.max(1, parseInt(limitParam, 10) || ACCOUNTS_DEFAULT_LIMIT));
  const skip = (page - 1) * limit;

  const filter = isAdmin ? {} : accountAccessibleByUser(ownerId);
  const userFilter = accountAccessibleByUser(ownerId);
  const [accounts, totalInDatabase, linkedCount] = await Promise.all([
    AccountModel.aggregate([
      { $match: filter },
      { $sort: { createdAt: -1 as const } },
      { $skip: skip },
      { $limit: limit },
      {
        $project: {
          username: 1,
          proxy: 1,
          status: 1,
          lastUsedAt: 1,
          hasSession: {
            $and: [
              { $ifNull: ["$session", false] },
              { $ne: ["$session", ""] },
            ],
          },
        },
      },
    ]),
    AccountModel.countDocuments({}),
    AccountModel.countDocuments(userFilter),
  ]);
  const listTotal = isAdmin ? totalInDatabase : linkedCount;

  const totalPages = Math.max(1, Math.ceil(listTotal / limit));

  const listScope = isAdmin ? "all_in_database" : "owner_only";

  const userDoc = await UserModel.findById(ownerId).select({ maxLinkedAccounts: 1 }).lean();
  const maxLinkedAccounts =
    (userDoc as { maxLinkedAccounts?: number | null } | null)?.maxLinkedAccounts ?? null;

  console.info("[api/accounts GET]", {
    listCount: accounts.length,
    listTotal,
    page,
    limit,
    totalPages,
    totalInDatabase,
    linkedCount,
    listScope,
    maxLinkedAccounts,
    isAdmin,
    ownerId: String(ownerId),
    filter: isAdmin ? "all rows" : "ownerId match",
    whyUiShowsThisMany:
      listScope === "owner_only"
        ? `UI lists Account rows for this user (page slice ${accounts.length} of ${listTotal}). DB total ${totalInDatabase} (all tenants). ` +
          (maxLinkedAccounts != null
            ? `Admin cap: max ${maxLinkedAccounts} linked for this user (${linkedCount} used).`
            : "No admin cap (unlimited links).") +
          ` Shared TikTok logins use ownerIds; remaining DB rows belong to other users.`
        : `Admin UI lists accounts paginated (${accounts.length} on page of ${listTotal} total). linkedCount is only for the admin user's ownerId (${linkedCount}).`,
  });
  const canAddMore = maxLinkedAccounts == null || linkedCount < maxLinkedAccounts;

  return NextResponse.json({
    accounts: accounts.map(mapAccount),
    page,
    limit,
    listTotal,
    totalPages,
    linkedCount,
    maxLinkedAccounts,
    canAddMore,
    totalInDatabase,
    listScope,
  });
}
