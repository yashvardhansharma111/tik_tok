import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { AccountModel } from "@/lib/models/Account";
import { getCurrentUser } from "@/lib/currentUser";

/**
 * POST /api/accounts/reset-status
 * Body: { accountIds?: string[] }
 *   - accountIds provided → reset only those accounts
 *   - accountIds omitted or empty → reset ALL expired accounts (admin only)
 * Resets status from "expired" → "active".
 */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const isAdmin = (user as { role?: string }).role === "admin";
  const body = await request.json().catch(() => ({}));
  const accountIds: string[] = Array.isArray(body.accountIds) ? body.accountIds : [];

  await connectDB();

  let filter: Record<string, unknown>;

  if (accountIds.length > 0) {
    filter = { _id: { $in: accountIds }, status: "expired" };
  } else {
    // Bulk reset — admin only
    if (!isAdmin) {
      return NextResponse.json({ error: "Admin required for bulk reset" }, { status: 403 });
    }
    filter = { status: "expired" };
  }

  const result = await AccountModel.updateMany(filter, { $set: { status: "active" } });

  return NextResponse.json({ ok: true, updated: result.modifiedCount });
}
