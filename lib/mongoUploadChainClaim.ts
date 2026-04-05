/* eslint-disable @typescript-eslint/no-explicit-any */
import mongoose from "mongoose";
import { UploadModel } from "@/lib/models/Upload";

/**
 * Claim the next pending upload job for this account (any batch), after the current job succeeded.
 * Used to post multiple videos on the same Playwright page without a full Studio cold load each time.
 */
export async function claimNextPendingUploadForAccount(accountId: string): Promise<any | null> {
  const now = new Date();
  const pendingWindow = {
    $or: [
      { notBefore: null },
      { notBefore: { $exists: false } },
      { notBefore: { $lte: now } },
    ],
  };

  return UploadModel.findOneAndUpdate(
    {
      accountId: new mongoose.Types.ObjectId(accountId),
      status: "pending" as const,
      uploadId: { $exists: true, $nin: [null, ""] },
      $and: [
        { $or: [{ nextRetryAt: null }, { nextRetryAt: { $lte: now } }] },
        pendingWindow,
      ],
    },
    { $set: { status: "uploading", error: undefined, nextRetryAt: null } },
    { sort: { timestamp: 1 }, returnDocument: "after" }
  ).lean();
}
