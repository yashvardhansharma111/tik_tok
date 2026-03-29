import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { UserModel } from "@/lib/models/User";
import { requireAdmin } from "@/lib/currentUser";

export async function POST(request: Request) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { userId } = await request.json();
  if (!userId) return NextResponse.json({ error: "userId is required" }, { status: 400 });

  await connectDB();
  await UserModel.updateOne({ _id: userId }, { $set: { status: "blocked" } });
  return NextResponse.json({ ok: true });
}
