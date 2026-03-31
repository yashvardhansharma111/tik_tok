/**
 * One global lock per TikTok account so two jobs never automate the same account at once.
 *
 * Why "busy" happens:
 * - Another upload/rename is actually running (same or different server — lock is in MongoDB).
 * - Previous run crashed or killed before unlock; lock clears after ACCOUNT_LOCK_TTL_MS without a heartbeat.
 * - Long runs: we refresh isUploadingAt on a heartbeat so active work is not mistaken for a dead lock.
 */
import mongoose from "mongoose";
import { AccountModel } from "@/lib/models/Account";

/** Max age of isUploadingAt before another worker may take the lock (crashed worker). */
export function getAccountLockTtlMs(): number {
  const n = Number(process.env.ACCOUNT_LOCK_TTL_MS);
  if (Number.isFinite(n) && n >= 120000) return n;
  return 45 * 60 * 1000; // 45 min — uploads + sound flow can exceed 10 min
}

/** How often to bump isUploadingAt while work is in progress (must be < TTL). */
export function getAccountLockHeartbeatMs(): number {
  const n = Number(process.env.ACCOUNT_LOCK_HEARTBEAT_MS);
  if (Number.isFinite(n) && n >= 20000) return n;
  return 2 * 60 * 1000; // 2 min
}

export async function lockAccount(accountId: string) {
  const lockTtlMs = getAccountLockTtlMs();
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

export async function unlockAccount(accountId: string) {
  await AccountModel.updateOne(
    { _id: new mongoose.Types.ObjectId(accountId) },
    { $set: { isUploading: false, isUploadingAt: null } }
  ).catch(() => {});
}

export function startAccountLockHeartbeat(accountId: string): ReturnType<typeof setInterval> {
  const ms = getAccountLockHeartbeatMs();
  return setInterval(() => {
    void AccountModel.updateOne(
      { _id: new mongoose.Types.ObjectId(accountId), isUploading: true },
      { $set: { isUploadingAt: new Date() } }
    ).catch(() => {});
  }, ms);
}
