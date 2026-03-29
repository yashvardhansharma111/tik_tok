"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/PageHeader";

type Account = { id: string; username: string; proxy?: string; status: string; hasSession: boolean };

type RenameStatusPayload = {
  total: number;
  completed: number;
  accountsRemaining: number;
  estimatedSecondsRemaining: number;
  status: string;
  complete: boolean;
};

const inputClass =
  "w-full rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-900 shadow-inner outline-none transition focus:border-violet-400 focus:ring-2 focus:ring-violet-500/20 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-violet-500";

export default function RenamePage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [renamePrompt, setRenamePrompt] = useState("");
  const [renameSelected, setRenameSelected] = useState<Set<string>>(new Set());
  const [renameJobId, setRenameJobId] = useState<string | null>(null);
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameProgress, setRenameProgress] = useState<RenameStatusPayload | null>(null);

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

  const pollRename = useCallback(async (jobId: string) => {
    const res = await fetch(`/api/rename/${jobId}`);
    const data = await res.json();
    if (!res.ok) return;
    setRenameProgress({
      total: data.total,
      completed: data.completed,
      accountsRemaining: data.accountsRemaining,
      estimatedSecondsRemaining: data.estimatedSecondsRemaining,
      status: data.status,
      complete: data.complete,
    });
    if (data.complete) setRenameJobId(null);
  }, []);

  useEffect(() => {
    if (!renameJobId) return;
    void pollRename(renameJobId);
    const id = setInterval(() => void pollRename(renameJobId), 2500);
    return () => clearInterval(id);
  }, [renameJobId, pollRename]);

  const selectableIds = accounts.filter((a) => a.hasSession).map((a) => a.id);

  const selectAllRename = () => {
    setRenameSelected(new Set(selectableIds));
  };

  const clearRenameSelection = () => {
    setRenameSelected(new Set());
  };

  const toggleRename = (id: string) => {
    setRenameSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  const startBulkRename = async () => {
    const prompt = renamePrompt.trim();
    if (!prompt) return alert("Describe what kind of display names you want (e.g. playful foodie, 2 words, English).");
    if (renameSelected.size === 0) return alert("Select at least one account.");
    setRenameBusy(true);
    try {
      const res = await fetch("/api/rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, accountIds: [...renameSelected] }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || "Rename job failed");
        return;
      }
      setRenameJobId(data.jobId);
      setRenameProgress({
        total: data.total,
        completed: 0,
        accountsRemaining: data.total,
        estimatedSecondsRemaining: data.total * 45,
        status: "queued",
        complete: false,
      });
      setRenamePrompt("");
    } finally {
      setRenameBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <PageHeader
        eyebrow="Automation"
        title="Bulk @usernames"
        description="Groq suggests unique TikTok handles from your prompt. Playwright opens Profile → Edit profile → Username → Save (with your session + proxy). Your MongoDB account label is updated to match. If TikTok says the name is taken, we retry with a new suffix automatically."
      />

      <section className="rounded-2xl border border-violet-200/90 bg-gradient-to-br from-violet-50/90 via-fuchsia-50/50 to-white p-6 shadow-lg dark:border-violet-900/40 dark:from-violet-950/40 dark:via-zinc-900 dark:to-zinc-950">
        <textarea
          className={`${inputClass} min-h-[100px] resize-y`}
          placeholder='Handle style, e.g. "minimal 90s aesthetic handles" or "foodie pun usernames"'
          value={renamePrompt}
          onChange={(e) => setRenamePrompt(e.target.value)}
          disabled={renameBusy}
        />

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            Accounts ({renameSelected.size} selected)
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={selectAllRename}
              disabled={renameBusy || selectableIds.length === 0}
              className="rounded-lg border border-violet-200 bg-white px-3 py-2 text-xs font-semibold text-violet-800 hover:bg-violet-50 dark:border-violet-800 dark:bg-zinc-900 dark:text-violet-200 dark:hover:bg-violet-950/50"
            >
              Select all
            </button>
            <button
              type="button"
              onClick={clearRenameSelection}
              disabled={renameBusy}
              className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs font-semibold text-zinc-700 hover:bg-zinc-50 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
            >
              Clear
            </button>
          </div>
        </div>

        <div className="mt-3 space-y-2">
          {accounts.length === 0 ? (
            <p className="rounded-xl border border-dashed border-zinc-300 px-4 py-8 text-center text-sm text-zinc-500 dark:border-zinc-600">
              No accounts yet. Add one under Accounts using session capture.
            </p>
          ) : (
            accounts.map((a) => {
              const on = renameSelected.has(a.id);
              const disabled = !a.hasSession || renameBusy;
              return (
                <label
                  key={a.id}
                  className={`flex cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 text-sm ${
                    disabled ? "cursor-not-allowed opacity-50" : on ? "border-violet-500 bg-violet-500/10" : "border-zinc-200 dark:border-zinc-700"
                  }`}
                >
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-zinc-300"
                    checked={on}
                    disabled={disabled}
                    onChange={() => toggleRename(a.id)}
                  />
                  <span className="font-semibold text-zinc-900 dark:text-white">{a.username}</span>
                  {!a.hasSession && <span className="text-xs text-amber-600">no session</span>}
                </label>
              );
            })
          )}
        </div>

        <button
          type="button"
          className="mt-6 w-full rounded-xl bg-gradient-to-r from-violet-600 to-fuchsia-600 px-6 py-3.5 text-sm font-bold text-white shadow-lg shadow-violet-500/25 transition hover:brightness-110 disabled:opacity-50 sm:w-auto"
          disabled={renameBusy || accounts.length === 0}
          onClick={() => void startBulkRename()}
        >
          {renameBusy ? "Starting…" : "Apply AI @usernames to selected accounts"}
        </button>

        {renameProgress && !renameProgress.complete && (
          <div className="mt-6 space-y-2">
            <div className="flex justify-between text-xs font-semibold text-zinc-600 dark:text-zinc-300">
              <span>
                Accounts left: {renameProgress.accountsRemaining} / {renameProgress.total}
              </span>
              <span>~{Math.ceil(renameProgress.estimatedSecondsRemaining / 60)} min remaining (estimate)</span>
            </div>
            <div className="h-2.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
              <div
                className="h-full rounded-full bg-gradient-to-r from-violet-500 to-fuchsia-500 transition-all duration-500"
                style={{
                  width: `${renameProgress.total ? (renameProgress.completed / renameProgress.total) * 100 : 0}%`,
                }}
              />
            </div>
            <p className="text-xs text-zinc-500">Status: {renameProgress.status}</p>
          </div>
        )}
        {renameProgress?.complete && (
          <p className="mt-4 text-sm font-medium text-emerald-700 dark:text-emerald-300">
            Rename job finished. Refresh the list or open Accounts to verify.
          </p>
        )}
      </section>
    </div>
  );
}
