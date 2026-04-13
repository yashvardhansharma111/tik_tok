import { Schema, model, models } from "mongoose";

const AccountSchema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: "User", required: false, index: true },
    /** App users who may use this TikTok login (multi-tenant / testing). Kept in sync with legacy `ownerId` when possible. */
    ownerIds: [{ type: Schema.Types.ObjectId, ref: "User", index: true }],
    username: { type: String, required: true, unique: true, index: true },
    previousUsername: { type: String, required: false, default: "" },
    session: { type: String, required: true },
    proxy: { type: String, required: false },
    isUploading: { type: Boolean, default: false, index: true },
    isUploadingAt: { type: Date, default: null, index: true },
    status: { type: String, enum: ["active", "expired"], default: "active" },
    lastUsedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

/** Avoid sort-in-memory on large collections (Mongo 292 QueryExceededMemoryLimitNoDiskUseAllowed). */
AccountSchema.index({ createdAt: -1 });
/** Supports list + sort for users matched by legacy ownerId. */
AccountSchema.index({ ownerId: 1, createdAt: -1 });
/** Supports list + sort for users matched via ownerIds[]. */
AccountSchema.index({ ownerIds: 1, createdAt: -1 });

export const AccountModel = models.Account || model("Account", AccountSchema);
