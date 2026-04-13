"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { logAccountsListLoaded } from "@/lib/accountsListMeta";
import { fetchAllAccountsForSelectors } from "@/lib/fetchAccountsClient";

type Account = { id: string; username: string; proxy?: string; status: string; hasSession: boolean };

type RenameItemRow = {
  accountId: string;
  username: string;
  proposedName: string;
  appliedUsername: string;
  status: string;
  error?: string;
};

type RenameStatusPayload = {
  total: number;
  completed: number;
  accountsRemaining: number;
  estimatedSecondsRemaining: number;
  status: string;
  complete: boolean;
  items: RenameItemRow[];
};

type RenameHistoryJob = {
  id: string;
  status: string;
  prompt: string;
  total: number;
  completed: number;
  error?: string;
  createdAt: string | null;
  updatedAt: string | null;
  items: RenameItemRow[];
};

function formatRenameRow(it: RenameItemRow) {
  const before = it.username ? `@${it.username.replace(/^@/, "")}` : "—";
  const afterRaw = (it.appliedUsername || it.proposedName || "").replace(/^@/, "");
  const after = afterRaw ? `@${afterRaw}` : "…";
  return { before, after };
}

function HistoryJobFailures({ job }: { job: RenameHistoryJob }) {
  const [showFailed, setShowFailed] = useState(false);
  const failures = job.items.filter((it) => it.status === "failed");
  const others = job.items.filter((it) => it.status !== "done" && it.status !== "failed");

  if (failures.length === 0 && others.length === 0) return null;

  return (
    <div className="border-t border-zinc-200 px-4 py-3 dark:border-zinc-700">
      {others.length > 0 && (
        <div className="mb-2">
          <span className="text-xs font-bold text-amber-700 dark:text-amber-300">
            In progress ({others.length})
          </span>
        </div>
      )}
      {failures.length > 0 && (
        <div>
          <button
            onClick={() => setShowFailed((v) => !v)}
            className="text-xs font-bold text-red-600 underline decoration-dotted hover:text-red-500 dark:text-red-400"
          >
            {showFailed ? "Hide" : "Show"} failed ({failures.length})
          </button>
          {showFailed && (
            <ul className="mt-1 divide-y divide-zinc-100 dark:divide-zinc-800">
              {failures.map((it) => {
                const { before, after } = formatRenameRow(it);
                return (
                  <li key={`${job.id}-${it.accountId}`} className="py-1.5">
                    <div className="font-mono text-sm">
                      <span className="text-zinc-500 dark:text-zinc-400">{before}</span>
                      <span className="mx-2 text-red-400">→</span>
                      <span className="text-red-600 dark:text-red-300">{after}</span>
                    </div>
                    {it.error && (
                      <p className="mt-0.5 whitespace-pre-wrap break-words text-xs text-red-500 dark:text-red-400">
                        {it.error}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

const inputClass =
  "w-full rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-900 shadow-inner outline-none transition focus:border-violet-400 focus:ring-2 focus:ring-violet-500/20 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-violet-500";

export default function RenamePage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [renamePrompt, setRenamePrompt] = useState("");
  const [renameSelected, setRenameSelected] = useState<Set<string>>(new Set());
  const [renameJobId, setRenameJobId] = useState<string | null>(null);
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameProgress, setRenameProgress] = useState<RenameStatusPayload | null>(null);
  const [renameHistory, setRenameHistory] = useState<RenameHistoryJob[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);

  const loadRenameHistory = useCallback(async () => {
    const res = await fetch("/api/rename?limit=25");
    if (res.status === 401) {
      console.warn("[rename history] skipped — not authenticated");
      return;
    }
    const data = await res.json();
    if (!res.ok) {
      console.warn("[rename history] request failed", { status: res.status, error: (data as { error?: string }).error });
      return;
    }
    const jobs = Array.isArray(data.jobs)
      ? data.jobs.map((j: Record<string, unknown>) => ({
          id: String(j.id ?? ""),
          status: String(j.status ?? ""),
          prompt: String(j.prompt ?? ""),
          total: Number(j.total ?? 0),
          completed: Number(j.completed ?? 0),
          error: typeof j.error === "string" ? j.error : undefined,
          createdAt: typeof j.createdAt === "string" ? j.createdAt : null,
          updatedAt: typeof j.updatedAt === "string" ? j.updatedAt : null,
          items: Array.isArray(j.items)
            ? (j.items as Record<string, unknown>[]).map((it) => ({
                accountId: String(it.accountId ?? ""),
                username: String(it.username ?? ""),
                proposedName: String(it.proposedName ?? ""),
                appliedUsername: String(it.appliedUsername ?? ""),
                status: String(it.status ?? ""),
                error: typeof it.error === "string" ? it.error : undefined,
              }))
            : [],
        }))
      : [];
    if (jobs.length === 0) {
      console.info("[rename history] no data loaded", {
        jobsReturned: 0,
        message: "Rename history section will show empty state until at least one bulk rename job exists in the database.",
      });
    } else {
      console.info("[rename history] all jobs (full data)", {
        jobsReturned: jobs.length,
        jobs: jobs.map((j: RenameHistoryJob) => ({
          id: j.id,
          status: j.status,
          createdAt: j.createdAt,
          updatedAt: j.updatedAt,
          completed: j.completed,
          total: j.total,
          error: j.error,
          prompt: j.prompt,
          items: j.items.map((it) => ({
            accountId: it.accountId,
            usernameBefore: it.username,
            proposedName: it.proposedName,
            appliedUsername: it.appliedUsername,
            status: it.status,
            error: it.error,
          })),
        })),
      });
    }
    setRenameHistory(jobs);
  }, []);

  const load = useCallback(async () => {
    const { res, data } = await fetchAllAccountsForSelectors();
    if (res.status === 401) {
      window.location.href = "/login";
      return;
    }
    if (res.ok) {
      const list: Account[] = (data.accounts ?? [])
        .filter((a) => a.status !== "expired")
        .map((a) => ({
          id: a.id,
          username: a.username,
          proxy: a.proxy ?? "",
          status: a.status,
          hasSession: Boolean(a.hasSession),
        }));
      setAccounts(list);
      logAccountsListLoaded(
        {
          accounts: list,
          linkedCount: data.linkedCount,
          totalInDatabase: data.totalInDatabase,
          listScope: data.listScope,
          maxLinkedAccounts: data.maxLinkedAccounts,
          listTotal: data.listTotal,
        },
        "rename page"
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void (async () => {
      setHistoryLoading(true);
      await loadRenameHistory();
      setHistoryLoading(false);
    })();
  }, [loadRenameHistory]);

  const pollRename = useCallback(async (jobId: string) => {
    const res = await fetch(`/api/rename/${jobId}`);
    const data = await res.json();
    if (!res.ok) return;
    const items: RenameItemRow[] = Array.isArray(data.items)
      ? data.items.map((it: Record<string, unknown>) => ({
          accountId: String(it.accountId ?? ""),
          username: String(it.username ?? ""),
          proposedName: String(it.proposedName ?? ""),
          appliedUsername: String(it.appliedUsername ?? ""),
          status: String(it.status ?? ""),
          error: typeof it.error === "string" ? it.error : undefined,
        }))
      : [];
    setRenameProgress({
      total: data.total,
      completed: data.completed,
      accountsRemaining: data.accountsRemaining,
      estimatedSecondsRemaining: data.estimatedSecondsRemaining,
      status: data.status,
      complete: data.complete,
      items,
    });
    if (data.complete) void load();
    if (data.complete) void loadRenameHistory();
    if (data.complete) setRenameJobId(null);
  }, [load, loadRenameHistory]);

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
      void loadRenameHistory();
      setRenameProgress({
        total: data.total,
        completed: 0,
        accountsRemaining: data.total,
        estimatedSecondsRemaining: data.total * 45,
        status: "queued",
        complete: false,
        items: [],
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
              No accounts yet. Add one under Accounts (import JSON or local capture).
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

        {renameProgress && renameProgress.items.length > 0 && (
          <div className="mt-6 rounded-xl border border-zinc-200/90 bg-white/80 p-4 shadow-inner dark:border-zinc-700 dark:bg-zinc-900/60">
            <h3 className="text-sm font-bold text-zinc-900 dark:text-white">Username changes</h3>
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
              Each row shows the handle when the job started → target or final @ after TikTok (and our DB).
            </p>
            <ul className="mt-3">
              {renameProgress.items.map((it) => {
                const before = it.username ? `@${it.username.replace(/^@/, "")}` : "—";
                const afterRaw = (it.appliedUsername || it.proposedName || "").replace(/^@/, "");
                const after = afterRaw ? `@${afterRaw}` : "…";
                const done = it.status === "done";
                const failed = it.status === "failed";
                return (
                  <li key={it.accountId} className="flex flex-col gap-2 border-b border-zinc-100 py-3 last:border-b-0 dark:border-zinc-800">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0 flex-1 font-mono text-sm">
                        <span className="text-zinc-500 dark:text-zinc-400">{before}</span>
                        <span className="mx-2 text-violet-600 dark:text-violet-400">→</span>
                        <span className={done ? "font-semibold text-emerald-700 dark:text-emerald-300" : "text-zinc-800 dark:text-zinc-200"}>
                          {after}
                        </span>
                      </div>
                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 text-[0.65rem] font-bold uppercase ${
                          done
                            ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200"
                            : failed
                              ? "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200"
                              : it.status === "running"
                                ? "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100"
                                : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
                        }`}
                      >
                        {it.status}
                      </span>
                    </div>
                    {failed && it.error && (
                      <p className="min-w-0 max-w-full whitespace-pre-wrap break-words text-xs text-red-600 dark:text-red-400">
                        {it.error}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {renameProgress?.complete && (() => {
          const successes = renameProgress.items.filter((it) => it.status === "done");
          const failures = renameProgress.items.filter((it) => it.status === "failed");
          return (
            <>
              {successes.length > 0 && (
                <div className="mt-6 rounded-xl border border-emerald-200/80 bg-emerald-50/60 p-4 dark:border-emerald-800 dark:bg-emerald-950/30">
                  <h3 className="text-sm font-bold text-emerald-800 dark:text-emerald-200">
                    Successful renames ({successes.length})
                  </h3>
                  <ul className="mt-2 space-y-1">
                    {successes.map((it) => {
                      const before = it.username ? `@${it.username.replace(/^@/, "")}` : "—";
                      const after = it.appliedUsername
                        ? `@${it.appliedUsername.replace(/^@/, "")}`
                        : it.proposedName
                          ? `@${it.proposedName.replace(/^@/, "")}`
                          : "—";
                      return (
                        <li key={it.accountId} className="font-mono text-sm">
                          <span className="text-zinc-500 dark:text-zinc-400">{before}</span>
                          <span className="mx-2 text-emerald-600 dark:text-emerald-400">→</span>
                          <span className="font-semibold text-emerald-700 dark:text-emerald-300">{after}</span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
              {failures.length > 0 && (
                <p className="mt-4 text-sm font-medium text-amber-800 dark:text-amber-200">
                  {successes.length > 0
                    ? `${failures.length} account(s) failed — check rows above; you can retry after cooldowns clear.`
                    : "Rename job finished with failures. Check the rows above; you can run again with a different theme or after cooldowns clear."}
                </p>
              )}
              {failures.length === 0 && successes.length > 0 && (
                <p className="mt-4 text-sm font-medium text-emerald-700 dark:text-emerald-300">
                  All renames successful. Account list refreshed.
                </p>
              )}
            </>
          );
        })()}
      </section>

      <section className="mt-12 rounded-2xl border border-zinc-200/90 bg-[var(--card)] p-6 shadow-md dark:border-zinc-800">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-bold text-zinc-900 dark:text-white">Rename history</h2>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Every completed job shows the full <strong className="text-zinc-600 dark:text-zinc-300">@old → @new</strong> list permanently.
          </p>
        </div>
        {historyLoading ? (
          <p className="mt-4 text-sm text-zinc-500">Loading history…</p>
        ) : renameHistory.length === 0 ? (
          <p className="mt-4 text-sm text-zinc-500 dark:text-zinc-400">
            No rename jobs yet — nothing is wrong with logging. Run <strong className="text-zinc-700 dark:text-zinc-300">Apply AI @usernames</strong> once;
            the server creates a <code className="rounded bg-zinc-200/80 px-1 font-mono text-xs dark:bg-zinc-800">RenameJob</code> with old + new
            usernames per account and updates <code className="rounded bg-zinc-200/80 px-1 font-mono text-xs dark:bg-zinc-800">Account.username</code>{" "}
            after success. Then this list and server logs will show full records.
          </p>
        ) : (
          <ul className="mt-4 space-y-4">
            {renameHistory.map((job) => {
              const when = job.createdAt
                ? new Date(job.createdAt).toLocaleString(undefined, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })
                : "—";
              const promptShort =
                job.prompt.length > 72 ? `${job.prompt.slice(0, 72)}…` : job.prompt || "(no prompt)";
              const successes = job.items.filter((it) => it.status === "done");
              const isFinished = job.status === "done" || job.status === "failed" || job.status === "partial";
              return (
                <li
                  key={job.id}
                  className="rounded-xl border border-zinc-200/80 bg-zinc-50/80 dark:border-zinc-700 dark:bg-zinc-900/40"
                >
                  <div className="px-4 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-sm font-semibold text-zinc-900 dark:text-white">{when}</span>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[0.65rem] font-bold uppercase ${
                          job.status === "done"
                            ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200"
                            : job.status === "failed"
                              ? "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200"
                              : job.status === "partial"
                                ? "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100"
                                : job.status === "running"
                                  ? "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100"
                                  : "bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200"
                        }`}
                      >
                        {job.status}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">{promptShort}</p>
                    <p className="mt-0.5 text-[0.7rem] text-zinc-500">
                      {job.completed}/{job.total} accounts
                      {successes.length > 0 ? ` · ${successes.length} renamed` : ""}
                      {job.error ? ` · ${job.error}` : ""}
                    </p>
                  </div>

                  {isFinished && successes.length > 0 && (
                    <div className="border-t border-emerald-200/60 bg-emerald-50/40 px-4 py-3 dark:border-emerald-900/40 dark:bg-emerald-950/20">
                      <h4 className="text-xs font-bold text-emerald-700 dark:text-emerald-300">
                        Renamed ({successes.length})
                      </h4>
                      <ul className="mt-1.5 space-y-0.5">
                        {successes.map((it) => {
                          const { before, after } = formatRenameRow(it);
                          return (
                            <li key={`${job.id}-${it.accountId}`} className="font-mono text-sm">
                              <span className="text-zinc-500 dark:text-zinc-400">{before}</span>
                              <span className="mx-2 text-emerald-600 dark:text-emerald-400">→</span>
                              <span className="font-semibold text-emerald-700 dark:text-emerald-300">{after}</span>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  )}

                  <HistoryJobFailures job={job} />
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
