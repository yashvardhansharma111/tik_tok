/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { requireAdmin } from "@/lib/currentUser";
import { RenameJobModel } from "@/lib/models/RenameJob";
import { UserModel } from "@/lib/models/User";

/**
 * Admin-only: every rename across all users.
 * Returns a flat list of successful renames (old → new) plus a summary of failures,
 * sorted most-recent-first.
 */
export async function GET(request: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limit = Math.min(200, Math.max(1, Number(request.nextUrl.searchParams.get("limit") || 100)));
  await connectDB();

  const jobs = await RenameJobModel.find({})
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();

  const ownerIdSet = new Set<string>();
  for (const j of jobs) {
    if ((j as any).ownerId) ownerIdSet.add(String((j as any).ownerId));
  }

  const users =
    ownerIdSet.size > 0
      ? await UserModel.find({ _id: { $in: [...ownerIdSet] } }, { email: 1 }).lean()
      : [];
  const emailById = new Map(users.map((u) => [String((u as any)._id), (u as any).email as string]));

  const result = jobs.map((job) => {
    const j = job as any;
    const items = (j.items || []) as Array<{
      accountId: unknown;
      username: string;
      proposedName?: string;
      appliedUsername?: string;
      status: string;
      error?: string;
    }>;

    return {
      id: String(j._id),
      ownerId: j.ownerId ? String(j.ownerId) : null,
      ownerEmail: j.ownerId ? emailById.get(String(j.ownerId)) ?? "(unknown)" : "(none)",
      status: j.status,
      prompt: j.prompt,
      total: j.total ?? items.length,
      completed: j.completed ?? 0,
      error: j.error,
      createdAt: j.createdAt?.toISOString() ?? null,
      updatedAt: j.updatedAt?.toISOString() ?? null,
      items: items.map((it) => ({
        accountId: String(it.accountId),
        username: it.username,
        proposedName: it.proposedName || "",
        appliedUsername: it.appliedUsername || "",
        status: it.status,
        error: it.error,
      })),
    };
  });

  return NextResponse.json({ jobs: result });
}
