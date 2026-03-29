"use client";

import Link from "next/link";
import { useState } from "react";
import { ThemeToggle } from "@/components/ThemeToggle";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    setLoading(false);
    if (!res.ok) return setError(data.error || "Login failed");
    window.location.href = "/dashboard";
  };

  const field =
    "w-full rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-900 shadow-inner outline-none transition focus:border-rose-400 focus:ring-2 focus:ring-rose-500/20 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100";

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center px-4 py-16">
      <div className="absolute right-4 top-4 z-10 flex items-center gap-2">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-md rounded-3xl border border-zinc-200/90 bg-[var(--card)] p-8 shadow-2xl shadow-zinc-300/40 dark:border-zinc-800 dark:shadow-black/50">
        <p className="text-center text-xs font-bold uppercase tracking-[0.3em] text-rose-600 dark:text-rose-400">Studio</p>
        <h1 className="mt-2 text-center text-3xl font-black tracking-tight text-zinc-900 dark:text-white">Welcome back</h1>
        <p className="mt-2 text-center text-sm text-zinc-500 dark:text-zinc-400">Sign in to manage TikTok uploads</p>
        <form className="mt-8 space-y-4" onSubmit={onSubmit}>
          <input className={field} placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
          <input
            className={field}
            placeholder="Password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
          {error && <p className="text-sm font-medium text-red-600 dark:text-red-400">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-xl bg-gradient-to-r from-rose-600 to-violet-600 py-3.5 text-sm font-bold text-white shadow-lg shadow-rose-500/25 transition hover:brightness-110 disabled:opacity-60"
          >
            {loading ? "Signing in…" : "Sign in"}
          </button>
        </form>
        <p className="mt-6 text-center text-sm text-zinc-600 dark:text-zinc-400">
          No account?{" "}
          <Link className="font-semibold text-rose-600 underline decoration-rose-400/50 underline-offset-2 dark:text-rose-400" href="/signup">
            Create one
          </Link>
        </p>
      </div>
    </div>
  );
}
