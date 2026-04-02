import fs from "fs/promises";
import path from "path";
import { Worker, type Job } from "bullmq";
import { redisConnection, QUEUE_NAME, type UploadJobPayload } from "../lib/queue";
import { connectDB } from "../lib/db";
import { AccountModel } from "../lib/models/Account";
import { UploadModel } from "../lib/models/Upload";
import { runUploadWithSession } from "../automation/uploadWorker";
import { resolveOptimizedVideoPath } from "../lib/optimizeVideoForUpload";
import { launchChromium } from "../lib/playwrightLaunch";
import { isSessionExpiredError, markAccountExpiredIfSessionError } from "../lib/accountSessionExpiry";
import mongoose from "mongoose";

let browserInstance: import("playwright").Browser | null = null;
async function getBrowser() {
  if (browserInstance) return browserInstance;
  browserInstance = await launchChromium("automation");
  return browserInstance;
}

function buildIproxyConfig(
  accountUsername: string,
  attemptNumber: number,
  proxyServer?: string,
  proxyBaseUser?: string,
  proxyBasePass?: string
) {
  const server = (proxyServer && proxyServer.trim()) || process.env.PROXY_SERVER || "http://geo.iproyal.com:12321";
  const username = proxyBaseUser || process.env.PROXY_USERNAME;
  const passwordBase = proxyBasePass || process.env.PROXY_PASSWORD;

  if (!username || !passwordBase) {
    console.warn("[Queue] proxy credentials missing (PROXY_USERNAME/PROXY_PASSWORD). Using server only.", {
      accountUsername,
      server,
    });
    return { server };
  }

  // Sticky per-account session in IPRoyal password
  return {
    server,
    username,
    password: `${passwordBase}_session-${accountUsername}-${attemptNumber}`,
  };
}

async function cleanupBatchIfLast(videoPath: string, uploadId: string) {
  try {
    // If no uploads for this batch are still pending/uploading, we can delete the shared video temp file.
    const remaining = await UploadModel.countDocuments({
      uploadId,
      status: { $in: ["pending", "uploading"] },
    });

    if (remaining > 0) return;

    await fs.unlink(videoPath).catch(() => {});
    const dir = path.dirname(videoPath);
    // Best-effort cleanup of parent folder.
    await fs.rmdir(dir, { recursive: true }).catch(() => {});
  } catch {
    // Ignore cleanup errors; uploads still have DB status.
  }
}

async function processUpload(job: Job<UploadJobPayload>) {
  const { uploadId, accountId, username, session, proxy, videoPath, caption, musicQuery } = job.data;
  const maxAttempts = typeof job.opts?.attempts === "number" ? job.opts.attempts : 2;
  const shouldRetryAfterThis = job.attemptsMade + 1 < maxAttempts;
  const attemptNumber = job.attemptsMade + 1;

  await connectDB();

  console.log("[Queue] job start", {
    queue: QUEUE_NAME,
    jobId: job.id,
    uploadId,
    accountId,
    username,
    attempt: job.attemptsMade + 1,
    maxAttempts,
  });

  let uploadDocId: string | null = job.data.uploadDocId ?? null;

  try {
    const uploadDoc =
      uploadDocId
        ? await UploadModel.findById(uploadDocId).lean()
        : await UploadModel.findOne({
            uploadId,
            accountId: new mongoose.Types.ObjectId(accountId),
          }).lean();

    if (!uploadDoc) {
      throw new Error(`UPLOAD_NOT_FOUND:${uploadId}:${accountId}`);
    }
    uploadDocId = String(uploadDoc._id);

    await UploadModel.updateOne(
      { _id: uploadDoc._id },
      { $set: { status: "uploading", error: undefined } }
    );

    const proxyConfig = buildIproxyConfig(
      username,
      attemptNumber,
      proxy,
      process.env.PROXY_USERNAME,
      process.env.PROXY_PASSWORD
    );

    const activeBrowser = await getBrowser();
    const videoForUpload = await resolveOptimizedVideoPath(videoPath);
    const result = await runUploadWithSession(
      username,
      session,
      videoForUpload,
      caption,
      proxyConfig,
      activeBrowser,
      musicQuery
    );

    if (result.success) {
      await UploadModel.updateOne(
        { _id: uploadDoc._id },
        {
          $set: {
            status: "success",
            error: undefined,
            ...(result.soundUsed ? { soundUsed: result.soundUsed } : {}),
          },
        }
      );
      await AccountModel.updateOne(
        { _id: accountId },
        { $set: { lastUsedAt: new Date(), status: "active" } }
      );
      console.log("[Queue] job success", { uploadId, accountId, username });
      return;
    }

    const errorMsg = result.error || "Upload failed";
    await markAccountExpiredIfSessionError(accountId, errorMsg);

    const retryThis = shouldRetryAfterThis && !isSessionExpiredError(errorMsg);

    if (retryThis) {
      await UploadModel.updateOne(
        { _id: uploadDoc._id },
        { $set: { status: "pending", error: undefined } }
      );
      console.warn("[Queue] job failed (will retry)", {
        uploadId,
        accountId,
        username,
        error: errorMsg,
      });
      throw new Error(`${errorMsg} (will retry)`);
    }

    await UploadModel.updateOne(
      { _id: uploadDoc._id },
      { $set: { status: "failed", error: errorMsg } }
    );
    console.error("[Queue] job failed (final)", { uploadId, accountId, username, error: errorMsg });
    throw new Error(errorMsg);
  } catch (e) {
    // Generic failure handling: keep pending for retryable attempts.
    const msg = e instanceof Error ? e.message : String(e);
    const isProxyFailure =
      msg.includes("ERR_PROXY") ||
      msg.includes("proxy") && msg.toLowerCase().includes("fail") ||
      msg.includes("ERR_TUNNEL") ||
      msg.includes("ECONNRESET");

    if (isProxyFailure) {
      console.warn("[Queue] proxy-related failure detected", { uploadId, accountId, username, attemptNumber, msg });
    }
    const uploadObjectId = uploadDocId ? new mongoose.Types.ObjectId(uploadDocId) : null;

    if (uploadObjectId) {
      if (shouldRetryAfterThis) {
        await UploadModel.updateOne(
          { _id: uploadObjectId },
          { $set: { status: "pending", error: undefined } }
        ).catch(() => {});
      } else {
        await UploadModel.updateOne(
          { _id: uploadObjectId },
          { $set: { status: "failed", error: msg } }
        ).catch(() => {});
      }
    }

    console.error("[Queue] job catch", {
      uploadId,
      accountId,
      username,
      error: msg,
      willRetry: shouldRetryAfterThis,
    });
    throw e;
  } finally {
    await cleanupBatchIfLast(videoPath, uploadId);
  }
}

const concurrency = Number(process.env.UPLOAD_WORKER_CONCURRENCY || 2);

const worker = new Worker<UploadJobPayload>(
  QUEUE_NAME,
  async (job) => processUpload(job),
  {
    connection: redisConnection,
    concurrency,
    limiter: {
      // TikTok is sensitive: default 1 job start per 5 seconds.
      max: Number(process.env.UPLOAD_JOB_LIMITER_MAX || 1),
      duration: Number(process.env.UPLOAD_JOB_LIMITER_DURATION_MS || 5000),
    },
    // BullMQ will retry on thrown errors.
    // We'll still set upload status to failed for visibility.
    lockDuration: 300_000,
  }
);

worker.on("completed", (job) => {
  console.log("[Queue] completed", { queue: QUEUE_NAME, jobId: job.id, name: job.name });
});

worker.on("failed", (job, err) => {
  console.error("[Queue] failed", {
    queue: QUEUE_NAME,
    jobId: job?.id,
    name: job?.name,
    error: err?.message,
  });
});

console.log(`[Queue] upload worker started`, { queue: QUEUE_NAME, concurrency });

// Keep process alive
process.on("SIGTERM", () => {
  worker.close().then(async () => {
    try {
      if (browserInstance) await browserInstance.close();
    } catch {
      // ignore
    }
    process.exit(0);
  });
});

