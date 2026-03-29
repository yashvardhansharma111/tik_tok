type UserLike = { _id: unknown; role?: string } | null;

/**
 * Shared pool: every logged-in user sees and can use all TikTok accounts (no per-user isolation).
 * Use `{ _id: null }` only when there is no user (should not query accounts).
 */
export function accountFilterForUser(user: UserLike): Record<string, unknown> {
  if (!user?._id) return { _id: null };
  return {};
}

/** Upload history: show all uploads for everyone (shared dashboard). */
export function uploadFilterForUser(_user: UserLike): Record<string, unknown> {
  if (!_user?._id) return { _id: null };
  return {};
}
