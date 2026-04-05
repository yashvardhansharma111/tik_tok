import { Schema, model, models } from "mongoose";

const UploadSchema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: "User", required: false, index: true },
    uploadId: { type: String, required: false, index: true },
    /** Desired parallelism for this batch (how many accounts to process in a wave). */
    parallelism: { type: Number, required: false, index: true },
    accountId: { type: Schema.Types.ObjectId, ref: "Account", required: true, index: true },
    videoFileName: { type: String, required: true },
    /** Relative path inside `storage/tmp-uploads/{uploadId}/` (default `video.mp4`). */
    videoRelPath: { type: String, required: false },
    /** Set to the batch `uploadId` when this row belongs to a multi-video campaign. */
    campaignId: { type: String, required: false, index: true },
    /** Index along this account’s `perAccountVideoOrder` (0 = first video in sequence). */
    campaignStep: { type: Number, required: false },
    caption: { type: String, required: true },
    musicQuery: { type: String, required: false },
    soundUsed: { type: String, required: false },
    attempts: { type: Number, default: 0, index: true },
    nextRetryAt: { type: Date, default: null, index: true },
    status: { type: String, enum: ["pending", "uploading", "success", "failed"], default: "pending" },
    error: { type: String, required: false },
    timestamp: { type: Date, default: Date.now, index: true },
    /** Job not claimable until this time (stagger within batch + optional scheduled start). */
    notBefore: { type: Date, default: null, index: true },
  },
  { timestamps: true }
);

export const UploadModel = models.Upload || model("Upload", UploadSchema);
