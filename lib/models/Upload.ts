import { Schema, model, models } from "mongoose";

const UploadSchema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: "User", required: false, index: true },
    uploadId: { type: String, required: false, index: true },
    /** Desired parallelism for this batch (how many accounts to process in a wave). */
    parallelism: { type: Number, required: false, index: true },
    accountId: { type: Schema.Types.ObjectId, ref: "Account", required: true, index: true },
    videoFileName: { type: String, required: true },
    caption: { type: String, required: true },
    musicQuery: { type: String, required: false },
    soundUsed: { type: String, required: false },
    attempts: { type: Number, default: 0, index: true },
    nextRetryAt: { type: Date, default: null, index: true },
    status: { type: String, enum: ["pending", "uploading", "success", "failed"], default: "pending" },
    error: { type: String, required: false },
    timestamp: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true }
);

export const UploadModel = models.Upload || model("Upload", UploadSchema);
