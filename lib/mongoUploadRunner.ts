/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Browser } from "playwright";
import { launchChromium } from "@/lib/playwrightLaunch";
import mongoose from "mongoose";
import path from "path";
import fs from "fs/promises";
import { connectDB } from "@/lib/db";
import { AccountModel } from "@/lib/models/Account";
import { UploadModel } from "@/lib/models/Upload";
import { ensureStorageJanitorStarted } from "@/lib/storageJanitor";
import { claimUploadBatch } from "@/lib/mongoUploadClaim";
import { claimNextPendingUploadForAccount } from "@/lib/mongoUploadChainClaim";
import { getUploadParallelAdminCap } from "@/lib/uploadParallelConfig";
import {
  runUploadWithSession,
  poolSessionHandleAfterUploadChain,
  discardUploadSessionHandle,
} from "@/automation/uploadWorker";
import { resolveOptimizedVideoPath } from "@/lib/optimizeVideoForUpload";
import { buildStickyProxyForAccount } from "@/lib/proxyPlaywright";
import { isSessionExpiredError, markAccountExpiredIfSessionError } from "@/lib/accountSessionExpiry";
import { afterCampaignUploadSuccess, campaignBlocksBatchCleanup } from "@/lib/campaignJobQueue";

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

/** Random delay between chained uploads on the same page (ms). */
function chainGapMs(): number {
  const lo = Math.max(0, Number(process.env.UPLOAD_CHAIN_GAP_MIN_MS || 1000));
  const hi = Math.max(lo, Number(process.env.UPLOAD_CHAIN_GAP_MAX_MS || 3000));
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

/** When enabled, consecutive pending jobs for the same account reuse one Playwright page (smaller egress after first load). */
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

async function processUpload(initialUpload: any, browser: Browser | undefined) {
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
        if (sessionHandle) {
          await discardUploadSessionHandle(sessionHandle);
          sessionHandle = undefined;
        }
        upload = null;
        continue;
      }

      const accountDoc = await AccountModel.findById(accountId).lean();
      if (!accountDoc) {
        console.warn("[MongoRunner] account not found", { uploadId, accountId });
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

      const bumped = await UploadModel.findOneAndUpdate(
        { _id: uploadObjectId, status: "uploading" },
        { $inc: { attempts: 1 } },
        { returnDocument: "after" }
      ).lean();

      if (!bumped) {
        upload = null;
        continue;
      }

      const updated = bumped;

      const musicQuery: string | undefined =
        typeof updated.musicQuery === "string" && updated.musicQuery.trim()
          ? updated.musicQuery.trim()
          : undefined;

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

      const campaignId = (upload as any).campaignId as string | undefined;
      const campaignStep = (upload as any).campaignStep as number | undefined;
      const videoRel = typeof (upload as any).videoRelPath === "string" ? (upload as any).videoRelPath : "";

      console.log("[MongoRunner] start upload", {
        uploadId,
        accountId,
        username: (accountDoc as any).username,
        attemptNumber,
        musicQuery: musicQuery || "(none)",
        chained: Boolean(sessionHandle),
        ...(campaignId
          ? {
              campaignUploadId: campaignId,
              campaignStep: campaignStep ?? 0,
              videoFile: videoRel || "(default)",
            }
          : { campaignUploadId: null }),
      });

      const videoForUpload = await resolveOptimizedVideoPath(videoPath);

      /** Chain reuse depends on sessionHandle from the previous step, not on the runner’s shared Browser. */
      const sessionOpts =
        chainEnabled && sessionHandle
          ? { reuse: sessionHandle, holdSessionForChain: true as const }
          : undefined;

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

        console.log("[MongoRunner] success", {
          uploadId,
          accountId,
          username: (accountDoc as any).username,
          ...(campaignId
            ? { campaignUploadId: campaignId, campaignStep: campaignStep ?? 0, videoFile: videoRel || "" }
            : {}),
        });
        await AccountModel.updateOne(
          { _id: new mongoose.Types.ObjectId(accountId) },
          { $set: { lastUsedAt: new Date(), status: "active" } }
        );
        await cleanupBatchIfLast(uploadId);

        if (chainEnabled && result.sessionHandle) {
          const next = await claimNextPendingUploadForAccount(accountId);
          if (next) {
            console.log("[MongoRunner] chain: next job same account", {
              accountId,
              nextUploadId: next.uploadId,
            });
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
        username: (accountDoc as any).username,
        attemptNumber,
        willRetry: shouldRetry,
        error: errorMsg,
      });
      await cleanupBatchIfLast(uploadId);
      upload = null;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[MongoRunner] processUpload error", msg);
      if (sessionHandle) {
        await discardUploadSessionHandle(sessionHandle);
        sessionHandle = undefined;
      }
      await UploadModel.updateOne(
        { _id: uploadObjectId, status: "uploading" },
        { $set: { status: "failed", error: msg, nextRetryAt: null } }
      ).catch(() => {});
      await cleanupBatchIfLast(uploadId);
      upload = null;
    }
  }
}

async function runnerLoop(signal: AbortSignal) {
  const batchSize = getUploadParallelAdminCap();
  const pollIntervalMs = Number(process.env.UPLOAD_POLL_INTERVAL_MS || 2500);
  /** Optional pause after a parallel wave finishes (before the next wave). */
  const batchGapMs = Number(process.env.UPLOAD_BATCH_GAP_MS || 0);

  const browser = await launchChromium("automation");
  console.log("[MongoRunner] started", {
    serverParallelCap: batchSize,
    UPLOAD_PARALLEL_BATCH_SIZE: process.env.UPLOAD_PARALLEL_BATCH_SIZE ?? "(unset → 32)",
    pollIntervalMs,
    batchGapMs,
    hint: "Campaign 'Parallel accounts' cannot exceed serverParallelCap — set UPLOAD_PARALLEL_BATCH_SIZE in .env (e.g. 4) to allow N concurrent accounts per wave.",
  });

  try {
    while (!signal.aborted) {
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

      const jobParallelism = Number((claimed[0] as any)?.parallelism) || batchSize;
      /** Sharing one Playwright Browser across concurrent uploads often ends in BROWSER_CLOSED during heavy Studio flows; use a dedicated browser per job when a wave has multiple claims. */
      const oneBrowserPerJob = claimed.length > 1;
      console.log("[MongoRunner] wave claimed", {
        concurrentJobsThisWave: claimed.length,
        serverParallelCap: batchSize,
        batchParallelismField: jobParallelism,
        uploadId: claimed[0]?.uploadId,
        accountIds: claimed.map((c: any) => String(c.accountId)),
        browserMode: oneBrowserPerJob
          ? "isolated: each job launches its own Chromium (parallel-safe)"
          : "shared: runner holds one Chromium for this single job",
        fewerClaimsThanParallelism:
          claimed.length < jobParallelism
            ? "Some jobs not ready yet (notBefore in future), server cap, or no pending rows — if you use stagger>0 with parallelism=1 only, that is expected; with parallelism>1, intra-wave stagger is ignored."
            : undefined,
      });

      const browserForJobs = oneBrowserPerJob ? undefined : browser;
      const running = claimed.map((job: any) =>
        processUpload(job, browserForJobs).finally(() => {
          busyAccountIds.delete(String(job.accountId));
        })
      );
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
      ensureStorageJanitorStarted();
      await connectDB();
      await runnerLoop(ac.signal);
    } catch (e) {
      console.error("[MongoRunner] fatal", e);
    }
  }, 0);
}

