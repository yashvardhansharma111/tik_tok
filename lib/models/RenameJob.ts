import { Schema, model, models } from "mongoose";

/**
 * One row per account in a bulk-rename job.
 * - `username` = **immutable snapshot** of `Account.username` when the job was created (the “before” handle). Runner updates never change this field.
 * - `proposedName` / `appliedUsername` = AI / TikTok target and final applied handle (“after”) when successful.
 * - `Account.username` in MongoDB is updated to match `appliedUsername` only after TikTok + Playwright verify success.
 */
const ItemSchema = new Schema(
  {
    accountId: { type: Schema.Types.ObjectId, ref: "Account", required: true },
    username: { type: String, required: true },
    proposedName: { type: String, default: "" },
    /** Final @handle saved on TikTok + in our DB when status is done */
    appliedUsername: { type: String, required: false },
    status: { type: String, enum: ["pending", "running", "done", "failed"], default: "pending" },
    error: { type: String, required: false },
  },
  { _id: false }
);

const RenameJobSchema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    prompt: { type: String, required: true },
    status: {
      type: String,
      enum: ["queued", "running", "done", "failed", "partial"],
      default: "queued",
      index: true,
    },
    total: { type: Number, default: 0 },
    completed: { type: Number, default: 0 },
    items: { type: [ItemSchema], default: [] },
    error: { type: String, required: false },
  },
  { timestamps: true }
);

RenameJobSchema.index({ ownerId: 1, createdAt: -1 });

export const RenameJobModel = models.RenameJob || model("RenameJob", RenameJobSchema);
