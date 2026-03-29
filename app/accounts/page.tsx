"use client";

import { useEffect, useState } from "react";
import { PageHeader } from "@/components/PageHeader";

type Account = { id: string; username: string; proxy?: string; status: string; hasSession: boolean };

export default function AccountsPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [captureUser, setCaptureUser] = useState("");
  const [captureProxy, setCaptureProxy] = useState("");
  const [captureBusy, setCaptureBusy] = useState(false);

  const load = async () => {
    const res = await fetch("/api/accounts");
    if (res.status === 401) {
      window.location.href = "/login";
      return;
    }
    const data = await res.json();
    if (res.ok) setAccounts(data);
  };

  useEffect(() => {
    void load();
  }, []);

  const captureSession = async () => {
    if (!captureUser.trim()) return alert("Enter username for this account");
    setCaptureBusy(true);
    try {
      const res = await fetch("/api/session/capture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: captureUser.trim(), proxy: captureProxy.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || "Capture failed");
        return;
      }
      setCaptureUser("");
      setCaptureProxy("");
      await load();
      alert("Session saved for " + data.username);
    } finally {
      setCaptureBusy(false);
    }
  };

  const remove = async (id: string) => {
    const res = await fetch(`/api/accounts/${id}`, { method: "DELETE" });
    const data = await res.json();
    if (!res.ok) return alert(data.error || "Delete failed");
    load();
  };

  const inputClass =
    "w-full rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-900 shadow-inner outline-none transition focus:border-rose-400 focus:ring-2 focus:ring-rose-500/20 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-rose-500";

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <PageHeader
        eyebrow="Connections"
        title="TikTok accounts"
        description="Capture a browser session for each account (runs on this machine). Linked sessions are private to your login. Use Upload to post and Rename in the sidebar to bulk-change TikTok @usernames (and this app’s account label)."
      />

      <div className="rounded-2xl border border-amber-200/90 bg-gradient-to-br from-amber-50 via-orange-50/80 to-rose-50/60 p-6 shadow-lg shadow-amber-200/20 dark:border-amber-900/40 dark:from-amber-950/50 dark:via-zinc-900 dark:to-rose-950/30 dark:shadow-black/30">
        <h2 className="text-lg font-bold text-amber-950 dark:text-amber-100">Capture session (Playwright)</h2>
        <p className="mt-2 text-sm leading-relaxed text-amber-900/80 dark:text-amber-200/80">
          Runs on the machine where <code className="rounded-md bg-white/70 px-1.5 py-0.5 font-mono text-xs dark:bg-zinc-800">npm run dev</code>{" "}
          is running. A browser window opens—log in to TikTok normally. When you land on For You or home, the session is stored. This can take up to ~5 minutes; keep this browser tab open until it finishes.
        </p>
        <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
          <input
            className={`${inputClass} min-w-[12rem] flex-1`}
            placeholder="Account label / username"
            value={captureUser}
            onChange={(e) => setCaptureUser(e.target.value)}
            disabled={captureBusy}
          />
          <input
            className={`${inputClass} min-w-[12rem] flex-1`}
            placeholder="Proxy (optional)"
            value={captureProxy}
            onChange={(e) => setCaptureProxy(e.target.value)}
            disabled={captureBusy}
          />
          <button
            type="button"
            className="rounded-xl bg-gradient-to-r from-amber-600 to-orange-600 px-6 py-3 text-sm font-bold text-white shadow-lg shadow-amber-600/30 transition hover:brightness-110 disabled:opacity-50"
            disabled={captureBusy}
            onClick={() => void captureSession()}
          >
            {captureBusy ? "Waiting for login…" : "Open browser & save session"}
          </button>
        </div>
      </div>

      <h3 className="mt-12 text-sm font-bold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">Your accounts</h3>
      <ul className="mt-4 space-y-3">
        {accounts.map((a) => (
          <li
            key={a.id}
            className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-zinc-200/90 bg-[var(--card)] px-5 py-4 shadow-md dark:border-zinc-800"
          >
            <div>
              <p className="font-bold text-zinc-900 dark:text-white">{a.username}</p>
              <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
                {a.status} | session {a.hasSession ? "ready" : "missing"}
              </p>
            </div>
            <button
              type="button"
              className="rounded-xl bg-red-600 px-4 py-2 text-sm font-semibold text-white shadow-md shadow-red-500/20 transition hover:bg-red-500"
              onClick={() => remove(a.id)}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
