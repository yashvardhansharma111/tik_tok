import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { UserModel } from "@/lib/models/User";
import { verifyOtp } from "@/lib/otpStore";

export async function POST(request: Request) {
  try {
    const { email, otp } = await request.json();
    if (!email || !otp) return NextResponse.json({ error: "email and otp are required" }, { status: 400 });

    const ok = verifyOtp(email, String(otp).trim());
    if (!ok) {
      return NextResponse.json(
        {
          error:
            "Invalid or expired OTP. Codes expire after 10 minutes. If you restarted `npm run dev`, submit signup again with the same email and password to get a new code.",
        },
        { status: 400 }
      );
    }

    await connectDB();
    await UserModel.updateOne({ email: email.toLowerCase() }, { $set: { emailVerified: true } });

    return NextResponse.json({ ok: true, message: "Email verified. Wait for admin approval." });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Verification failed" }, { status: 500 });
  }
}
