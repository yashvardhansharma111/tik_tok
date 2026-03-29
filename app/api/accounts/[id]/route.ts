import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { AccountModel } from "@/lib/models/Account";
import { getCurrentUser } from "@/lib/currentUser";
import { accountFilterForUser } from "@/lib/accountAccess";
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  await connectDB();
  const account = await AccountModel.findOne({ _id: id, ...accountFilterForUser(user) }).lean();
  if (!account) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await AccountModel.deleteOne({ _id: id, ...accountFilterForUser(user) });
  return NextResponse.json({ ok: true });
}
