/* eslint-disable @typescript-eslint/no-explicit-any */
import path from "path";
import mongoose from "mongoose";
import { UploadModel } from "@/lib/models/Upload";
import { CampaignModel } from "@/lib/models/Campaign";
import { tryCleanupUploadBatch } from "@/lib/tmpUploadCleanup";
import { generateTikTokCaption } from "@/lib/aiCaption";

/** Single sound search for the whole campaign; falls back to first legacy `musicQueries` entry. */
export function campaignSoundSearch(c: {
  musicQuery?: unknown;
  musicQueries?: unknown;
}): string | undefined {
  const single = typeof c.musicQuery === "string" ? c.musicQuery.trim() : "";
  if (single) return single;
  const arr = c.musicQueries;
  if (Array.isArray(arr)) {
    for (const x of arr) {
      const t = String(x ?? "").trim();
      if (t) return t;
    }
  }
  return undefined;
}

function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic per-account shuffle of video indices. */
export function shuffleVideoIndices(videoCount: number, seed: string): number[] {
  const arr = Array.from({ length: videoCount }, (_, i) => i);
  let s = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    s ^= seed.charCodeAt(i);
    s = Math.imul(s, 16777619);
  }
  const rnd = mulberry32(s >>> 0);
  for (let i = videoCount - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = t;
  }
  return arr;
}

function captionForVideo(
  c: {
    captionMode: string;
    captions: string[];
  },
  vidIdx: number
): string {
  if (c.captionMode === "same" || c.captions.length === 1) {
    return c.captions[0] || "";
  }
  return c.captions[vidIdx] ?? c.captions[0] ?? "";
}

async function maybeAiCaption(c: any, vidIdx: number, accountId: string): Promise<string> {
  const base = captionForVideo(c, vidIdx);
  if (c.captionMode !== "ai_unique_each") return base;
  const topic =
    base.trim() ||
    campaignSoundSearch(c) ||
    `Video slot ${vidIdx + 1} for account ${accountId.slice(-6)}`;
  try {
    return await generateTikTokCaption(topic, {
      variationIndex: Number(c.cycle || 0) * 100 + vidIdx,
      variationTotal: 500,
      temperature: 0.88,
    });
  } catch {
    return base;
  }
}

/** Insert the first job for each account in the current wave. */
export async function enqueueCampaignWave(campaignLean: any): Promise<void> {
  const c = campaignLean;
  const uploadId = c.uploadId as string;
  const start = Number(c.waveStartAccountIndex || 0);
  const P = Math.max(1, Math.min(32, Number(c.parallelism || 1)));
  const accountIds = (c.accountIds || []).map((id: any) => new mongoose.Types.ObjectId(id));
  const end = Math.min(start + P, accountIds.length);
  if (start >= accountIds.length) return;

  const cycle = Number(c.cycle || 0);
  const baseMs =
    cycle === 0 && c.scheduledStartAt
      ? new Date(c.scheduledStartAt as Date).getTime()
      : Date.now();
  const staggerMs = Math.round(Number(c.staggerSeconds || 0) * 1000);
  /** Per-account stagger shifts `notBefore` — claim logic only picks rows with `notBefore <= now`, so stagger > 0 serializes a wave and breaks parallelism. For P>1, start every account in the wave at the same time. */
  const parallelWave = P > 1;

  console.log("[Campaign] enqueue wave", {
    uploadId,
    cycle,
    waveAccountIndexRange: `${start}–${end - 1}`,
    accountsInWave: end - start,
    parallelismSetting: P,
    videosPerAccount: Array.isArray(c.videoRelPaths) ? c.videoRelPaths.length : 0,
    staggerSeconds: Number(c.staggerSeconds || 0),
    intraWaveStagger:
      parallelWave && staggerMs > 0
        ? "ignored so all accounts in this wave are claimable at once (set stagger to 0 to avoid confusion)"
        : "applied per account index in wave",
  });

  for (let i = start; i < end; i++) {
    const accId = accountIds[i];
    const order: number[] = c.perAccountVideoOrder[i] || [0];
    const vidIdx = order[0] ?? 0;
    const rel = c.videoRelPaths[vidIdx] || "videos/0.mp4";
    let caption =
      c.captionMode === "ai_unique_each"
        ? await maybeAiCaption(c, vidIdx, String(accId))
        : captionForVideo(c, vidIdx);
    const musicQuery = campaignSoundSearch(c);

    const notBeforeMs = parallelWave ? baseMs : baseMs + (i - start) * staggerMs;

    await UploadModel.create({
      ownerId: c.ownerId,
      uploadId,
      campaignId: uploadId,
      campaignStep: 0,
      videoRelPath: rel,
      accountId: accId,
      videoFileName: path.basename(rel),
      caption,
      ...(musicQuery ? { musicQuery } : {}),
      status: "pending",
      notBefore: new Date(notBeforeMs),
      parallelism: P,
      timestamp: new Date(),
    });
    console.log("[Campaign] queued job", {
      uploadId,
      accountIndex: i,
      campaignStep: 0,
      videoRelPath: rel,
      notBeforeMs,
    });
  }
}

/**
 * After a successful upload row, append the next video for this account or advance the campaign wave.
 * Call before `claimNextPendingUploadForAccount` in the runner.
 */
export async function afterCampaignUploadSuccess(completedUpload: any): Promise<void> {
  const campaignId = completedUpload.campaignId;
  if (!campaignId || String(completedUpload.status) !== "success") return;

  const c = await CampaignModel.findOne({ uploadId: campaignId }).lean();
  if (!c || c.status !== "active") return;

  const uploadId = c.uploadId as string;
  const accountId = String(completedUpload.accountId);
  const accIdx = (c.accountIds as any[]).findIndex((id) => String(id) === accountId);
  if (accIdx < 0) return;

  const order: number[] = (c.perAccountVideoOrder as number[][])[accIdx] || [0];
  const step = Number(completedUpload.campaignStep ?? 0);

  if (step < order.length - 1) {
    const nextStep = step + 1;
    const vidIdx = order[nextStep] ?? 0;
    const rel = c.videoRelPaths[vidIdx] || `videos/${vidIdx}.mp4`;
    const caption =
      c.captionMode === "ai_unique_each"
        ? await maybeAiCaption(c, vidIdx, accountId)
        : captionForVideo(c, vidIdx);
    const musicQuery = campaignSoundSearch(c);

    await UploadModel.create({
      ownerId: c.ownerId,
      uploadId,
      campaignId: uploadId,
      campaignStep: nextStep,
      videoRelPath: rel,
      accountId: new mongoose.Types.ObjectId(accountId),
      videoFileName: path.basename(rel),
      caption,
      ...(musicQuery ? { musicQuery } : {}),
      status: "pending",
      notBefore: new Date(),
      parallelism: c.parallelism,
      timestamp: new Date(),
    });
    console.log("[Campaign] next video queued", {
      uploadId,
      accountId,
      campaignStep: nextStep,
      videoRelPath: rel,
      totalStepsThisAccount: order.length,
    });
    return;
  }

  /**
   * Count this account as finished for the current wave. Must be atomic: two parallel browsers
   * can complete the last video at the same time; a separate findById after $inc can show
   * `accountsFinishedInWave === waveSize` to *both* callers even though only one increment
   * reached the threshold — that duplicated `enqueueCampaignWave` and re-opened browsers.
   * Only the process whose increment made `accountsFinishedInWave === waveSize` may advance.
   */
  const bumped = await CampaignModel.findOneAndUpdate(
    { _id: (c as any)._id, status: "active" },
    { $inc: { accountsFinishedInWave: 1 } },
    { new: true }
  ).lean();
  if (!bumped) return;

  const start = Number(bumped.waveStartAccountIndex || 0);
  const P = Math.max(1, Math.min(32, Number(bumped.parallelism || 1)));
  const total = (bumped.accountIds as any[]).length;
  const waveSize = Math.min(P, Math.max(0, total - start));
  const done = Number(bumped.accountsFinishedInWave || 0);

  if (done !== waveSize) return;

  const fresh = bumped;

  console.log("[Campaign] wave finished", {
    uploadId,
    accountsFinishedInWave: done,
    waveSize,
    waveStartAccountIndex: start,
    parallelism: P,
    totalAccounts: total,
  });

  const nextStart = start + P;
  if (nextStart >= total) {
    const gapMs = Math.max(0, Number(fresh.cycleGapSeconds || 0) * 1000);
    const maxC = Math.max(1, Math.min(10_000, Number(fresh.maxCycles ?? 1)));
    const completedPasses = Number(fresh.cycle || 0) + 1;
    const shouldRepeat = Boolean(fresh.repeatForever) || completedPasses < maxC;

    if (shouldRepeat) {
      if (gapMs > 0) await new Promise((r) => setTimeout(r, gapMs));
      await CampaignModel.updateOne(
        { _id: (fresh as any)._id },
        {
          $set: {
            waveStartAccountIndex: 0,
            accountsFinishedInWave: 0,
            cycle: Number(fresh.cycle || 0) + 1,
          },
        }
      );
      const c2 = await CampaignModel.findById((fresh as any)._id).lean();
      if (c2) {
        console.log("[Campaign] cycle repeat — enqueue wave 0", {
          uploadId,
          nextCycle: Number(fresh.cycle || 0) + 1,
          gapMs,
          repeatForever: fresh.repeatForever,
          maxCycles: maxC,
          completedPasses,
        });
        await enqueueCampaignWave(c2);
      }
    } else {
      await CampaignModel.updateOne({ _id: (fresh as any)._id }, { $set: { status: "completed" } });
      console.log("[Campaign] completed (no more repeats)", { uploadId, completedPasses, maxCycles: maxC });
      await tryCleanupUploadBatch(uploadId);
    }
    return;
  }

  console.log("[Campaign] advancing to next account wave", { uploadId, nextWaveStart: nextStart, parallelism: P });

  await CampaignModel.updateOne(
    { _id: (fresh as any)._id },
    {
      $set: {
        waveStartAccountIndex: nextStart,
        accountsFinishedInWave: 0,
      },
    }
  );
  const c3 = await CampaignModel.findById((fresh as any)._id).lean();
  if (c3) await enqueueCampaignWave(c3);
}

