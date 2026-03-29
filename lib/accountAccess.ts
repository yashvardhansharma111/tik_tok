import type { Types } from "mongoose";

type UserLike = { _id: unknown; role?: string } | null;

/**
 * Accounts and uploads are scoped to the app user who created them (`ownerId`).
 * Admins still only see their own linked accounts/uploads unless you extend this.
 */
export function accountFilterForUser(user: UserLike): Record<string, unknown> {
  if (!user?._id) return { _id: null };
  return { ownerId: user._id };
}

/**
 * Upload rows: prefer `ownerId`; include legacy rows without `ownerId` only when
 * the upload targets an account owned by this user.
 */
export function uploadFilterForUser(
  user: UserLike,
  myAccountIds: Types.ObjectId[]
): Record<string, unknown> {
  if (!user?._id) return { _id: null };
  const ownerId = user._id as Types.ObjectId;
  if (!myAccountIds.length) return { ownerId };
  return {
    $or: [
      { ownerId },
      {
        accountId: { $in: myAccountIds },
        $or: [{ ownerId: { $exists: false } }, { ownerId: null }],
      },
    ],
  };
}
