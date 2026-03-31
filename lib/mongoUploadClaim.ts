/* eslint-disable @typescript-eslint/no-explicit-any */
import { UploadModel } from "@/lib/models/Upload";

/**
 * Atomically claim up to `limit` pending jobs from the same upload batch (`uploadId`)
 * when possible, so large multi-account posts run in parallel waves (e.g. 4+4+4).
 */
export async function claimUploadBatch(limit: number): Promise<any[]> {
  const now = new Date();
  const baseMatch = {
    status: "pending" as const,
    $or: [{ nextRetryAt: null }, { nextRetryAt: { $lte: now } }],
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

  const queryBase = {
    ...baseMatch,
    uploadId: targetUploadId,
  };

  const claimed: any[] = [];
  for (let i = 0; i < effectiveLimit; i++) {
    const job = await UploadModel.findOneAndUpdate(
      queryBase,
      {
        $set: { status: "uploading", error: undefined, nextRetryAt: null },
      },
      { sort: { timestamp: -1 }, returnDocument: "after" }
    ).lean();

    if (!job) break;
    claimed.push(job);
  }

  return claimed;
}
