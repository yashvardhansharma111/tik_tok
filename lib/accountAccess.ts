import mongoose from "mongoose";

type AccountLike = {
  ownerId?: unknown;
  ownerIds?: unknown;
  _id?: unknown;
};

/** Mongo filter: accounts this app user may use (legacy `ownerId` or `ownerIds` array). */
export function accountAccessibleByUser(userId: mongoose.Types.ObjectId) {
  return {
    $or: [{ ownerId: userId }, { ownerIds: userId }],
  };
}

/** Whether `userId` may use this account document. */
export function userHasAccountAccess(account: AccountLike, userId: mongoose.Types.ObjectId): boolean {
  const uid = String(userId);
  if (account.ownerId != null && String(account.ownerId) === uid) return true;
  const raw = account.ownerIds;
  if (Array.isArray(raw)) {
    return raw.some((id) => String(id) === uid);
  }
  return false;
}

/** Distinct owner ids for an account (legacy + array, deduped). */
export function effectiveOwnerIds(account: AccountLike): string[] {
  const out = new Set<string>();
  if (account.ownerId != null) out.add(String(account.ownerId));
  const raw = account.ownerIds;
  if (Array.isArray(raw)) {
    for (const id of raw) {
      if (id != null) out.add(String(id));
    }
  }
  return [...out];
}

/** How many accounts this user can access (for max-linked checks). */
export async function countAccountsForUser(
  AccountModel: {
    countDocuments: (q: Record<string, unknown>) => Promise<number>;
  },
  userId: mongoose.Types.ObjectId,
  excludeAccountId?: mongoose.Types.ObjectId
): Promise<number> {
  const base = accountAccessibleByUser(userId);
  if (!excludeAccountId) {
    return AccountModel.countDocuments(base);
  }
  return AccountModel.countDocuments({
    $and: [base, { _id: { $ne: excludeAccountId } }],
  });
}
