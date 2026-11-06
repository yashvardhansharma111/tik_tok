/**
 * Keep the stored TikTok handle in step with reality.
 *
 * The Mongo `_id` is an account's stable identity; the TikTok @handle is just a
 * mutable attribute of it. When someone renames an account by hand in the TikTok
 * app, the stored `username` goes stale and the automation starts tripping over
 * it (capture aborts with "Username mismatch", history rows show the old name).
 *
 * Rather than fail, detect the drift and write the new handle back, keeping the
 * old one in `previousUsername` — the same field the bulk-rename flow uses.
 */
import mongoose from "mongoose";
import { AccountModel } from "@/lib/models/Account";

export type ReconcileOutcome =
  | { changed: false; reason: "same" | "no-live-username" | "account-missing" }
  | { changed: false; reason: "conflict"; conflictAccountId: string; from: string; to: string }
  | { changed: true; from: string; to: string };

/** Strip a leading @ and surrounding space; TikTok handles are case-insensitive. */
export function normalizeHandle(name: string | null | undefined): string {
  return (name || "").trim().replace(/^@+/, "");
}

export function handlesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  return normalizeHandle(a).toLowerCase() === normalizeHandle(b).toLowerCase();
}

/**
 * Point `accountId` at `liveUsername`, if that is genuinely a new handle.
 *
 * Refuses to steal a handle that another account row already owns — `username`
 * carries a unique index, so that would either throw or silently corrupt which
 * row maps to which TikTok account. Such a case is reported as a conflict for a
 * human to resolve.
 */
export async function reconcileAccountUsername(
  accountId: string,
  liveUsername: string | null | undefined,
  opts: { adspowerCollection?: string } = {}
): Promise<ReconcileOutcome> {
  const live = normalizeHandle(liveUsername);
  if (!live) return { changed: false, reason: "no-live-username" };

  const account = await AccountModel.findById(accountId).lean();
  if (!account) return { changed: false, reason: "account-missing" };

  const stored = normalizeHandle((account as { username?: string }).username);
  if (handlesMatch(stored, live)) return { changed: false, reason: "same" };

  // Someone else already holds this handle -> do not touch either row.
  const clash = await AccountModel.findOne({
    username: live,
    _id: { $ne: new mongoose.Types.ObjectId(accountId) },
  })
    .select({ _id: 1 })
    .lean();
  if (clash) {
    return {
      changed: false,
      reason: "conflict",
      conflictAccountId: String((clash as { _id: unknown })._id),
      from: stored,
      to: live,
    };
  }

  await AccountModel.updateOne(
    { _id: new mongoose.Types.ObjectId(accountId) },
    { $set: { username: live, ...(stored ? { previousUsername: stored } : {}) } }
  );

  // adspower_accounts carries its own copy used by the upload runner.
  const col = opts.adspowerCollection || process.env.ADSPOWER_ACCOUNTS_COLLECTION || "adspower_accounts";
  await mongoose.connection
    .collection(col)
    .updateOne({ accountId: String(accountId) }, { $set: { username: live, updatedAt: new Date() } })
    .catch(() => {});

  console.log("[reconcile] TikTok handle changed outside the app", {
    accountId,
    from: stored,
    to: live,
  });

  return { changed: true, from: stored, to: live };
}
