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
  };

  const first = await UploadModel.findOne(baseMatch).sort({ timestamp: 1 }).lean();
  if (!first) return [];

  const targetUploadId = first.uploadId;
  const claimed: any[] = [];

  for (let i = 0; i < limit; i++) {
    const query: Record<string, unknown> = { ...baseMatch };
    if (targetUploadId != null && String(targetUploadId).length > 0) {
      query.uploadId = targetUploadId;
    }

    const job = await UploadModel.findOneAndUpdate(
      query,
      {
        $set: { status: "uploading", error: undefined, nextRetryAt: null },
      },
      { sort: { timestamp: 1 }, returnDocument: "after" }
    ).lean();

    if (!job) break;
    claimed.push(job);
  }

  return claimed;
}
