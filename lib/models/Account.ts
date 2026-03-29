import { Schema, model, models } from "mongoose";

const AccountSchema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: "User", required: false, index: true },
    username: { type: String, required: true, unique: true, index: true },
    session: { type: String, required: true },
    proxy: { type: String, required: false },
    isUploading: { type: Boolean, default: false, index: true },
    isUploadingAt: { type: Date, default: null, index: true },
    status: { type: String, enum: ["active", "expired"], default: "active" },
    lastUsedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export const AccountModel = models.Account || model("Account", AccountSchema);
