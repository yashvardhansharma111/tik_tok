/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import { useEffect, useState } from "react";
import { PageHeader } from "@/components/PageHeader";

export default function DashboardPage() {
  const [data, setData] = useState<any>(null);
  const [me, setMe] = useState<{ role?: string; email?: string } | null>(null);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d: { user?: { role?: string; email?: string } | null }) => setMe(d?.user ?? null))
      .catch(() => setMe(null));
  }, []);

  useEffect(() => {
    fetch("/api/dashboard")
      .then((r) => r.json())
      .then(setData)
      .catch(() => setData(null));
  }, []);

  const isAdmin = me?.role === "admin";

  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <PageHeader
        eyebrow="Overview"
        title="Dashboard"
        description="All team members use the same TikTok account pool. Stats reflect every linked account and upload."
      />

      {me && (
        <div className="mb-8 flex flex-wrap items-center gap-3 rounded-2xl border border-zinc-200/80 bg-[var(--card)] px-5 py-4 dark:border-zinc-800">
          <span className="text-sm text-zinc-600 dark:text-zinc-400">Signed in as</span>
          <span className="font-semibold text-zinc-900 dark:text-white">{me.email}</span>
          {isAdmin && (
            <span className="rounded-full bg-gradient-to-r from-violet-600 to-fuchsia-600 px-3 py-1 text-xs font-bold uppercase tracking-wide text-white">
              Admin
            </span>
          )}
        </div>
      )}

      {!data ? (
        <p className="text-zinc-500">Loading…</p>
      ) : (
        <div className="grid gap-5 md:grid-cols-3">
          <div className="rounded-2xl border border-zinc-200/90 bg-gradient-to-br from-rose-500/10 to-transparent p-6 shadow-lg dark:border-zinc-800 dark:from-rose-500/15">
            <div className="text-xs font-bold uppercase tracking-wider text-rose-600 dark:text-rose-400">Accounts</div>
            <div className="mt-2 text-4xl font-black tabular-nums text-zinc-900 dark:text-white">{data.totalAccounts}</div>
            <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">Linked TikTok profiles</p>
          </div>
          <div className="rounded-2xl border border-zinc-200/90 bg-gradient-to-br from-violet-500/10 to-transparent p-6 shadow-lg md:col-span-2 dark:border-zinc-800 dark:from-violet-500/15">
            <div className="text-xs font-bold uppercase tracking-wider text-violet-600 dark:text-violet-400">Last upload</div>
            <div className="mt-2 text-lg font-semibold text-zinc-900 dark:text-white">
              {data.lastUpload
                ? `${data.lastUpload.account} · ${data.lastUpload.video} · ${data.lastUpload.status}`
                : "No uploads yet — go to Upload"}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
