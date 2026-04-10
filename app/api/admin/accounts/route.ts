/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectDB } from "@/lib/db";
import { effectiveOwnerIds } from "@/lib/accountAccess";
import { AccountModel } from "@/lib/models/Account";
import { UserModel } from "@/lib/models/User";
import { RenameJobModel } from "@/lib/models/RenameJob";
import { requireAdmin } from "@/lib/currentUser";

/** List every TikTok account with owner info + rename history. Renamed accounts sort first. */
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

  // Build rename info per account: map accountId → { originalUsername, appliedUsername, renamedAt }
  const renameJobs = await RenameJobModel.find(
    { "items.status": "done" },
    { items: 1, updatedAt: 1, ownerId: 1 }
  ).lean();

  const renameByAccountId = new Map<
    string,
    { originalUsername: string; appliedUsername: string; renamedAt: string; renamedBy: string }
  >();
  for (const job of renameJobs) {
    const j = job as any;
    const ownerEmail = j.ownerId ? emailById.get(String(j.ownerId)) ?? "(unknown)" : "";
    for (const it of j.items || []) {
      if (it.status === "done" && it.appliedUsername) {
        renameByAccountId.set(String(it.accountId), {
          originalUsername: it.username,
          appliedUsername: it.appliedUsername,
          renamedAt: j.updatedAt?.toISOString() ?? "",
          renamedBy: ownerEmail,
        });
      }
    }
  }

  const rows = accounts.map((a) => {
    const ids = effectiveOwnerIds(a as { ownerId?: unknown; ownerIds?: unknown });
    const accountId = String((a as any)._id);
    const rename = renameByAccountId.get(accountId) ?? null;
    return {
      id: accountId,
      username: (a as any).username,
      /** @deprecated use ownerIds — first legacy primary */
      ownerId: ids[0] ?? null,
      ownerIds: ids,
      ownerEmails: ids.map((oid) => emailById.get(oid) ?? "(unknown)"),
      renamed: rename !== null,
      renameInfo: rename,
    };
  });

  // Renamed accounts first, then alphabetical
  rows.sort((a, b) => {
    if (a.renamed && !b.renamed) return -1;
    if (!a.renamed && b.renamed) return 1;
    return a.username.localeCompare(b.username);
  });

  return NextResponse.json(rows);
}
