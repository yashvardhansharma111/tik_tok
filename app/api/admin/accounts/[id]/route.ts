/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectDB } from "@/lib/db";
import { countAccountsForUser, effectiveOwnerIds } from "@/lib/accountAccess";
import { AccountModel } from "@/lib/models/Account";
import { UserModel } from "@/lib/models/User";
import { requireAdmin } from "@/lib/currentUser";

/**
 * PATCH body: `{ ownerIds: string[] }` — full replacement (empty = unassign all).
 * Or legacy `{ ownerId: string | null }` for a single owner only.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  if (!id || !mongoose.Types.ObjectId.isValid(id)) {
    return NextResponse.json({ error: "Invalid account id" }, { status: 400 });
  }

  const body = await request.json().catch(() => ({}));

  let nextIds: mongoose.Types.ObjectId[] = [];
  if (Array.isArray(body.ownerIds)) {
    const raw = body.ownerIds as unknown[];
    const uniq = [...new Set(raw.map((x) => String(x).trim()).filter(Boolean))];
    for (const s of uniq) {
      if (!mongoose.Types.ObjectId.isValid(s)) {
        return NextResponse.json({ error: `Invalid owner id: ${s}` }, { status: 400 });
      }
      nextIds.push(new mongoose.Types.ObjectId(s));
    }
  } else if ("ownerId" in body) {
    const rawOwner = body.ownerId;
    if (rawOwner === null || rawOwner === undefined || rawOwner === "") {
      nextIds = [];
    } else if (mongoose.Types.ObjectId.isValid(String(rawOwner))) {
      nextIds = [new mongoose.Types.ObjectId(String(rawOwner))];
    } else {
      return NextResponse.json({ error: "Invalid ownerId" }, { status: 400 });
    }
  } else {
    return NextResponse.json({ error: "Provide ownerIds (array) or ownerId (legacy)" }, { status: 400 });
  }

  await connectDB();
  const account = await AccountModel.findById(id).lean();
  if (!account) return NextResponse.json({ error: "Account not found" }, { status: 404 });

  const prevSet = new Set(effectiveOwnerIds(account as { ownerId?: unknown; ownerIds?: unknown }));
  const nextSet = new Set(nextIds.map((x) => String(x)));
  if (prevSet.size === nextSet.size && [...prevSet].every((x) => nextSet.has(x))) {
    return NextResponse.json({
      ok: true,
      id: String((account as any)._id),
      ownerIds: nextIds.map(String),
      ownerId: nextIds[0] ? String(nextIds[0]) : null,
      unchanged: true,
    });
  }

  const accountOid = new mongoose.Types.ObjectId(id);
  for (const uid of nextIds) {
    if (prevSet.has(String(uid))) continue;
    const targetUser = await UserModel.findById(uid).select({ maxLinkedAccounts: 1 }).lean();
    if (!targetUser) {
      return NextResponse.json({ error: `User not found: ${uid}` }, { status: 400 });
    }
    const max = (targetUser as { maxLinkedAccounts?: number | null }).maxLinkedAccounts ?? null;
    if (max != null) {
      const c = await countAccountsForUser(AccountModel, uid, accountOid);
      if (c >= max) {
        return NextResponse.json(
          {
            error: `User ${uid} is at their linked-account limit (${max}). Raise max linked accounts first.`,
          },
          { status: 403 }
        );
      }
    }
  }

  await AccountModel.updateOne(
    { _id: id },
    { $set: { ownerIds: nextIds, ownerId: nextIds[0] ?? null } }
  );

  return NextResponse.json({
    ok: true,
    id: String((account as any)._id),
    username: (account as any).username,
    ownerIds: nextIds.map(String),
    ownerId: nextIds[0] ? String(nextIds[0]) : null,
  });
}
