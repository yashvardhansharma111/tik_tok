import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { UserModel } from "@/lib/models/User";
import { createOtp } from "@/lib/otpStore";
import { sendOtpEmail } from "@/lib/mailer";
import { hashPassword, verifyPassword } from "@/lib/auth";

export async function POST(request: Request) {
  try {
    const { email, password } = await request.json();
    if (!email || !password || password.length < 6) {
      return NextResponse.json({ error: "Valid email and password (min 6 chars) are required" }, { status: 400 });
    }

    await connectDB();
    const emailLower = email.toLowerCase();
    const existing = await UserModel.findOne({ email: emailLower });

    if (existing) {
      if (existing.emailVerified) {
        return NextResponse.json({ error: "Account already exists. Log in instead." }, { status: 409 });
      }
      const passwordOk = await verifyPassword(password, existing.password);
      if (!passwordOk) {
        return NextResponse.json({ error: "Email is registered but not verified. Use the same password you signed up with, or contact admin." }, { status: 401 });
      }
      const otp = createOtp(emailLower);
      await sendOtpEmail(emailLower, otp);
      return NextResponse.json({
        ok: true,
        message: "A new verification code was sent to your email (OTP resets if the dev server restarted).",
      });
    }

    const hashed = await hashPassword(password);
    await UserModel.create({
      email: emailLower,
      password: hashed,
      role: "user",
      status: "pending",
      emailVerified: false,
    });

    const otp = createOtp(emailLower);
    await sendOtpEmail(emailLower, otp);

    return NextResponse.json({ ok: true, message: "Signup successful. OTP sent to email." });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Signup failed" }, { status: 500 });
  }
}
