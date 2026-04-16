/* eslint-disable @typescript-eslint/no-explicit-any */
import mongoose from "mongoose";
import { UploadModel } from "@/lib/models/Upload";

/** Server identity for multi-server job claiming. Falls back to hostname + PID. */
const SERVER_ID = process.env.SERVER_ID || `${require("os").hostname()}-${process.pid}`;

export type ClaimUploadBatchOptions = {
  /** Skip jobs for these account ObjectIds (e.g. account mid upload chain on same page). */
  excludeAccountIds?: string[];
};

/**
 * Atomically claim up to `limit` pending jobs from the same upload batch (`uploadId`)
 * when possible, so large multi-account posts run in parallel waves (e.g. 4+4+4).
 *
 * Respects `notBefore` on each row: staggered / scheduled batches only claim jobs whose window has started.
 */
export async function claimUploadBatch(limit: number, opts?: ClaimUploadBatchOptions): Promise<any[]> {
  const now = new Date();
  const pendingWindow = {
    $or: [
      { notBefore: null },
      { notBefore: { $exists: false } },
      { notBefore: { $lte: now } },
    ],
  };
  const baseMatch = {
    status: "pending" as const,
    $and: [
      { $or: [{ nextRetryAt: null }, { nextRetryAt: { $lte: now } }] },
      pendingWindow,
    ],
    uploadId: { $exists: true, $nin: [null, ""] },
  };

  // Prefer the newest batch (by max row timestamp), not an arbitrary row with the same ms.
  const [newestBatch] = await UploadModel.aggregate([
    { $match: baseMatch },
    {
      $group: {
        _id: "$uploadId",
        maxTs: { $max: "$timestamp" },
        parallelism: { $max: "$parallelism" },
      },
    },
    { $sort: { maxTs: -1, _id: -1 } },
    { $limit: 1 },
  ]);

  if (!newestBatch?._id) return [];

  const targetUploadId = newestBatch._id;
  const desired = Number(newestBatch.parallelism);
  const useDesired = Number.isFinite(desired) && desired > 0;
  const effectiveLimit = Math.max(1, Math.min(limit, useDesired ? Math.floor(desired) : limit));

  const clampedByServer = useDesired && limit < Math.floor(desired);
  console.log("[UploadClaim] wave", {
    uploadId: targetUploadId,
    serverParallelCap: limit,
    batchParallelismField: useDesired ? Math.floor(desired) : "(unset)",
    effectiveJobsThisWave: effectiveLimit,
    ...(clampedByServer
      ? {
          warning:
            "Parallelism is LIMITED by UPLOAD_PARALLEL_BATCH_SIZE — increase or unset this env to match your campaign (e.g. 2 browsers needs UPLOAD_PARALLEL_BATCH_SIZE>=2).",
        }
      : {}),
  });

  const exclude = (opts?.excludeAccountIds ?? []).filter(Boolean);
  const queryBase: Record<string, unknown> = {
    ...baseMatch,
    uploadId: targetUploadId,
  };
  if (exclude.length > 0) {
    queryBase.accountId = {
      $nin: exclude.map((id) => new mongoose.Types.ObjectId(id)),
    };
  }

  const claimed: any[] = [];
  for (let i = 0; i < effectiveLimit; i++) {
    const job = await UploadModel.findOneAndUpdate(
      queryBase as any,
      {
        $set: {
          status: "uploading",
          error: undefined,
          nextRetryAt: null,
          claimedBy: SERVER_ID,
          claimedAt: new Date(),
        },
      },
      { sort: { notBefore: 1 as const, timestamp: 1 }, returnDocument: "after" }
    ).lean();

    if (!job) break;
    claimed.push(job);
  }

  return claimed;
}
