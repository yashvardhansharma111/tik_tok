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
  discardUploadSessionHandle,
} from "@/automation/uploadWorker";
import { clearAllUploadContexts } from "@/lib/uploadContextPool";
import { resolveOptimizedVideoPath } from "@/lib/optimizeVideoForUpload";
import { buildStickyProxyForAccount, type PlaywrightProxyConfig } from "@/lib/proxyPlaywright";
import { isSessionExpiredError, markAccountExpiredIfSessionError } from "@/lib/accountSessionExpiry";
import { uploadViaAdsPower } from "@/automation/adspowerUpload";
import { afterCampaignUploadSuccess, afterCampaignJobPermanentFail } from "@/lib/campaignJobQueue";
import { tryCleanupUploadBatch } from "@/lib/tmpUploadCleanup";

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
  const lo = Math.max(0, Number(process.env.UPLOAD_CHAIN_GAP_MIN_MS || 350));
  const hi = Math.max(lo, Number(process.env.UPLOAD_CHAIN_GAP_MAX_MS || 900));
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

/** When enabled, consecutive pending jobs for the same account reuse one Playwright page (smaller egress after first load). */
function samePageChainEnabled(): boolean {
  return process.env.TIKTOK_UPLOAD_SAME_PAGE_CHAIN !== "0" && process.env.TIKTOK_UPLOAD_SAME_PAGE_CHAIN !== "false";
}

const busyAccountIds = new Set<string>();

function cleanupBatchIfLast(uploadId: string) {
  return tryCleanupUploadBatch(uploadId);
}

/**
 * Shape returned by loadGoLoginAccount. Adapts the gologin_accounts schema
 * (structured proxy + storageState object) to what runUploadWithSession expects
 * (PlaywrightProxyConfig + JSON-stringified session).
 */
type GoLoginAccountAdapted = {
  username: string;
  session: string;              // JSON-stringified storageState for runUploadWithSession
  proxyConfig: PlaywrightProxyConfig;
  updatedAt: Date;              // last time the session was captured/refreshed (for freshness check)
  adspowerProfileId?: string;   // if present, upload goes through AdsPower (not standalone Playwright)
};

const GOLOGIN_COLLECTION_NAME = () => process.env.GOLOGIN_ACCOUNTS_COLLECTION || "gologin_accounts";

/**
 * Update a gologin_accounts document. Used for lastUsedAt + status transitions.
 * Fails silently — status tracking should never break an upload.
 */
async function updateGoLoginAccountStatus(
  accountId: string,
  update: Record<string, unknown>
): Promise<void> {
  try {
    await mongoose.connection.collection(GOLOGIN_COLLECTION_NAME()).updateOne(
      { accountId },
      { $set: { ...update, updatedAt: new Date() } }
    );
  } catch (e) {
    console.warn("[MongoRunner] updateGoLoginAccountStatus failed", {
      accountId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Returns true if a gologin account's captured session is older than
 * GOLOGIN_SESSION_MAX_AGE_DAYS (default 3 days). Expired sessions must be
 * re-captured via loginAndCaptureSession before they can be used again.
 */
function isGoLoginSessionExpired(updatedAt: Date): boolean {
  const maxDays = Number(process.env.GOLOGIN_SESSION_MAX_AGE_DAYS || 3);
  if (!Number.isFinite(maxDays) || maxDays <= 0) return false;
  const maxAgeMs = maxDays * 24 * 60 * 60 * 1000;
  return Date.now() - new Date(updatedAt).getTime() > maxAgeMs;
}

/**
 * Verify the exit IP of a proxy config using Playwright's APIRequestContext.
 * Uses the same proxy code path as browser launches (no extra deps needed).
 * Returns the exit IP string, or null if the check fails.
 *
 * Opt-in via PROXY_VERIFY=1 — adds ~500ms and one external request per upload.
 */
async function verifyProxyIP(proxyConfig: PlaywrightProxyConfig): Promise<string | null> {
  if (process.env.PROXY_VERIFY !== "1" && process.env.PROXY_VERIFY !== "true") {
    return null;
  }
  try {
    const { request } = await import("playwright");
    const ctx = await request.newContext({
      proxy: {
        server: proxyConfig.server,
        username: proxyConfig.username,
        password: proxyConfig.password,
      },
      timeout: 10_000,
    });
    try {
      const res = await ctx.get("https://api.ipify.org?format=json");
      if (!res.ok()) {
        console.warn("[MongoRunner] verifyProxyIP: non-2xx", { status: res.status() });
        return null;
      }
      const body = (await res.json()) as { ip?: string };
      return body.ip || null;
    } finally {
      await ctx.dispose().catch(() => {});
    }
  } catch (e) {
    console.warn("[MongoRunner] verifyProxyIP failed", {
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

/**
 * Loads an account from the gologin_accounts collection (populated by
 * automation/loginAndCaptureSession.ts) and adapts it for the upload worker.
 *
 * Returns null if the account doesn't exist or the document is malformed —
 * caller should fall back to the legacy AccountModel path.
 *
 * CRITICAL: the returned proxyConfig is the SAME sticky proxy that was used
 * at login time. Using a different proxy here would cause TikTok session
 * invalidation / captcha / shadow-ban.
 */
async function loadGoLoginAccount(accountId: string): Promise<GoLoginAccountAdapted | null> {
  try {
    const doc = await mongoose.connection.collection(GOLOGIN_COLLECTION_NAME()).findOne({ accountId });
    if (!doc) return null;

    const proxy = (doc as any).proxy;
    const storageState = (doc as any).session?.storageState;
    const username = (doc as any).username;
    const updatedAt = (doc as any).updatedAt;
    const adspowerProfileId = (doc as any).adspowerProfileId;

    if (!username || typeof username !== "string") {
      console.warn("[MongoRunner] gologin_accounts: missing username", { accountId });
      return null;
    }
    if (!proxy || !proxy.host || !proxy.port || !proxy.username || !proxy.password) {
      console.warn("[MongoRunner] gologin_accounts: malformed proxy", { accountId });
      return null;
    }
    if (!storageState || typeof storageState !== "object") {
      console.warn("[MongoRunner] gologin_accounts: missing session.storageState", { accountId });
      return null;
    }

    return {
      username,
      session: JSON.stringify(storageState),
      proxyConfig: {
        server: `http://${proxy.host}:${proxy.port}`,
        username: String(proxy.username),
        password: String(proxy.password),
      },
      updatedAt: updatedAt instanceof Date ? updatedAt : new Date(updatedAt || 0),
      adspowerProfileId: typeof adspowerProfileId === "string" ? adspowerProfileId : undefined,
    };
  } catch (e) {
    console.warn("[MongoRunner] loadGoLoginAccount error", {
      accountId,
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
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
        await afterCampaignJobPermanentFail({
          campaignId: (upload as any).campaignId,
          accountId,
          campaignStep: (upload as any).campaignStep ?? 0,
          error: err,
        }).catch(() => {});
        if (sessionHandle) {
          await discardUploadSessionHandle(sessionHandle);
          sessionHandle = undefined;
        }
        upload = null;
        continue;
      }

      // Try the new gologin_accounts collection first (populated by loginAndCaptureSession).
      // If the account was captured through GoLogin, this returns the stored sticky proxy
      // and storageState so the upload uses the exact same IP the login was captured on.
      const gologinAccount = await loadGoLoginAccount(accountId);

      // Session freshness gate — gologin captures have a max age (default 3 days).
      // Older than that: mark expired and fail permanently, user must re-run capture.
      if (gologinAccount && isGoLoginSessionExpired(gologinAccount.updatedAt)) {
        console.warn("[MongoRunner] gologin session too old, marking expired", {
          accountId,
          updatedAt: gologinAccount.updatedAt,
          maxAgeDays: Number(process.env.GOLOGIN_SESSION_MAX_AGE_DAYS || 3),
        });
        await updateGoLoginAccountStatus(accountId, { status: "expired" });
        await UploadModel.updateOne(
          { _id: uploadObjectId, status: "uploading" },
          {
            $set: {
              status: "failed",
              error: "SESSION_EXPIRED: gologin capture older than max age — re-run loginAndCaptureSession",
              nextRetryAt: null,
            },
          }
        );
        await afterCampaignJobPermanentFail({
          campaignId: (upload as any).campaignId,
          accountId,
          campaignStep: (upload as any).campaignStep ?? 0,
          error: "SESSION_EXPIRED",
        }).catch(() => {});
        if (sessionHandle) {
          await discardUploadSessionHandle(sessionHandle);
          sessionHandle = undefined;
        }
        upload = null;
        continue;
      }

      const accountDoc = gologinAccount
        ? (gologinAccount as unknown as { username: string; session: string })
        : await AccountModel.findById(accountId).lean();

      if (!accountDoc) {
        console.warn("[MongoRunner] account not found (checked gologin_accounts + legacy)", { uploadId, accountId });
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
        await afterCampaignJobPermanentFail({
          campaignId: (upload as any).campaignId,
          accountId,
          campaignStep: (upload as any).campaignStep ?? 0,
          error: "account_not_found",
        }).catch(() => {});
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

      // CRITICAL: if the account came from gologin_accounts, use its stored proxy directly.
      // Login proxy === upload proxy. Using a different proxy on upload will invalidate the
      // TikTok session (captcha / shadow-ban / logout).
      const proxyConfig: PlaywrightProxyConfig = gologinAccount
        ? gologinAccount.proxyConfig
        : (buildStickyProxyForAccount(
            (accountDoc as any).username,
            (accountDoc as any).proxy,
            attemptNumber,
            accountId
          ) ?? {
            server: process.env.PROXY_SERVER || "http://geo.iproyal.com:12321",
          });

      const campaignId = (upload as any).campaignId as string | undefined;
      const campaignStep = (upload as any).campaignStep as number | undefined;
      const videoRel = typeof (upload as any).videoRelPath === "string" ? (upload as any).videoRelPath : "";

      const useAdsPower =
        gologinAccount?.adspowerProfileId &&
        process.env.ADSPOWER_ENABLED !== "0" &&
        process.env.ADSPOWER_ENABLED !== "false";

      console.log("[MongoRunner] start upload", {
        uploadId,
        accountId,
        username: (accountDoc as any).username,
        attemptNumber,
        musicQuery: musicQuery || "(none)",
        chained: Boolean(sessionHandle),
        via: useAdsPower ? "adspower" : "playwright",
        ...(useAdsPower ? { adspowerProfileId: gologinAccount!.adspowerProfileId } : {}),
        ...(campaignId
          ? {
              campaignUploadId: campaignId,
              campaignStep: campaignStep ?? 0,
              videoFile: videoRel || "(default)",
            }
          : { campaignUploadId: null }),
      });

      const videoForUpload = await resolveOptimizedVideoPath(videoPath);

      let result: { success: boolean; error?: string; soundUsed?: string; sessionHandle?: any };

      if (useAdsPower) {
        // ━━━━━ AdsPower path: same fingerprint as login, no proxy/cookie juggling ━━━━━
        const adspResult = await uploadViaAdsPower({
          adspowerProfileId: gologinAccount!.adspowerProfileId!,
          username: (accountDoc as any).username,
          videoPath: videoForUpload,
          caption,
          musicQuery,
        });

        // If AdsPower detected session expired, mark account as logged_out immediately
        if (adspResult.sessionExpired) {
          console.warn("[MongoRunner] AdsPower detected session expired", { accountId });
          await updateGoLoginAccountStatus(accountId, { status: "logged_out" });
        }

        result = {
          success: adspResult.success,
          error: adspResult.error,
          soundUsed: adspResult.soundUsed,
        };

        // Async gap between AdsPower uploads — randomized delay to look human.
        // Only applies when there are more jobs coming for the same wave.
        const gapMin = Math.max(0, Number(process.env.UPLOAD_INTER_GAP_MIN_MS || 3000));
        const gapMax = Math.max(gapMin, Number(process.env.UPLOAD_INTER_GAP_MAX_MS || 12000));
        const gap = gapMin + Math.floor(Math.random() * (gapMax - gapMin + 1));
        console.log("[MongoRunner] inter-upload gap", { gap, accountId });
        await sleep(gap);

      } else {
        // ━━━━━ Legacy Playwright path: standalone browser + storageState file ━━━━━
        // Opt-in proxy exit-IP verification (PROXY_VERIFY=1).
        const verifiedIp = await verifyProxyIP(proxyConfig);
        if (verifiedIp) {
          console.log("[MongoRunner] proxy exit IP", { accountId, ip: verifiedIp });
        }

        /** Chain reuse depends on sessionHandle from the previous step, not on the runner’s shared Browser. */
        const sessionOpts =
          chainEnabled && sessionHandle
            ? { reuse: sessionHandle, holdSessionForChain: true as const }
            : undefined;

        result = await runUploadWithSession(
          (accountDoc as any).username,
          (accountDoc as any).session,
          videoForUpload,
          caption,
          proxyConfig,
          browser,
          musicQuery,
          sessionOpts
        );
      }

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
        if (gologinAccount) {
          await updateGoLoginAccountStatus(accountId, {
            lastUsedAt: new Date(),
            status: "active",
          });
        } else {
          await AccountModel.updateOne(
            { _id: new mongoose.Types.ObjectId(accountId) },
            { $set: { lastUsedAt: new Date(), status: "active" } }
          );
        }
        await cleanupBatchIfLast(uploadId);

        if (chainEnabled && result.sessionHandle) {
          const next = await claimNextPendingUploadForAccount(accountId);
          if (next) {
            console.log("[MongoRunner] chain: next job same account — reusing browser", {
              accountId,
              nextUploadId: next.uploadId,
            });
            await sleep(chainGapMs());
            sessionHandle = result.sessionHandle;
            upload = next;
            continue;
          }
          // No more videos for this account — close the session instead of pooling
          console.log("[MongoRunner] no more jobs for account — closing browser session");
          await discardUploadSessionHandle(result.sessionHandle);
        }

        upload = null;
        continue;
      }

      const errorMsg = result.error || "Upload failed";
      if (sessionHandle) {
        await discardUploadSessionHandle(sessionHandle);
        sessionHandle = undefined;
      }
      if (gologinAccount) {
        if (isSessionExpiredError(errorMsg)) {
          // Mark as logged_out so the UI knows this account needs re-login.
          // We don't mark as "expired" (that's for session age). "logged_out"
          // means TikTok actively rejected the session during upload.
          await updateGoLoginAccountStatus(accountId, { status: "logged_out" });
          console.warn("[MongoRunner] account marked as logged_out", { accountId, errorMsg });
        }
      } else {
        await markAccountExpiredIfSessionError(accountId, errorMsg);
      }

      const maxAttempts = Math.max(1, Number(process.env.UPLOAD_MAX_ATTEMPTS || 2));
      const isBrowserClosed = /BROWSER_CLOSED|page.*closed|context.*closed|browser.*closed/i.test(errorMsg);
      const effectiveMax = isBrowserClosed ? Math.max(maxAttempts, 2) : maxAttempts;
      const shouldRetry = !isSessionExpiredError(errorMsg) && attemptNumber < effectiveMax;

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
        await afterCampaignJobPermanentFail({
          campaignId: (upload as any).campaignId,
          accountId,
          campaignStep: campaignStep ?? 0,
          error: errorMsg,
        });
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
      await afterCampaignJobPermanentFail({
        campaignId: (upload as any)?.campaignId,
        accountId: String(upload?.accountId),
        campaignStep: (upload as any)?.campaignStep ?? 0,
        error: msg,
      }).catch(() => {});
      await cleanupBatchIfLast(uploadId);
      upload = null;
    }
  }
}

async function runnerLoop(signal: AbortSignal) {
  const batchSize = getUploadParallelAdminCap();
  const pollIntervalMs = Number(process.env.UPLOAD_POLL_INTERVAL_MS || 1400);
  const batchGapMs = Number(process.env.UPLOAD_BATCH_GAP_MS || 0);

  console.log("[MongoRunner] started", {
    serverParallelCap: batchSize,
    UPLOAD_PARALLEL_BATCH_SIZE: process.env.UPLOAD_PARALLEL_BATCH_SIZE ?? "(unset → 32)",
    pollIntervalMs,
    batchGapMs,
    hint: "Campaign 'Parallel accounts' cannot exceed serverParallelCap — set UPLOAD_PARALLEL_BATCH_SIZE in .env (e.g. 4) to allow N concurrent accounts per wave.",
  });

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
    /** Max simultaneous Chromium instances — defaults to wave size; set UPLOAD_MAX_BROWSERS in .env to cap. */
    const maxBrowsers = Math.max(1, Number(process.env.UPLOAD_MAX_BROWSERS || claimed.length));
    const oneBrowserPerJob = claimed.length > 1;

    let waveBrowser: Browser | undefined;
    if (!oneBrowserPerJob) {
      waveBrowser = await launchChromium("automation");
    }

    console.log("[MongoRunner] wave claimed", {
      concurrentJobsThisWave: claimed.length,
      serverParallelCap: batchSize,
      batchParallelismField: jobParallelism,
      maxBrowsersConcurrent: oneBrowserPerJob ? maxBrowsers : 1,
      uploadId: claimed[0]?.uploadId,
      accountIds: claimed.map((c: any) => String(c.accountId)),
      browserMode: oneBrowserPerJob
        ? `isolated: each job launches its own Chromium (max ${maxBrowsers} concurrent)`
        : "shared: one browser for this wave (closes after wave)",
      fewerClaimsThanParallelism:
        claimed.length < jobParallelism
          ? "Some jobs not ready yet (notBefore in future), server cap, or no pending rows — if you use stagger>0 with parallelism=1 only, that is expected; with parallelism>1, intra-wave stagger is ignored."
          : undefined,
    });

    const browserForJobs = waveBrowser || undefined;

    if (oneBrowserPerJob && claimed.length > maxBrowsers) {
      // Run in batches of maxBrowsers to avoid launching too many Chromium instances
      for (let i = 0; i < claimed.length; i += maxBrowsers) {
        const batch = claimed.slice(i, i + maxBrowsers);
        const running = batch.map((job: any) =>
          processUpload(job, undefined).finally(() => {
            busyAccountIds.delete(String(job.accountId));
          })
        );
        await Promise.allSettled(running);
        clearAllUploadContexts();
      }
    } else {
      const running = claimed.map((job: any) =>
        processUpload(job, browserForJobs).finally(() => {
          busyAccountIds.delete(String(job.accountId));
        })
      );
      await Promise.allSettled(running);
    }

    // Close the wave browser and flush stale pooled contexts
    clearAllUploadContexts();
    if (waveBrowser) {
      await waveBrowser.close().catch(() => {});
      console.log("[MongoRunner] wave browser closed");
    }

    if (signal.aborted) break;
    if (batchGapMs > 0) await sleep(batchGapMs);
    await sleep(pollIntervalMs);
  }

  console.log("[MongoRunner] stopped");
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
    } finally {
      ac.abort();
      console.log("[MongoRunner] runner loop ended — next ensureStart will restart");
    }
  }, 0);
}

