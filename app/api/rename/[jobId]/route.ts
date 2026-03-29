import { NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectDB } from "@/lib/db";
import { getCurrentUser } from "@/lib/currentUser";
import { RenameJobModel } from "@/lib/models/RenameJob";

export async function GET(_request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { jobId } = await params;
  if (!jobId || !mongoose.Types.ObjectId.isValid(jobId)) {
    return NextResponse.json({ error: "Invalid job id" }, { status: 400 });
  }

  await connectDB();
  const ownerId = (user as { _id: unknown })._id;
  const job = await RenameJobModel.findOne({ _id: jobId, ownerId }).lean();
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  const j = job as {
    status: string;
    prompt: string;
    total: number;
    completed: number;
    error?: string;
    items?: Array<{
      accountId: unknown;
      username: string;
      proposedName?: string;
      appliedUsername?: string;
      status: string;
      error?: string;
    }>;
  };

  const total = j.total || j.items?.length || 0;
  const completed = j.completed || 0;
  const remaining = Math.max(0, total - completed);
  const avgSec = Math.max(20, Number(process.env.RENAME_AVG_SECONDS_PER_ACCOUNT || 45));
  const estimatedSecondsRemaining = j.status === "running" || j.status === "queued" ? remaining * avgSec : 0;

  return NextResponse.json({
    jobId,
    status: j.status,
    prompt: j.prompt,
    total,
    completed,
    accountsRemaining: remaining,
    estimatedSecondsRemaining,
    error: j.error,
    items: (j.items || []).map((it) => ({
      accountId: String(it.accountId),
      username: it.username,
      proposedName: it.proposedName || "",
      appliedUsername: it.appliedUsername || "",
      status: it.status,
      error: it.error,
    })),
    complete: j.status === "done" || j.status === "failed",
  });
}
