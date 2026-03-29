import { Schema, model, models } from "mongoose";

const UserSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, index: true },
    password: { type: String, required: true },
    role: { type: String, enum: ["admin", "user"], default: "user" },
    status: { type: String, enum: ["pending", "active", "blocked"], default: "pending" },
    emailVerified: { type: Boolean, default: false },
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
  createdAt: Date;
};

export const UserModel = models.User || model("User", UserSchema);
