import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { UserModel } from "@/lib/models/User";
import { signToken, verifyPassword, hashPassword, setAuthCookie } from "@/lib/auth";
import {
  HARDCODED_ADMIN_EMAIL,
  HARDCODED_ADMIN_PASSWORD,
} from "@/lib/adminCredentials";

async function ensureHardcodedAdminUser() {
  const email = HARDCODED_ADMIN_EMAIL.toLowerCase();
  const user = await UserModel.findOne({ email });
  const hashed = await hashPassword(HARDCODED_ADMIN_PASSWORD);
  if (!user) {
    await UserModel.create({
      email,
      password: hashed,
      role: "admin",
      status: "active",
      emailVerified: true,
    });
    return await UserModel.findOne({ email });
  }
  const passwordOk = await verifyPassword(HARDCODED_ADMIN_PASSWORD, user.password);
  if (!passwordOk || user.role !== "admin" || user.status !== "active" || !user.emailVerified) {
    user.password = hashed;
    user.role = "admin";
    user.status = "active";
    user.emailVerified = true;
    await user.save();
  }
  return user;
}

export async function POST(request: Request) {
  try {
    const { email, password } = await request.json();
    if (!email || !password) return NextResponse.json({ error: "email and password are required" }, { status: 400 });

    const emailNorm = String(email).toLowerCase();
    const isHardcodedAdmin =
      emailNorm === HARDCODED_ADMIN_EMAIL.toLowerCase() && password === HARDCODED_ADMIN_PASSWORD;

    await connectDB();

    if (isHardcodedAdmin) {
      const user = await ensureHardcodedAdminUser();
      if (!user) return NextResponse.json({ error: "Login failed" }, { status: 500 });
      const token = signToken({ userId: String(user._id), email: user.email, role: user.role });
      await setAuthCookie(token);
      return NextResponse.json({ ok: true, user: { email: user.email, role: user.role } });
    }

    const user = await UserModel.findOne({ email: emailNorm });
    if (!user) return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });

    const valid = await verifyPassword(password, user.password);
    if (!valid) return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });

    if (!user.emailVerified) return NextResponse.json({ error: "Email not verified" }, { status: 403 });
    if (user.status !== "active") return NextResponse.json({ error: `User status is ${user.status}` }, { status: 403 });

    const token = signToken({ userId: String(user._id), email: user.email, role: user.role });
    await setAuthCookie(token);

    return NextResponse.json({ ok: true, user: { email: user.email, role: user.role } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Login failed" }, { status: 500 });
  }
}
