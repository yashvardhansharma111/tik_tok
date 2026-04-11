/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectDB } from "@/lib/db";
import { getCurrentUser } from "@/lib/currentUser";
import { CampaignModel } from "@/lib/models/Campaign";
import { UploadModel } from "@/lib/models/Upload";

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  await connectDB();
  const ownerId = (user as { _id: mongoose.Types.ObjectId })._id;
  const isAdmin = (user as { role?: string }).role === "admin";

  const body = await request.json().catch(() => ({}));
  const { uploadId, stopAll } = body as { uploadId?: string; stopAll?: boolean };

  if (!uploadId && !stopAll) {
    return NextResponse.json({ error: "Provide uploadId or stopAll: true" }, { status: 400 });
  }

  const filter: any = { status: { $in: ["active", "paused"] } };
  if (!isAdmin) filter.ownerId = ownerId;
  if (uploadId) filter.uploadId = uploadId;

  const campaigns = await CampaignModel.find(filter).lean();
  if (campaigns.length === 0) {
    return NextResponse.json({ error: "No matching active campaigns found" }, { status: 404 });
  }

  const uploadIds = campaigns.map((c: any) => c.uploadId);

  await CampaignModel.updateMany(
    { uploadId: { $in: uploadIds } },
    { $set: { status: "completed" } }
  );

  await UploadModel.updateMany(
    { campaignId: { $in: uploadIds }, status: { $in: ["pending", "uploading"] } },
    { $set: { status: "failed", error: "campaign_stopped" } }
  );

  console.log("[CampaignAPI] stopped", { uploadIds, stoppedCount: campaigns.length });

  return NextResponse.json({ ok: true, stopped: campaigns.length, uploadIds });
}
