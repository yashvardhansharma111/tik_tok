import { Schema, model, models } from "mongoose";

const UserSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, index: true },
    password: { type: String, required: true },
    role: { type: String, enum: ["admin", "user"], default: "user" },
    status: { type: String, enum: ["pending", "active", "blocked"], default: "pending" },
    emailVerified: { type: Boolean, default: false },
    /** Max TikTok accounts this user may link; `null` / unset = unlimited (default). */
    maxLinkedAccounts: { type: Number, default: null, required: false },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

export type UserDoc = {
  _id: string;
  email: string;
  password: string;
  role: "admin" | "user";
  status: "pending" | "active" | "blocked";
  emailVerified: boolean;
  maxLinkedAccounts?: number | null;
  createdAt: Date;
};

export const UserModel = models.User || model("User", UserSchema);
