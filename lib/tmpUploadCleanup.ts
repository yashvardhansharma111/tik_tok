import fs from "fs/promises";
import path from "path";
import { CampaignModel } from "@/lib/models/Campaign";
import { UploadModel } from "@/lib/models/Upload";

/** uploadId values used in this app (campaign-*, uuid-ish, etc.) */
const SAFE_UPLOAD_ID = /^[a-zA-Z0-9._-]{6,240}$/;

/** While a campaign is active, keep batch files — next waves/cycles reuse the same folder. */
export async function campaignBlocksBatchCleanup(uploadId: string): Promise<boolean> {
  const c = await CampaignModel.findOne({ uploadId }).lean();
  if (c && c.status === "active") return true;
  return false;
}

/**
 * Best-effort delete `storage/tmp-uploads/{uploadId}/` when safe:
 * - no active campaign for that id, and
 * - no pending/uploading Upload rows for that batch.
 */
export async function tryCleanupUploadBatch(uploadId: string): Promise<void> {
  try {
    if (await campaignBlocksBatchCleanup(uploadId)) return;

    const remaining = await UploadModel.countDocuments({
      uploadId,
      status: { $in: ["pending", "uploading"] },
    });
    if (remaining > 0) return;

    await removeTmpUploadBatchDir(uploadId);
  } catch {
    // best-effort
  }
}

/**
 * Deletes one batch directory under `storage/tmp-uploads/`. Idempotent.
 * Returns true if the directory was removed or already absent.
 */
export async function removeTmpUploadBatchDir(uploadId: string): Promise<boolean> {
  const id = String(uploadId || "").trim();
  if (!SAFE_UPLOAD_ID.test(id)) {
    console.warn("[TmpUploadCleanup] skip: invalid uploadId");
    return false;
  }

  const root = path.resolve(process.cwd(), "storage", "tmp-uploads");
  const batchDir = path.resolve(root, id);
  const rel = path.relative(root, batchDir);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return false;

  try {
    await fs.rm(batchDir, { recursive: true, force: true });
    console.log("[TmpUploadCleanup] removed batch dir", { uploadId: id });
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/ENOENT|no such file/i.test(msg)) return true;
    console.warn("[TmpUploadCleanup] rm failed", { uploadId: id, error: msg });
    return false;
  }
}
