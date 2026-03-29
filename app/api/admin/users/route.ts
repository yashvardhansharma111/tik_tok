import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { UserModel } from "@/lib/models/User";
import { requireAdmin } from "@/lib/currentUser";

export async function GET() {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  await connectDB();
  const users = await UserModel.find({}, { password: 0 }).sort({ createdAt: -1 }).lean();
  return NextResponse.json(users);
}
