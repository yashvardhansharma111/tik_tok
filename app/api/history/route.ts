/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { UploadModel } from "@/lib/models/Upload";
import { AccountModel } from "@/lib/models/Account";
import { getCurrentUser } from "@/lib/currentUser";
import { friendlyUploadError, shortUploadErrorLabel } from "@/lib/uploadErrorMessages";

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  await connectDB();

  const sp = req.nextUrl.searchParams;
  const fromParam = sp.get("from");
  const limitParam = sp.get("limit");

  const queryFilter: Record<string, any> = {};
  if (fromParam) {
    const fromDate = new Date(fromParam);
    if (!isNaN(fromDate.getTime())) {
      queryFilter.timestamp = { $gte: fromDate };
    }
  }

  const limit = Math.min(2000, Math.max(1, parseInt(limitParam || "200", 10) || 200));

  const [rows, statusCounts] = await Promise.all([
    UploadModel.find(queryFilter).sort({ timestamp: -1 }).limit(limit).lean(),
    UploadModel.aggregate([
      { $match: queryFilter },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
  ]);

  const stats: Record<string, number> = {};
  let totalCount = 0;
  for (const s of statusCounts) {
    stats[s._id] = s.count;
    totalCount += s.count;
  }

  const accountIds = [...new Set(rows.map((r: any) => String(r.accountId)))];
  const accounts =
    accountIds.length > 0
      ? await AccountModel.find({ _id: { $in: accountIds } }, { _id: 1, username: 1 }).lean()
      : [];
  const map = new Map(accounts.map((a: any) => [String(a._id), a.username]));

  return NextResponse.json({
    stats: {
      total: totalCount,
      success: stats.success || 0,
      failed: stats.failed || 0,
      uploading: stats.uploading || 0,
      pending: stats.pending || 0,
    },
    rows: rows.map((r: any) => {
      const err = r.error != null ? String(r.error) : "";
      return {
        id: String(r._id),
        accountId: String(r.accountId),
        accountUsername: map.get(String(r.accountId)) || "unknown",
        videoFileName: r.videoFileName,
        caption: r.caption,
        musicQuery: r.musicQuery,
        soundUsed: r.soundUsed,
        status: r.status,
        error: r.error,
        errorFriendly: err ? friendlyUploadError(err) : "",
        errorShortLabel: err ? shortUploadErrorLabel(err) : "",
        timestamp: r.timestamp,
      };
    }),
  });
}
