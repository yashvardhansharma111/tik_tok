import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { getCurrentUser } from "@/lib/currentUser";
import { UploadModel } from "@/lib/models/Upload";

export async function GET(_request: Request, { params }: { params: Promise<{ uploadId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { uploadId } = await params;
  if (!uploadId) return NextResponse.json({ error: "Missing uploadId" }, { status: 400 });

  await connectDB();
  const ownerId = (user as { _id: unknown })._id;
  const rows = await UploadModel.find({ uploadId, ownerId }).lean();
  if (rows.length === 0) {
    return NextResponse.json({ error: "Batch not found" }, { status: 404 });
  }

  let pending = 0;
  let uploading = 0;
  let success = 0;
  let failed = 0;
  for (const r of rows) {
    const s = (r as { status?: string }).status;
    if (s === "pending") pending += 1;
    else if (s === "uploading") uploading += 1;
    else if (s === "success") success += 1;
    else if (s === "failed") failed += 1;
  }

  const total = rows.length;
  const done = success + failed;
  const accountsRemaining = pending + uploading;
  const batchSize = Math.max(1, Math.min(32, Number(process.env.UPLOAD_PARALLEL_BATCH_SIZE || 4)));
  const avgSec = Math.max(30, Number(process.env.UPLOAD_AVG_SECONDS_PER_ACCOUNT || 90));
  const waves = accountsRemaining > 0 ? Math.ceil(accountsRemaining / batchSize) : 0;
  const estimatedSecondsRemaining = accountsRemaining > 0 ? waves * avgSec : 0;

  const complete = accountsRemaining === 0;

  return NextResponse.json({
    uploadId,
    total,
    done,
    pending,
    uploading,
    success,
    failed,
    accountsRemaining,
    estimatedSecondsRemaining,
    complete,
  });
}
