import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { getCurrentUser } from "@/lib/currentUser";
import { UploadModel } from "@/lib/models/Upload";
import { AccountModel } from "@/lib/models/Account";
import { getUploadParallelAdminCap } from "@/lib/uploadParallelConfig";
import { friendlyUploadError } from "@/lib/uploadErrorMessages";

/** If a row stays "uploading" longer than this, UI shows a stuck warning (worker crash / lost file). */
function staleUploadMs(): number {
  const n = Number(process.env.UPLOAD_STUCK_AFTER_MS);
  if (Number.isFinite(n) && n >= 120000) return n;
  return 18 * 60 * 1000; // 18 minutes
}

export async function GET(_request: Request, { params }: { params: Promise<{ uploadId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { uploadId } = await params;
  if (!uploadId) return NextResponse.json({ error: "Missing uploadId" }, { status: 400 });

  await connectDB();
  const rows = await UploadModel.find({ uploadId }).lean();
  if (rows.length === 0) {
    return NextResponse.json({ error: "Batch not found" }, { status: 404 });
  }

  const accountIds = [...new Set(rows.map((r: any) => String(r.accountId)))];
  const accounts =
    accountIds.length > 0
      ? await AccountModel.find({ _id: { $in: accountIds } }, { _id: 1, username: 1 }).lean()
      : [];
  const userById = new Map(accounts.map((a: any) => [String(a._id), String(a.username || "unknown")]));

  let pending = 0;
  let uploading = 0;
  let success = 0;
  let failed = 0;
  const now = Date.now();
  const staleMs = staleUploadMs();
  const staleUploading: { accountUsername: string; minutesStuckApprox: number }[] = [];

  for (const r of rows) {
    const s = (r as { status?: string }).status;
    if (s === "pending") pending += 1;
    else if (s === "uploading") {
      uploading += 1;
      const updated = (r as { updatedAt?: Date; timestamp?: Date }).updatedAt || (r as { timestamp?: Date }).timestamp;
      const t = updated ? new Date(updated).getTime() : now;
      if (now - t > staleMs) {
        const aid = String((r as any).accountId);
        staleUploading.push({
          accountUsername: userById.get(aid) || "unknown",
          minutesStuckApprox: Math.floor((now - t) / 60000),
        });
      }
    } else if (s === "success") success += 1;
    else if (s === "failed") failed += 1;
  }

  const failedDetails = rows
    .filter((r: any) => r.status === "failed")
    .map((r: any) => {
      const aid = String(r.accountId);
      const raw = r.error != null ? String(r.error) : "";
      return {
        accountUsername: userById.get(aid) || "unknown",
        friendlyMessage: friendlyUploadError(raw),
        rawError: raw || undefined,
      };
    });

  const total = rows.length;
  const done = success + failed;
  const accountsRemaining = pending + uploading;
  const configuredMax = getUploadParallelAdminCap();
  const desired = Number((rows[0] as any)?.parallelism);
  const batchSize = Math.max(1, Math.min(configuredMax, Number.isFinite(desired) ? Math.floor(desired) : configuredMax));
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
    parallelism: batchSize,
    estimatedSecondsRemaining,
    complete,
    failedDetails,
    staleUploading,
    hasParallelismNote:
      "Each app server uses its own “parallel browsers” setting; another machine’s setting does not change this one.",
  });
}
