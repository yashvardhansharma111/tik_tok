"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { ThemeToggle } from "@/components/ThemeToggle";

const baseNav = [
  { href: "/dashboard", label: "Dashboard", icon: "◆" },
  { href: "/accounts", label: "Accounts", icon: "◎" },
  { href: "/rename", label: "Rename", icon: "✎" },
  { href: "/upload", label: "Upload", icon: "▲" },
  { href: "/history", label: "History", icon: "☰" },
] as const;

export function Sidebar() {
  const pathname = usePathname();
  const [role, setRole] = useState<string | null>(null);

  useEffect(() => {
    void fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d: { user?: { role?: string } | null }) => setRole(d?.user?.role ?? null))
      .catch(() => setRole(null));
  }, []);

  if (pathname === "/login" || pathname === "/signup") return null;

  const nav =
    role === "admin"
      ? [...baseNav, { href: "/admin", label: "Admin", icon: "✦" } as const]
      : [...baseNav];

  return (
    <aside
      className="relative flex w-64 shrink-0 flex-col border-r border-zinc-200/90 bg-white/95 shadow-xl shadow-zinc-200/40 backdrop-blur-md dark:border-zinc-800 dark:bg-zinc-950/95 dark:shadow-black/40"
      suppressHydrationWarning
    >
      <div
        className="pointer-events-none absolute inset-y-0 left-0 w-1 bg-gradient-to-b from-rose-500 via-fuchsia-500 to-violet-600 opacity-90"
        aria-hidden
      />
      <div className="px-6 pb-2 pt-8">
        <Link href="/dashboard" className="group block pl-2">
          <span className="text-xs font-semibold uppercase tracking-[0.25em] text-rose-600 dark:text-rose-400">
            Studio
          </span>
          <span className="mt-1 block text-xl font-bold tracking-tight text-zinc-900 dark:text-white">
            TikTok Control
          </span>
        </Link>
      </div>
      <nav className="flex flex-1 flex-col gap-1 px-4 py-4">
        {nav.map(({ href, label, icon }) => {
          const active = pathname === href;
          return (
            <Link
              key={href}
              href={href}
              className={`flex items-center gap-3 rounded-xl px-4 py-3 text-sm font-semibold transition-all ${
                active
                  ? "bg-gradient-to-r from-rose-600/15 to-violet-600/15 text-rose-700 shadow-inner ring-1 ring-rose-500/25 dark:from-rose-500/20 dark:to-violet-500/20 dark:text-rose-200 dark:ring-rose-400/30"
                  : "text-zinc-600 hover:bg-zinc-100/80 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800/80 dark:hover:text-zinc-100"
              }`}
            >
              <span className="text-base opacity-80" aria-hidden>
                {icon}
              </span>
              {label}
            </Link>
          );
        })}
      </nav>
      <div className="flex flex-col gap-3 border-t border-zinc-200/80 p-4 dark:border-zinc-800">
        <div className="flex items-center justify-between gap-2 pl-1">
          <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Theme</span>
          <ThemeToggle className="h-9 w-9 rounded-lg" />
        </div>
        <button
          type="button"
          className="w-full rounded-xl border border-zinc-200 bg-zinc-50 py-2.5 text-sm font-semibold text-zinc-800 transition hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
          onClick={async () => {
            await fetch("/api/auth/logout", { method: "POST" });
            window.location.href = "/login";
          }}
        >
          Log out
        </button>
      </div>
    </aside>
  );
}
