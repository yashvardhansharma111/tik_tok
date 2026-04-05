import { NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectDB } from "@/lib/db";
import { UserModel } from "@/lib/models/User";
import { requireAdmin } from "@/lib/currentUser";

/** PATCH body: `{ maxLinkedAccounts: number | null }` — `null` = unlimited. */
export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return NextResponse.json({ error: "Invalid user id" }, { status: 400 });
  }

  const body = await request.json().catch(() => ({}));
  if (!("maxLinkedAccounts" in body)) {
    return NextResponse.json({ error: "maxLinkedAccounts required" }, { status: 400 });
  }

  const raw = body.maxLinkedAccounts;
  let maxLinkedAccounts: number | null;
  if (raw === null || raw === "" || raw === "unlimited") {
    maxLinkedAccounts = null;
  } else {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 1) {
      return NextResponse.json({ error: "maxLinkedAccounts must be a positive number or null" }, { status: 400 });
    }
    maxLinkedAccounts = Math.floor(n);
  }

  await connectDB();
  const updated = await UserModel.findByIdAndUpdate(
    id,
    { $set: { maxLinkedAccounts } },
    { new: true }
  )
    .select({ password: 0 })
    .lean();

  if (!updated) return NextResponse.json({ error: "User not found" }, { status: 404 });
  return NextResponse.json(updated);
}
