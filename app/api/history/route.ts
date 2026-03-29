/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { UploadModel } from "@/lib/models/Upload";
import { AccountModel } from "@/lib/models/Account";
import { getCurrentUser } from "@/lib/currentUser";
import { accountFilterForUser, uploadFilterForUser } from "@/lib/accountAccess";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  await connectDB();
  const myAccounts = await AccountModel.find(accountFilterForUser(user), { _id: 1 }).lean();
  const myAccountIds = myAccounts.map((a: { _id: unknown }) => a._id);
  const filter = uploadFilterForUser(user, myAccountIds as any);
  const rows = await UploadModel.find(filter).sort({ timestamp: -1 }).limit(100).lean();
  const accountIds = [...new Set(rows.map((r: any) => String(r.accountId)))];
  const accounts =
    accountIds.length > 0
      ? await AccountModel.find({ _id: { $in: accountIds } }, { _id: 1, username: 1 }).lean()
      : [];
  const map = new Map(accounts.map((a: any) => [String(a._id), a.username]));

  return NextResponse.json(rows.map((r: any) => ({
    id: String(r._id),
    accountId: String(r.accountId),
    accountUsername: map.get(String(r.accountId)) || "unknown",
    videoFileName: r.videoFileName,
    caption: r.caption,
    musicQuery: r.musicQuery,
    soundUsed: r.soundUsed,
    status: r.status,
    error: r.error,
    timestamp: r.timestamp,
  })));
}
