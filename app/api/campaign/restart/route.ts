/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from "next/server";
import path from "path";
import fs from "fs/promises";
import mongoose from "mongoose";
import { connectDB } from "@/lib/db";
import { getCurrentUser } from "@/lib/currentUser";
import { CampaignModel } from "@/lib/models/Campaign";
import { UploadModel } from "@/lib/models/Upload";
import { campaignSoundSearch, enqueueCampaignWave } from "@/lib/campaignJobQueue";
import { ensureMongoUploadRunnerStarted } from "@/lib/mongoUploadRunner";
import { resolveMusicMode } from "@/lib/musicMode";

function captionFor(campaign: any, vidIdx: number): string {
  const captions = campaign.captions as string[];
  if (campaign.captionMode === "same" || captions.length === 1) return captions[0] || "";
  return captions[vidIdx] ?? captions[0] ?? "";
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  await connectDB();
  const ownerId = (user as any)._id;
  const isAdmin = (user as any).role === "admin";

  const { uploadId } = (await request.json().catch(() => ({}))) as { uploadId?: string };
  if (!uploadId) return NextResponse.json({ error: "uploadId required" }, { status: 400 });

  const filter: any = { uploadId, status: "completed" };
  if (!isAdmin) filter.ownerId = ownerId;

  const campaign = await CampaignModel.findOne(filter).lean();
  if (!campaign) {
    return NextResponse.json({ error: "Campaign not found or not completed" }, { status: 404 });
  }

  // Verify video files are still on disk
  const batchDir = path.join(process.cwd(), "storage", "tmp-uploads", uploadId);
  const filesExist = await fs.access(batchDir).then(() => true).catch(() => false);
  if (!filesExist) {
    return NextResponse.json(
      { error: "Video files were cleaned up. Please start a new campaign with the same settings." },
      { status: 410 }
    );
  }

  const P = Math.max(1, Number(campaign.parallelism || 1));
  const waveStart = Number(campaign.waveStartAccountIndex || 0);
  const accountIds = (campaign.accountIds || []) as any[];
  const totalAccounts = accountIds.length;
  const waveEnd = Math.min(waveStart + P, totalAccounts);
  const waveSize = waveEnd - waveStart;
  const videoRelPaths = (campaign.videoRelPaths || []) as string[];
  const perAccountVideoOrder = (campaign.perAccountVideoOrder || []) as number[][];
  const musicQuery = campaignSoundSearch(campaign);
  const musicMode = resolveMusicMode((campaign as { musicMode?: unknown }).musicMode, musicQuery);

  // Drop only non-successful jobs — keep success records to know what's already done
  await UploadModel.deleteMany({
    campaignId: uploadId,
    status: { $in: ["failed", "pending", "uploading"] },
  });

  // For each account in the current wave: figure out what step to resume from
  let alreadyDone = 0;

  for (let i = waveStart; i < waveEnd; i++) {
    const accId = new mongoose.Types.ObjectId(String(accountIds[i]));
    const order: number[] = perAccountVideoOrder[i] || Array.from({ length: videoRelPaths.length }, (_, j) => j);
    const totalSteps = order.length;

    // Find the highest successful step for this account in this campaign
    const lastSuccess = await UploadModel.findOne({
      campaignId: uploadId,
      accountId: accId,
      status: "success",
    })
      .sort({ campaignStep: -1, timestamp: -1 })
      .lean();

    const lastDoneStep = lastSuccess ? Number(lastSuccess.campaignStep) : -1;

    if (lastDoneStep >= totalSteps - 1) {
      // Account finished all its videos for this wave already
      alreadyDone++;
      continue;
    }

    // Resume from the next step after the last successful one
    const nextStep = lastDoneStep + 1;
    const vidIdx = order[nextStep] ?? 0;
    const rel = videoRelPaths[vidIdx] || `videos/${vidIdx}.mp4`;
    const caption = captionFor(campaign, vidIdx);

    await UploadModel.create({
      ownerId: campaign.ownerId,
      uploadId,
      campaignId: uploadId,
      campaignStep: nextStep,
      videoRelPath: rel,
      accountId: accId,
      videoFileName: path.basename(rel),
      caption,
      ...(musicQuery ? { musicQuery } : {}),
      musicMode,
      status: "pending",
      notBefore: new Date(),
      parallelism: P,
      timestamp: new Date(),
    });

    console.log("[CampaignAPI] resume: re-enqueued account", {
      uploadId,
      accountIndex: i,
      resumeFromStep: nextStep,
      totalSteps,
      videoRelPath: rel,
    });
  }

  // If the whole current wave was already done, advance to the next wave/cycle
  if (alreadyDone >= waveSize) {
    const nextWaveStart = waveStart + P;

    if (nextWaveStart >= totalAccounts) {
      // End of all accounts in this cycle — start the next cycle
      const cycle = Number(campaign.cycle || 0);
      const maxC = Math.max(1, Number(campaign.maxCycles ?? 1));
      const completedPasses = cycle + 1;
      const shouldRepeat = Boolean(campaign.repeatForever) || completedPasses < maxC;

      if (!shouldRepeat) {
        // Nothing left to do
        return NextResponse.json({
          ok: false,
          error: "Campaign has already completed all its cycles. Start a new one.",
        }, { status: 409 });
      }

      // Advance to next cycle
      await CampaignModel.updateOne(
        { uploadId },
        {
          $set: {
            status: "active",
            cycle: completedPasses,
            waveStartAccountIndex: 0,
            accountsFinishedInWave: 0,
          },
        }
      );
      const fresh = await CampaignModel.findOne({ uploadId }).lean();
      if (fresh) await enqueueCampaignWave(fresh);
    } else {
      // Advance to next wave within the same cycle
      await CampaignModel.updateOne(
        { uploadId },
        {
          $set: {
            status: "active",
            waveStartAccountIndex: nextWaveStart,
            accountsFinishedInWave: 0,
          },
        }
      );
      const fresh = await CampaignModel.findOne({ uploadId }).lean();
      if (fresh) await enqueueCampaignWave(fresh);
    }
  } else {
    // Normal case: partial wave, resume in place
    await CampaignModel.updateOne(
      { uploadId },
      {
        $set: {
          status: "active",
          accountsFinishedInWave: alreadyDone,
        },
      }
    );
  }

  ensureMongoUploadRunnerStarted();

  const resumedCycle = Number(campaign.cycle || 0);
  console.log("[CampaignAPI] resumed", {
    uploadId,
    cycle: resumedCycle,
    waveStart,
    alreadyDoneInWave: alreadyDone,
    waveSize,
    by: String(ownerId),
  });

  return NextResponse.json({
    ok: true,
    uploadId,
    resumedFromCycle: resumedCycle + 1,
    resumedFromWave: waveStart,
    alreadyDoneInWave: alreadyDone,
  });
}
