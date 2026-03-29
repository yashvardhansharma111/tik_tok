import mongoose from "mongoose";
import { AccountModel } from "@/lib/models/Account";

export function isSessionExpiredError(msg: string | undefined): boolean {
  return Boolean(msg && msg.includes("SESSION_EXPIRED"));
}

export async function markAccountExpiredIfSessionError(accountId: string, errorMsg: string | undefined) {
  if (!isSessionExpiredError(errorMsg)) return;
  await AccountModel.updateOne(
    { _id: new mongoose.Types.ObjectId(accountId) },
    { $set: { status: "expired" } }
  ).catch(() => {});
}
