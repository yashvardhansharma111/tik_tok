/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectDB } from "@/lib/db";
import { getCurrentUser } from "@/lib/currentUser";
import { CampaignModel } from "@/lib/models/Campaign";
import { UploadModel } from "@/lib/models/Upload";
import { AccountModel } from "@/lib/models/Account";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  await connectDB();
  const ownerId = (user as { _id: mongoose.Types.ObjectId })._id;
  const isAdmin = (user as { role?: string }).role === "admin";

  const filter = isAdmin ? { status: { $in: ["active", "paused"] } } : { ownerId, status: { $in: ["active", "paused"] } };
  const campaigns = await CampaignModel.find(filter)
    .select("uploadId status accountIds videoRelPaths parallelism captionMode musicQuery repeatForever maxCycles cycle cycleGapSeconds waveStartAccountIndex accountsFinishedInWave createdAt")
    .sort({ createdAt: -1 })
    .limit(20)
    .lean();

  if (!campaigns.length) return NextResponse.json([]);

  const uploadIds = campaigns.map((c: any) => c.uploadId);

  const statusAgg = await UploadModel.aggregate([
    { $match: { campaignId: { $in: uploadIds } } },
    {
      $group: {
        _id: { campaignId: "$campaignId", status: "$status" },
        count: { $sum: 1 },
      },
    },
  ]);

  const statsMap = new Map<string, Record<string, number>>();
  for (const row of statusAgg) {
    const cid = row._id.campaignId;
    if (!statsMap.has(cid)) statsMap.set(cid, {});
    statsMap.get(cid)![row._id.status] = row.count;
  }

  const allAccountIds = [
    ...new Set(campaigns.flatMap((c: any) => (c.accountIds || []).map(String))),
  ];
  const accounts =
    allAccountIds.length > 0
      ? await AccountModel.find(
          { _id: { $in: allAccountIds.map((id) => new mongoose.Types.ObjectId(id)) } },
          { _id: 1, username: 1 }
        ).lean()
      : [];
  const accountMap = new Map(accounts.map((a: any) => [String(a._id), a.username]));

  const result = campaigns.map((c: any) => {
    const stats = statsMap.get(c.uploadId) || {};
    const success = stats.success || 0;
    const failed = stats.failed || 0;
    const uploading = stats.uploading || 0;
    const pending = stats.pending || 0;
    const totalJobs = success + failed + uploading + pending;

    const videoCount = (c.videoRelPaths || []).length;
    const accountCount = (c.accountIds || []).length;
    const totalExpected = videoCount * accountCount;

    const currentCycle = c.cycle || 0;
    const maxCycles = c.repeatForever ? null : Math.max(1, c.maxCycles ?? 1);

    const waveStart = c.waveStartAccountIndex || 0;
    const waveFinished = c.accountsFinishedInWave || 0;
    const P = Math.max(1, Math.min(32, c.parallelism || 1));
    const waveSize = Math.min(P, Math.max(0, accountCount - waveStart));

    return {
      uploadId: c.uploadId,
      status: c.status,
      createdAt: (c as any).createdAt,
      videoCount,
      accountCount,
      accountUsernames: (c.accountIds || [])
        .slice(0, 10)
        .map((id: any) => accountMap.get(String(id)) || "?"),
      parallelism: c.parallelism,
      captionMode: c.captionMode,
      musicQuery: c.musicQuery || null,
      repeatForever: c.repeatForever,
      maxCycles,
      currentCycle,
      cycleGapSeconds: c.cycleGapSeconds || 0,
      wave: {
        start: waveStart,
        size: waveSize,
        finished: waveFinished,
      },
      jobs: {
        total: totalJobs,
        totalExpectedThisCycle: totalExpected,
        success,
        failed,
        uploading,
        pending,
      },
    };
  });

  return NextResponse.json(result);
}
