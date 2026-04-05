/* eslint-disable @typescript-eslint/no-explicit-any */
import path from "path";
import fs from "fs/promises";
import { launchChromium } from "../lib/playwrightLaunch";
import mongoose from "mongoose";
import { connectDB } from "../lib/db";
import { AccountModel } from "../lib/models/Account";
import { UploadModel } from "../lib/models/Upload";
import { claimUploadBatch } from "../lib/mongoUploadClaim";
import { claimNextPendingUploadForAccount } from "../lib/mongoUploadChainClaim";
import { getUploadParallelAdminCap } from "../lib/uploadParallelConfig";
import {
  runUploadWithSession,
  poolSessionHandleAfterUploadChain,
  discardUploadSessionHandle,
} from "../automation/uploadWorker";
import { resolveOptimizedVideoPath } from "../lib/optimizeVideoForUpload";
import { buildStickyProxyForAccount } from "../lib/proxyPlaywright";
import { ensureStorageJanitorStarted } from "../lib/storageJanitor";
import { isSessionExpiredError, markAccountExpiredIfSessionError } from "../lib/accountSessionExpiry";
import { afterCampaignUploadSuccess, campaignBlocksBatchCleanup } from "../lib/campaignJobQueue";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function chainGapMs(): number {
  const lo = Math.max(0, Number(process.env.UPLOAD_CHAIN_GAP_MIN_MS || 1000));
  const hi = Math.max(lo, Number(process.env.UPLOAD_CHAIN_GAP_MAX_MS || 3000));
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

function samePageChainEnabled(): boolean {
  return process.env.TIKTOK_UPLOAD_SAME_PAGE_CHAIN !== "0" && process.env.TIKTOK_UPLOAD_SAME_PAGE_CHAIN !== "false";
}

const busyAccountIds = new Set<string>();

async function cleanupBatchIfLast(uploadId: string) {
  try {
    if (await campaignBlocksBatchCleanup(uploadId)) return;

    const remaining = await UploadModel.countDocuments({
      uploadId,
      status: { $in: ["pending", "uploading"] },
    });
    if (remaining > 0) return;

    const batchDir = path.join(process.cwd(), "storage", "tmp-uploads", uploadId);
    await fs.rm(batchDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

function resolveUploadVideoPath(uploadId: string, doc: any): string {
  const rel =
    typeof doc?.videoRelPath === "string" && doc.videoRelPath.trim()
      ? doc.videoRelPath.trim().replace(/\\/g, "/")
      : "video.mp4";
  return path.join(process.cwd(), "storage", "tmp-uploads", uploadId, rel);
}

async function processOneUpload(initialUpload: any, browser: import("playwright").Browser) {
  const chainEnabled = samePageChainEnabled();
  let upload: any = initialUpload;
  let sessionHandle: Awaited<ReturnType<typeof runUploadWithSession>>["sessionHandle"];

  while (upload) {
    const uploadId: string = upload.uploadId;
    const accountId: string = String(upload.accountId);
    const caption: string = upload.caption;
    const uploadObjectId = upload._id;
    const videoPath = resolveUploadVideoPath(uploadId, upload);

    try {
      const hasVideo = await fs
        .stat(videoPath)
        .then(() => true)
        .catch(() => false);
      if (!hasVideo) {
        await UploadModel.updateOne(
          { _id: uploadObjectId, status: "uploading" },
          {
            $set: { status: "failed", error: `missing_video_file:${videoPath}`, nextRetryAt: null },
          }
        );
        if (sessionHandle) {
          await discardUploadSessionHandle(sessionHandle);
          sessionHandle = undefined;
        }
        upload = null;
        continue;
      }

      const accountDoc = await AccountModel.findById(accountId).lean();
      if (!accountDoc) {
        await UploadModel.updateOne(
          { _id: uploadObjectId, status: "uploading" },
          {
            $set: {
              status: "failed",
              error: "account_not_found",
              nextRetryAt: null,
            },
          }
        );
        if (sessionHandle) {
          await discardUploadSessionHandle(sessionHandle);
          sessionHandle = undefined;
        }
        upload = null;
        continue;
      }

      const updated = await UploadModel.findOneAndUpdate(
        { _id: uploadObjectId, status: "uploading" },
        { $inc: { attempts: 1 } },
        { new: true }
      ).lean();

      if (!updated) {
        upload = null;
        continue;
      }

      const attemptNumber: number = updated.attempts || 1;

      const proxyConfig =
        buildStickyProxyForAccount(
          (accountDoc as any).username,
          (accountDoc as any).proxy,
          attemptNumber,
          accountId
        ) ?? {
          server: process.env.PROXY_SERVER || "http://geo.iproyal.com:12321",
        };

      console.log("[MongoWorker] job start", {
        queue: "mongo-upload",
        uploadId,
        accountId,
        username: (accountDoc as any).username,
        attemptNumber,
        chained: Boolean(sessionHandle),
      });

      const musicQuery: string | undefined =
        typeof updated.musicQuery === "string" && updated.musicQuery.trim()
          ? updated.musicQuery.trim()
          : undefined;

      const videoForUpload = await resolveOptimizedVideoPath(videoPath);

      const sessionOpts =
        chainEnabled && browser ? { reuse: sessionHandle, holdSessionForChain: true as const } : undefined;

      const result = await runUploadWithSession(
        (accountDoc as any).username,
        (accountDoc as any).session,
        videoForUpload,
        caption,
        proxyConfig,
        browser,
        musicQuery,
        sessionOpts
      );

      if (result.success) {
        await UploadModel.updateOne(
          { _id: uploadObjectId },
          {
            $set: {
              status: "success",
              error: undefined,
              ...(result.soundUsed ? { soundUsed: result.soundUsed } : {}),
            },
          }
        );
        const successDoc = {
          ...updated,
          status: "success",
          campaignId: (updated as any).campaignId,
          campaignStep: (updated as any).campaignStep,
          accountId: updated.accountId,
        };
        await afterCampaignUploadSuccess(successDoc);

        await AccountModel.updateOne(
          { _id: new mongoose.Types.ObjectId(accountId) },
          { $set: { lastUsedAt: new Date(), status: "active" } }
        );
        console.log("[MongoWorker] job success", { uploadId, accountId, username: (accountDoc as any).username });
        await cleanupBatchIfLast(uploadId);

        if (chainEnabled && result.sessionHandle) {
          const next = await claimNextPendingUploadForAccount(accountId);
          if (next) {
            await sleep(chainGapMs());
            sessionHandle = result.sessionHandle;
            upload = next;
            continue;
          }
          await poolSessionHandleAfterUploadChain(result.sessionHandle);
        }

        upload = null;
        continue;
      }

      const errorMsg = result.error || "Upload failed";
      if (sessionHandle) {
        await discardUploadSessionHandle(sessionHandle);
        sessionHandle = undefined;
      }
      await markAccountExpiredIfSessionError(accountId, errorMsg);

      const maxAttempts = Math.max(1, Number(process.env.UPLOAD_MAX_ATTEMPTS || 1));
      const retryDelayMs = Number(process.env.UPLOAD_RETRY_DELAY_MS || 15000);
      const shouldRetry = !isSessionExpiredError(errorMsg) && attemptNumber < maxAttempts;

      if (shouldRetry) {
        await UploadModel.updateOne(
          { _id: uploadObjectId },
          {
            $set: { status: "pending", error: errorMsg, nextRetryAt: new Date(Date.now() + retryDelayMs) },
          }
        );
      } else {
        await UploadModel.updateOne(
          { _id: uploadObjectId },
          { $set: { status: "failed", error: errorMsg, nextRetryAt: null } }
        );
      }

      console.warn("[MongoWorker] job failed", {
        uploadId,
        accountId,
        username: (accountDoc as any).username,
        attemptNumber,
        willRetry: shouldRetry,
        error: errorMsg,
      });
      await cleanupBatchIfLast(uploadId);
      upload = null;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (sessionHandle) {
        await discardUploadSessionHandle(sessionHandle);
        sessionHandle = undefined;
      }
      await UploadModel.updateOne(
        { _id: uploadObjectId },
        { $set: { status: "failed", error: msg } }
      ).catch(() => {});
      console.error("[MongoWorker] processing error", { uploadId, accountId, msg });
      await cleanupBatchIfLast(uploadId);
      upload = null;
    }
  }
}

async function main() {
  await connectDB();
  ensureStorageJanitorStarted();

  const batchSize = getUploadParallelAdminCap();
  const pollIntervalMs = Number(process.env.UPLOAD_POLL_INTERVAL_MS || 2500);
  const batchGapMs = Number(process.env.UPLOAD_BATCH_GAP_MS || 0);

  const browser = await launchChromium("automation");
  console.log("[MongoWorker] started", { batchSize, pollIntervalMs, batchGapMs });

  process.on("SIGTERM", async () => {
    console.log("[MongoWorker] SIGTERM received, closing…");
    try {
      await browser.close();
    } catch {
      // ignore
    }
    process.exit(0);
  });

  while (true) {
    const claimed = await claimUploadBatch(batchSize, {
      excludeAccountIds: [...busyAccountIds],
    });
    if (!claimed.length) {
      await sleep(pollIntervalMs);
      continue;
    }

    for (const job of claimed) {
      busyAccountIds.add(String(job.accountId));
    }

    const running = claimed.map((u: any) =>
      processOneUpload(u, browser).finally(() => {
        busyAccountIds.delete(String(u.accountId));
      })
    );
    await Promise.allSettled(running);
    if (batchGapMs > 0) await sleep(batchGapMs);
    await sleep(pollIntervalMs);
  }
}

main().catch((e) => {
  console.error("[MongoWorker] fatal", e);
  process.exit(1);
});

