"use client";

import Link from "next/link";
import { useState } from "react";
import { ThemeToggle } from "@/components/ThemeToggle";

export default function SignupPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [step, setStep] = useState<"signup" | "verify">("signup");
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const field =
    "w-full rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-900 shadow-inner outline-none transition focus:border-violet-400 focus:ring-2 focus:ring-violet-500/20 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100";

  const signup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const res = await fetch("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) return setError(data.error || "Signup failed");
    setMsg(data.message || "OTP sent");
    setStep("verify");
    setOtp("");
  };

  const verify = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const res = await fetch("/api/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, otp }),
    });
    const data = await res.json();
    if (!res.ok) return setError(data.error || "Verification failed");
    setMsg("Verified. Ask admin to approve your account.");
  };

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center px-4 py-16">
      <div className="absolute right-4 top-4 z-10">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-md rounded-3xl border border-zinc-200/90 bg-[var(--card)] p-8 shadow-2xl shadow-zinc-300/40 dark:border-zinc-800 dark:shadow-black/50">
        <p className="text-center text-xs font-bold uppercase tracking-[0.3em] text-violet-600 dark:text-violet-400">Studio</p>
        <h1 className="mt-2 text-center text-3xl font-black tracking-tight text-zinc-900 dark:text-white">Create account</h1>
        {step === "signup" ? (
          <form className="mt-8 space-y-4" onSubmit={signup}>
            <input className={field} placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
            <input
              className={field}
              placeholder="Password (min 6 characters)"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
            />
            <button
              type="submit"
              className="w-full rounded-xl bg-gradient-to-r from-violet-600 to-fuchsia-600 py-3.5 text-sm font-bold text-white shadow-lg shadow-violet-500/25 transition hover:brightness-110"
            >
              Continue
            </button>
          </form>
        ) : (
          <form className="mt-8 space-y-4" onSubmit={verify}>
            <p className="text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
              Code sent to <span className="font-semibold text-zinc-900 dark:text-white">{email}</span>. If the dev server restarted, submit signup again with the same password to resend.
            </p>
            <input className={field} placeholder="6-digit OTP" inputMode="numeric" value={otp} onChange={(e) => setOtp(e.target.value)} />
            <button
              type="button"
              className="w-full rounded-xl border border-zinc-200 py-3 text-sm font-semibold dark:border-zinc-700"
              onClick={() => setStep("signup")}
            >
              Back — resend code
            </button>
            <button
              type="submit"
              className="w-full rounded-xl bg-gradient-to-r from-violet-600 to-fuchsia-600 py-3.5 text-sm font-bold text-white shadow-lg"
            >
              Verify email
            </button>
          </form>
        )}
        {msg && <p className="mt-4 text-center text-sm font-medium text-emerald-600 dark:text-emerald-400">{msg}</p>}
        {error && <p className="mt-4 text-center text-sm font-medium text-red-600 dark:text-red-400">{error}</p>}
        <p className="mt-6 text-center text-sm text-zinc-600 dark:text-zinc-400">
          Already have an account?{" "}
          <Link className="font-semibold text-violet-600 underline dark:text-violet-400" href="/login">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
