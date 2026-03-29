/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import { useEffect, useState } from "react";
import { PageHeader } from "@/components/PageHeader";

export default function HistoryPage() {
  const [rows, setRows] = useState<any[]>([]);

  useEffect(() => {
    fetch("/api/history").then(async (r) => {
      if (r.status === 401) {
        window.location.href = "/login";
        return;
      }
      const data = await r.json();
      if (r.ok) setRows(data);
    });
  }, []);

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <PageHeader
        eyebrow="Log"
        title="Upload history"
        description="Per-account automation results: video file, status, and errors."
      />

      <div className="overflow-hidden rounded-2xl border border-zinc-200/90 bg-[var(--card)] shadow-xl dark:border-zinc-800">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-200 bg-gradient-to-r from-zinc-100 to-zinc-50 dark:border-zinc-800 dark:from-zinc-900 dark:to-zinc-900/80">
                <th className="px-4 py-4 font-bold text-zinc-700 dark:text-zinc-300">Account</th>
                <th className="px-4 py-4 font-bold text-zinc-700 dark:text-zinc-300">Video</th>
                <th className="px-4 py-4 font-bold text-zinc-700 dark:text-zinc-300">Status</th>
                <th className="px-4 py-4 font-bold text-zinc-700 dark:text-zinc-300">Time</th>
                <th className="px-4 py-4 font-bold text-zinc-700 dark:text-zinc-300">Error</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-zinc-100 transition hover:bg-zinc-50/80 dark:border-zinc-800 dark:hover:bg-zinc-900/50">
                  <td className="px-4 py-3 font-medium text-zinc-900 dark:text-zinc-100">{r.accountUsername}</td>
                  <td className="max-w-[200px] truncate px-4 py-3 text-zinc-600 dark:text-zinc-400">{r.videoFileName}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-bold uppercase ${
                        r.status === "success"
                          ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
                          : r.status === "failed"
                            ? "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300"
                            : "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200"
                      }`}
                    >
                      {r.status}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-zinc-500 dark:text-zinc-400">
                    {new Date(r.timestamp).toLocaleString()}
                  </td>
                  <td className="max-w-[180px] truncate px-4 py-3 text-red-600 dark:text-red-400">{r.error || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
