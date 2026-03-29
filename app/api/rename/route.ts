import { NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectDB } from "@/lib/db";
import { getCurrentUser } from "@/lib/currentUser";
import { createBulkRenameJob } from "@/lib/bulkRenameRunner";

export const maxDuration = 60;
export const runtime = "nodejs";

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
    const job = await createBulkRenameJob(ownerId, prompt, accountIds);
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
