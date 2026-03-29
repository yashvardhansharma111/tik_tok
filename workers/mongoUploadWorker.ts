/* eslint-disable @typescript-eslint/no-explicit-any */
import path from "path";
import fs from "fs/promises";
import { launchChromium } from "../lib/playwrightLaunch";
import mongoose from "mongoose";
import { connectDB } from "../lib/db";
import { AccountModel } from "../lib/models/Account";
import { UploadModel } from "../lib/models/Upload";
import { claimUploadBatch } from "../lib/mongoUploadClaim";
import { runUploadWithSession } from "../automation/uploadWorker";

type PlaywrightProxyConfig = {
  server: string;
  username?: string;
  password?: string;
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function buildIproxyConfig(accountUsername: string, proxyServer?: string, attemptNumber?: number) {
  const server = (proxyServer && proxyServer.trim()) || process.env.PROXY_SERVER || "http://geo.iproyal.com:12321";
  const username = process.env.PROXY_USERNAME;
  const passwordBase = process.env.PROXY_PASSWORD;

  if (!username || !passwordBase) {
    console.warn("[MongoWorker] proxy credentials missing (PROXY_USERNAME/PROXY_PASSWORD). Using server only.", {
      accountUsername,
      server,
    });
    return { server };
  }

  const suffix = attemptNumber ? `-${attemptNumber}` : "";
  return {
    server,
    username,
    password: `${passwordBase}_session-${accountUsername}${suffix}`,
  } as PlaywrightProxyConfig;
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

async function unlockAccount(accountId: string) {
  await AccountModel.updateOne(
    { _id: new mongoose.Types.ObjectId(accountId) },
    { $set: { isUploading: false, isUploadingAt: null } }
  ).catch(() => {});
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
    { new: true }
  ).lean();
}

async function processOneUpload(upload: any, browser: import("playwright").Browser) {
  const uploadId: string = upload.uploadId;
  const accountId: string = String(upload.accountId);
  const caption: string = upload.caption;
  const uploadObjectId = upload._id;

  const videoPath = path.join(process.cwd(), "storage", "tmp-uploads", uploadId, "video.mp4");

  let lockedAccount: any = null;
  try {
    lockedAccount = await lockAccount(accountId);
    if (!lockedAccount) {
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

    const updated = await UploadModel.findOneAndUpdate(
      { _id: uploadObjectId, status: "uploading" },
      { $inc: { attempts: 1 } },
      { new: true }
    ).lean();

    if (!updated) {
      await unlockAccount(accountId);
      return;
    }

    const attemptNumber: number = updated.attempts || 1;

    const proxyConfig = buildIproxyConfig(lockedAccount.username, lockedAccount.proxy, attemptNumber);

    console.log("[MongoWorker] job start", {
      queue: "mongo-upload",
      uploadId,
      accountId,
      username: lockedAccount.username,
      attemptNumber,
    });

    const musicQuery: string | undefined =
      typeof updated.musicQuery === "string" && updated.musicQuery.trim()
        ? updated.musicQuery.trim()
        : undefined;

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
      await AccountModel.updateOne(
        { _id: new mongoose.Types.ObjectId(accountId) },
        { $set: { lastUsedAt: new Date(), status: "active", isUploading: false, isUploadingAt: null } }
      );
      console.log("[MongoWorker] job success", { uploadId, accountId, username: lockedAccount.username });
    } else {
      const errorMsg = result.error || "Upload failed";
      const maxAttempts = Math.max(1, Number(process.env.UPLOAD_MAX_ATTEMPTS || 1));
      const retryDelayMs = Number(process.env.UPLOAD_RETRY_DELAY_MS || 15000);

      if (attemptNumber < maxAttempts) {
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

      await unlockAccount(accountId);
      console.warn("[MongoWorker] job failed", {
        uploadId,
        accountId,
        username: lockedAccount.username,
        attemptNumber,
        willRetry: attemptNumber < maxAttempts,
        error: errorMsg,
      });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await UploadModel.updateOne(
      { _id: uploadObjectId },
      { $set: { status: "failed", error: msg } }
    ).catch(() => {});
    await unlockAccount(accountId);
    console.error("[MongoWorker] processing error", { uploadId, accountId, msg });
  } finally {
    await cleanupBatchIfLast(uploadId);
  }
}

async function main() {
  await connectDB();

  const batchSize = Math.max(1, Math.min(32, Number(process.env.UPLOAD_PARALLEL_BATCH_SIZE || 4)));
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
    const claimed = await claimUploadBatch(batchSize);
    if (!claimed.length) {
      await sleep(pollIntervalMs);
      continue;
    }

    const running = claimed.map((u) => processOneUpload(u, browser).then(() => {}));
    await Promise.allSettled(running);
    if (batchGapMs > 0) await sleep(batchGapMs);
    await sleep(pollIntervalMs);
  }
}

main().catch((e) => {
  console.error("[MongoWorker] fatal", e);
  process.exit(1);
});

