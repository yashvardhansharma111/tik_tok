/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PageHeader } from "@/components/PageHeader";

type Stats = {
  total: number;
  success: number;
  failed: number;
  uploading: number;
  pending: number;
};

function toLocalDatetime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function HistoryPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [fromDate, setFromDate] = useState(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return toLocalDatetime(d);
  });
  const [appliedFrom, setAppliedFrom] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchHistory = useCallback(async (from?: string) => {
    const params = new URLSearchParams();
    if (from) params.set("from", new Date(from).toISOString());
    params.set("limit", "500");

    const r = await fetch(`/api/history?${params}`);
    if (r.status === 401) {
      window.location.href = "/login";
      return;
    }
    if (r.ok) {
      const data = await r.json();
      setRows(data.rows ?? data);
      if (data.stats) setStats(data.stats);
    }
  }, []);

  useEffect(() => {
    fetchHistory(appliedFrom || undefined);
    pollRef.current = setInterval(() => fetchHistory(appliedFrom || undefined), 8000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [appliedFrom, fetchHistory]);

  const applyFilter = () => {
    setAppliedFrom(fromDate);
  };

  const clearFilter = () => {
    setFromDate("");
    setAppliedFrom("");
  };

  const now = new Date();

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <PageHeader
        eyebrow="Log"
        title="Upload history"
        description="Per-account automation results: video file, status, and errors."
      />

      <div className="mb-6 rounded-2xl border border-zinc-200/90 bg-[var(--card)] p-5 shadow-lg dark:border-zinc-800">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs font-semibold text-zinc-600 dark:text-zinc-400">
            From
            <input
              type="datetime-local"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              className="mt-1 block w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>
          <label className="text-xs font-semibold text-zinc-600 dark:text-zinc-400">
            To
            <input
              type="text"
              readOnly
              value={`Now (${now.toLocaleString()})`}
              className="mt-1 block w-full cursor-default rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-400"
            />
          </label>
          <button
            type="button"
            onClick={applyFilter}
            className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-bold text-white shadow transition hover:bg-violet-700"
          >
            Filter
          </button>
          {appliedFrom && (
            <button
              type="button"
              onClick={clearFilter}
              className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Clear
            </button>
          )}
        </div>

        {stats && (
          <div className="mt-4">
            <div className="flex flex-wrap gap-4">
              <div className="flex items-center gap-2 rounded-xl bg-zinc-100 px-3 py-2 dark:bg-zinc-800">
                <span className="text-2xl font-black text-zinc-900 dark:text-white">{stats.total}</span>
                <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">total</span>
              </div>
              <div className="flex items-center gap-2 rounded-xl bg-emerald-50 px-3 py-2 dark:bg-emerald-950/50">
                <span className="text-2xl font-black text-emerald-700 dark:text-emerald-300">{stats.success}</span>
                <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">uploaded</span>
              </div>
              <div className="flex items-center gap-2 rounded-xl bg-red-50 px-3 py-2 dark:bg-red-950/50">
                <span className="text-2xl font-black text-red-700 dark:text-red-300">{stats.failed}</span>
                <span className="text-xs font-medium text-red-600 dark:text-red-400">failed</span>
              </div>
              <div className="flex items-center gap-2 rounded-xl bg-amber-50 px-3 py-2 dark:bg-amber-950/50">
                <span className="text-2xl font-black text-amber-700 dark:text-amber-300">{stats.uploading}</span>
                <span className="text-xs font-medium text-amber-600 dark:text-amber-400">uploading</span>
              </div>
              <div className="flex items-center gap-2 rounded-xl bg-zinc-50 px-3 py-2 dark:bg-zinc-800/50">
                <span className="text-2xl font-black text-zinc-600 dark:text-zinc-300">{stats.pending}</span>
                <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">pending</span>
              </div>
            </div>
            {stats.total > 0 && (
              <div className="mt-3 h-2.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
                <div className="flex h-full">
                  {stats.success > 0 && (
                    <div
                      className="bg-emerald-500 transition-all duration-500"
                      style={{ width: `${(stats.success / stats.total) * 100}%` }}
                    />
                  )}
                  {stats.failed > 0 && (
                    <div
                      className="bg-red-500 transition-all duration-500"
                      style={{ width: `${(stats.failed / stats.total) * 100}%` }}
                    />
                  )}
                  {stats.uploading > 0 && (
                    <div
                      className="animate-pulse bg-amber-400 transition-all duration-500"
                      style={{ width: `${(stats.uploading / stats.total) * 100}%` }}
                    />
                  )}
                </div>
              </div>
            )}
            {appliedFrom && (
              <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
                Showing uploads since {new Date(appliedFrom).toLocaleString()}
              </p>
            )}
          </div>
        )}
      </div>

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
                  <td
                    className="max-w-[min(360px,80vw)] px-4 py-3 text-sm text-red-700 dark:text-red-300"
                    title={r.error || ""}
                  >
                    {r.status === "failed" ? (
                      <span className="block leading-snug">{r.errorFriendly || r.error || "—"}</span>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-sm text-zinc-400">
                    No uploads found{appliedFrom ? " for the selected time range" : ""}.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
