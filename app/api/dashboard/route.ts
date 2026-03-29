/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { AccountModel } from "@/lib/models/Account";
import { UploadModel } from "@/lib/models/Upload";
import { getCurrentUser } from "@/lib/currentUser";
import { accountFilterForUser, uploadFilterForUser } from "@/lib/accountAccess";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  await connectDB();
  const access = accountFilterForUser(user);
  const myAccounts = await AccountModel.find(access, { _id: 1 }).lean();
  const myAccountIds = myAccounts.map((a: { _id: unknown }) => a._id);
  const uploadScope = uploadFilterForUser(user, myAccountIds as any);
  const totalAccounts = await AccountModel.countDocuments(access);
  const last = await UploadModel.findOne(uploadScope).sort({ timestamp: -1 }).lean();
  const history = await UploadModel.find(uploadScope).sort({ timestamp: -1 }).limit(20).lean();
  const accounts = await AccountModel.find(access, { username: 1 }).lean();
  const map = new Map(accounts.map((a: any) => [String(a._id), a.username]));

  return NextResponse.json({
    totalAccounts,
    lastUpload: last
      ? {
          account: map.get(String((last as any).accountId)) || "unknown",
          video: (last as any).videoFileName,
          status: (last as any).status,
          timestamp: (last as any).timestamp,
        }
      : null,
    uploadHistory: history.map((h: any) => ({
      accountUsername: map.get(String(h.accountId)) || "unknown",
      videoFileName: h.videoFileName,
      status: h.status,
      timestamp: h.timestamp,
    })),
  });
}
