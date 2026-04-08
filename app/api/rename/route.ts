import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectDB } from "@/lib/db";
import { getCurrentUser } from "@/lib/currentUser";
import { createBulkRenameJob } from "@/lib/bulkRenameRunner";
import { RenameJobModel } from "@/lib/models/RenameJob";

export const maxDuration = 60;
export const runtime = "nodejs";

/** Recent rename jobs for this user (full item rows: before → after). */
export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limit = Math.min(40, Math.max(1, Number(request.nextUrl.searchParams.get("limit") || 20)));
  await connectDB();
  const ownerId = (user as { _id: mongoose.Types.ObjectId })._id;

  const rows = await RenameJobModel.find({ ownerId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();

  const jobs = rows.map((job) => {
    const j = job as {
      _id: unknown;
      status: string;
      prompt: string;
      total?: number;
      completed?: number;
      error?: string;
      createdAt?: Date;
      updatedAt?: Date;
      items?: Array<{
        accountId: unknown;
        username: string;
        proposedName?: string;
        appliedUsername?: string;
        status: string;
        error?: string;
      }>;
    };
    return {
      id: String(j._id),
      status: j.status,
      prompt: j.prompt,
      total: j.total ?? j.items?.length ?? 0,
      completed: j.completed ?? 0,
      error: j.error,
      createdAt: j.createdAt?.toISOString() ?? null,
      updatedAt: j.updatedAt?.toISOString() ?? null,
      items: (j.items || []).map((it) => ({
        accountId: String(it.accountId),
        username: it.username,
        proposedName: it.proposedName || "",
        appliedUsername: it.appliedUsername || "",
        status: it.status,
        error: it.error,
      })),
    };
  });

  if (jobs.length === 0) {
    console.info("[api/rename GET] rename history: no data", {
      ownerId: String(ownerId),
      limit,
      jobsReturned: 0,
      hint: "No RenameJob documents for this user yet — UI shows “No rename jobs yet”. Run a bulk rename to create records.",
    });
  } else {
    console.info("[api/rename GET] rename history: full payload", {
      ownerId: String(ownerId),
      limit,
      jobsReturned: jobs.length,
      jobs: jobs.map((j) => ({
        id: j.id,
        status: j.status,
        createdAt: j.createdAt,
        updatedAt: j.updatedAt,
        completed: j.completed,
        total: j.total,
        jobError: j.error,
        prompt: j.prompt,
        items: j.items.map((it) => ({
          accountId: it.accountId,
          usernameBefore: it.username,
          proposedName: it.proposedName,
          appliedUsername: it.appliedUsername,
          itemStatus: it.status,
          itemError: it.error,
        })),
      })),
    });
  }

  return NextResponse.json({ jobs });
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  const accountIds = Array.isArray(body.accountIds) ? body.accountIds.map(String) : [];

  if (!prompt) return NextResponse.json({ error: "prompt is required" }, { status: 400 });
  if (accountIds.length === 0) return NextResponse.json({ error: "Select at least one account" }, { status: 400 });

  try {
    await connectDB();
    const ownerId = (user as { _id: mongoose.Types.ObjectId })._id;
    const isAdmin = (user as { role?: string }).role === "admin";
    const job = await createBulkRenameJob(ownerId, prompt, accountIds, { skipAccessCheck: isAdmin });
    return NextResponse.json({
      ok: true,
      jobId: String(job._id),
      total: (job as { total?: number }).total ?? accountIds.length,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Rename job failed";
    const status = msg.includes("not found") || msg.includes("not owned") ? 403 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
