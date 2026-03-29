/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { AccountModel } from "@/lib/models/Account";
import { getCurrentUser } from "@/lib/currentUser";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  await connectDB();
  const accounts = await AccountModel.find({})
    .sort({ createdAt: -1 })
    .lean();
  return NextResponse.json(
    accounts.map((a: any) => ({
      id: String(a._id),
      username: a.username,
      proxy: a.proxy || "",
      status: a.status,
      lastUsedAt: a.lastUsedAt,
      hasSession: Boolean(a.session),
    }))
  );
}
