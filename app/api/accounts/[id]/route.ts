import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { AccountModel } from "@/lib/models/Account";
import mongoose from "mongoose";
import { getCurrentUser } from "@/lib/currentUser";
import { userHasAccountAccess } from "@/lib/accountAccess";
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  await connectDB();
  const account = await AccountModel.findOne({ _id: id }).lean();
  if (!account) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const isAdmin = (user as { role?: string }).role === "admin";
  const ownerId = (user as { _id: unknown })._id as mongoose.Types.ObjectId;
  if (!isAdmin) {
    if (!userHasAccountAccess(account as { ownerId?: unknown; ownerIds?: unknown }, ownerId)) {
      return NextResponse.json({ error: "Not your account" }, { status: 403 });
    }
  }

  await AccountModel.deleteOne({ _id: id });
  return NextResponse.json({ ok: true });
}
