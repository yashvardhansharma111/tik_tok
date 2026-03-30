/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Browser } from "playwright";
import { launchChromium } from "@/lib/playwrightLaunch";
import mongoose from "mongoose";
import path from "path";
import fs from "fs/promises";
import { connectDB } from "@/lib/db";
import { AccountModel } from "@/lib/models/Account";
import { UploadModel } from "@/lib/models/Upload";
import { claimUploadBatch } from "@/lib/mongoUploadClaim";
import { runUploadWithSession } from "@/automation/uploadWorker";
import { buildStickyProxyForAccount } from "@/lib/proxyPlaywright";
import { isSessionExpiredError, markAccountExpiredIfSessionError } from "@/lib/accountSessionExpiry";

/** Single runner + abort handle survives Next.js HMR better than module-local flags alone. */
const RUNNER_SINGLETON_KEY = "__mongoUploadRunnerSingleton_v1";

type RunnerSingleton = {
  abort: AbortController | null;
};

function getRunnerSingleton(): RunnerSingleton {
  const g = globalThis as any;
  if (!g[RUNNER_SINGLETON_KEY]) {
    g[RUNNER_SINGLETON_KEY] = { abort: null } as RunnerSingleton;
  }
  return g[RUNNER_SINGLETON_KEY] as RunnerSingleton;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function cleanupBatchIfLast(uploadId: string) {
  try {
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

async function lockAccount(accountId: string) {
  const lockTtlMs = Number(process.env.ACCOUNT_LOCK_TTL_MS || 10 * 60 * 1000);
  const staleDate = new Date(Date.now() - lockTtlMs);

  return AccountModel.findOneAndUpdate(
    {
      _id: new mongoose.Types.ObjectId(accountId),
      $or: [
        { isUploading: { $ne: true } },
        { isUploadingAt: { $exists: false } },
        { isUploadingAt: null },
        { isUploadingAt: { $lt: staleDate } },
      ],
    },
    { $set: { isUploading: true, isUploadingAt: new Date(), status: "active" } },
    { returnDocument: "after" }
  ).lean();
}

async function unlockAccount(accountId: string) {
  await AccountModel.updateOne(
    { _id: new mongoose.Types.ObjectId(accountId) },
    { $set: { isUploading: false, isUploadingAt: null } }
  ).catch(() => {});
}

async function processUpload(upload: any, browser: Browser) {
  const uploadId: string = upload.uploadId;
  const accountId: string = String(upload.accountId);
  const caption: string = upload.caption;
  const uploadObjectId = upload._id;
  const videoPath = path.join(process.cwd(), "storage", "tmp-uploads", uploadId, "video.mp4");

  let lockedAccount: any = null;
  try {
    const hasVideo = await fs
      .stat(videoPath)
      .then(() => true)
      .catch(() => false);
    if (!hasVideo) {
      const err = `missing_video_file:${videoPath}`;
      console.warn("[MongoRunner] missing batch video — failing job", { uploadId, accountId, videoPath });
      await UploadModel.updateOne(
        { _id: uploadObjectId, status: "uploading" },
        {
          $set: {
            status: "failed",
            error: err,
            nextRetryAt: null,
          },
        }
      );
      return;
    }

    lockedAccount = await lockAccount(accountId);
    if (!lockedAccount) {
      console.warn("[MongoRunner] account busy — failing job (no requeue)", { uploadId, accountId });
      await UploadModel.updateOne(
        { _id: uploadObjectId, status: "uploading" },
        {
          $set: {
            status: "failed",
            error: "account_lock_busy",
            nextRetryAt: null,
          },
        }
      );
      return;
    }

    const bumped = await UploadModel.findOneAndUpdate(
      { _id: uploadObjectId, status: "uploading" },
      { $inc: { attempts: 1 } },
      { returnDocument: "after" }
    ).lean();

    if (!bumped) {
      return;
    }

    const updated = bumped;

    const musicQuery: string | undefined =
      typeof updated.musicQuery === "string" && updated.musicQuery.trim()
        ? updated.musicQuery.trim()
        : undefined;

    const attemptNumber: number = updated.attempts || 1;
    const proxyConfig =
      buildStickyProxyForAccount(lockedAccount.username, lockedAccount.proxy, attemptNumber) ?? {
        server: process.env.PROXY_SERVER || "http://geo.iproyal.com:12321",
      };

    console.log("[MongoRunner] start", {
      uploadId,
      accountId,
      username: lockedAccount.username,
      attemptNumber,
      musicQuery: musicQuery || "(none)",
    });

    const result = await runUploadWithSession(
      lockedAccount.username,
      lockedAccount.session,
      videoPath,
      caption,
      proxyConfig,
      browser,
      musicQuery
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
      console.log("[MongoRunner] success", { uploadId, accountId, username: lockedAccount.username });
      await AccountModel.updateOne(
        { _id: new mongoose.Types.ObjectId(accountId) },
        { $set: { lastUsedAt: new Date(), status: "active" } }
      );
      return;
    }

    const errorMsg = result.error || "Upload failed";
    await markAccountExpiredIfSessionError(accountId, errorMsg);

    const maxAttempts = Math.max(1, Number(process.env.UPLOAD_MAX_ATTEMPTS || 1));
    const shouldRetry = !isSessionExpiredError(errorMsg) && attemptNumber < maxAttempts;

    if (shouldRetry) {
      const retryDelayMs = Number(process.env.UPLOAD_RETRY_DELAY_MS || 15000);
      await UploadModel.updateOne(
        { _id: uploadObjectId },
        {
          $set: {
            status: "pending",
            error: errorMsg,
            nextRetryAt: new Date(Date.now() + retryDelayMs),
          },
        }
      );
    } else {
      await UploadModel.updateOne(
        { _id: uploadObjectId },
        { $set: { status: "failed", error: errorMsg, nextRetryAt: null } }
      );
    }

    console.warn("[MongoRunner] failed", {
      uploadId,
      accountId,
      username: lockedAccount.username,
      attemptNumber,
      willRetry: shouldRetry,
      error: errorMsg,
    });
  } finally {
    if (lockedAccount) {
      await unlockAccount(accountId);
    }
    await cleanupBatchIfLast(uploadId);
  }
}

async function runnerLoop(signal: AbortSignal) {
  const batchSize = Math.max(1, Math.min(32, Number(process.env.UPLOAD_PARALLEL_BATCH_SIZE || 4)));
  const pollIntervalMs = Number(process.env.UPLOAD_POLL_INTERVAL_MS || 2500);
  /** Optional pause after a parallel wave finishes (before the next 1–4 / 5–8 wave). */
  const batchGapMs = Number(process.env.UPLOAD_BATCH_GAP_MS || 0);

  const browser = await launchChromium("automation");
  console.log("[MongoRunner] started", { batchSize, pollIntervalMs, batchGapMs });

  try {
    while (!signal.aborted) {
      const claimed = await claimUploadBatch(batchSize);
      if (!claimed.length) {
        await sleep(pollIntervalMs);
        continue;
      }

      console.log("[MongoRunner] wave", {
        count: claimed.length,
        uploadId: claimed[0]?.uploadId,
        ids: claimed.map((c: any) => String(c.accountId)),
      });

      const running = claimed.map((job: any) => processUpload(job, browser));
      await Promise.allSettled(running);

      if (signal.aborted) break;
      if (batchGapMs > 0) await sleep(batchGapMs);
      await sleep(pollIntervalMs);
    }
  } finally {
    await browser.close().catch(() => {});
    console.log("[MongoRunner] stopped");
  }
}

export function ensureMongoUploadRunnerStarted() {
  const box = getRunnerSingleton();
  if (box.abort && !box.abort.signal.aborted) {
    console.log("[MongoRunner] already running, skip duplicate start");
    return;
  }

  box.abort?.abort();
  const ac = new AbortController();
  box.abort = ac;

  console.log("[MongoRunner] ensure start called");

  setTimeout(async () => {
    try {
      await connectDB();
      await runnerLoop(ac.signal);
    } catch (e) {
      console.error("[MongoRunner] fatal", e);
    }
  }, 0);
}

