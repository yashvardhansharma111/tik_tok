/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { AccountsListExplain } from "@/components/AccountsListExplain";
import { logAccountsListLoaded } from "@/lib/accountsListMeta";

type Account = { id: string; username: string; hasSession?: boolean };

type AccountQuota = {
  linkedCount: number;
  maxLinkedAccounts: number | null;
  canAddMore: boolean;
};

export default function UploadPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountQuota, setAccountQuota] = useState<AccountQuota | null>(null);
  const [accountsListInfo, setAccountsListInfo] = useState<{
    totalInDatabase: number;
    listScope: "owner_only" | "all_in_database";
  } | null>(null);
  const [caption, setCaption] = useState("");
  const [musicQuery, setMusicQuery] = useState("");
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [parallelism, setParallelism] = useState(4);
  const [staggerSeconds, setStaggerSeconds] = useState(0);
  const [scheduledStartAt, setScheduledStartAt] = useState("");
  const [uniqueCaptionPerAccount, setUniqueCaptionPerAccount] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [file, setFile] = useState<File | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [batchUploadId, setBatchUploadId] = useState<string | null>(null);
  const [batchStatus, setBatchStatus] = useState<{
    total: number;
    done: number;
    success: number;
    failed: number;
    accountsRemaining: number;
    parallelism?: number;
    estimatedSecondsRemaining: number;
    complete: boolean;
    failedDetails?: { accountUsername: string; friendlyMessage: string; rawError?: string }[];
    staleUploading?: { accountUsername: string; minutesStuckApprox: number }[];
    hasParallelismNote?: string;
  } | null>(null);

  useEffect(() => {
    fetch("/api/accounts").then(async (r) => {
      if (r.status === 401) {
        window.location.href = "/login";
        return;
      }
      const data = await r.json();
      if (r.ok) {
        const list = Array.isArray(data) ? data : data.accounts ?? [];
        setAccounts(
          list.map((a: any) => ({
            id: a.id,
            username: a.username,
            hasSession: a.hasSession,
          }))
        );
        if (typeof data.totalInDatabase === "number" && (data.listScope === "owner_only" || data.listScope === "all_in_database")) {
          setAccountsListInfo({ totalInDatabase: data.totalInDatabase, listScope: data.listScope });
        } else {
          setAccountsListInfo(null);
        }
        logAccountsListLoaded(
          {
            accounts: list,
            linkedCount: data.linkedCount,
            totalInDatabase: data.totalInDatabase,
            listScope: data.listScope,
            maxLinkedAccounts: data.maxLinkedAccounts,
          },
          "upload page"
        );
        if (data && typeof data.linkedCount === "number") {
          setAccountQuota({
            linkedCount: data.linkedCount,
            maxLinkedAccounts: data.maxLinkedAccounts ?? null,
            canAddMore: data.canAddMore !== false,
          });
        }
      }
    });
  }, []);

  useEffect(() => {
    if (!batchUploadId) return;
    const tick = async () => {
      const res = await fetch(`/api/upload/status/${encodeURIComponent(batchUploadId)}`);
      const data = await res.json();
      if (!res.ok) {
        setBatchStatus(null);
        setBatchUploadId(null);
        return;
      }
      setBatchStatus({
        total: data.total,
        done: data.done ?? data.success + data.failed,
        success: data.success ?? 0,
        failed: data.failed ?? 0,
        accountsRemaining: data.accountsRemaining,
        parallelism: data.parallelism,
        estimatedSecondsRemaining: data.estimatedSecondsRemaining,
        complete: data.complete,
        failedDetails: data.failedDetails,
        staleUploading: data.staleUploading,
        hasParallelismNote: data.hasParallelismNote,
      });
      if (data.complete) setBatchUploadId(null);
    };
    void tick();
    const id = setInterval(() => void tick(), 2500);
    return () => clearInterval(id);
  }, [batchUploadId]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  const selectAll = () => {
    setSelected(new Set(accounts.map((a) => a.id)));
  };

  const clearSelection = () => setSelected(new Set());

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file || selected.size === 0) {
      setMsg("Choose a video and at least one TikTok account below.");
      return;
    }
    setLoading(true);
    setMsg(null);
    const form = new FormData();
    form.append("video", file);
    form.append("caption", caption);
    if (musicQuery.trim()) form.append("musicQuery", musicQuery.trim());
    form.append("accountIds", JSON.stringify([...selected]));
    form.append("parallelism", String(parallelism));
    form.append("staggerSeconds", String(staggerSeconds));
    if (scheduledStartAt.trim()) {
      const t = new Date(scheduledStartAt).getTime();
      if (!Number.isNaN(t)) form.append("scheduledStartAt", new Date(t).toISOString());
    }
    if (uniqueCaptionPerAccount) {
      form.append("uniqueCaptionPerAccount", "1");
      if (aiPrompt.trim()) form.append("captionTopic", aiPrompt.trim());
    }

    const res = await fetch("/api/upload", { method: "POST", body: form });
    const data = await res.json();
    setLoading(false);
    if (res.ok && data.uploadId) {
      setBatchUploadId(data.uploadId);
      setBatchStatus({
        total: data.processed,
        done: 0,
        success: 0,
        failed: 0,
        accountsRemaining: data.processed,
        parallelism: data.parallelism,
        estimatedSecondsRemaining: data.processed * 90,
        complete: false,
      });
    }
    setMsg(
      res.ok
        ? `Started upload to ${data.processed} account(s) with parallelism=${data.parallelism || parallelism}. ${
            uniqueCaptionPerAccount ? "Unique AI captions were generated per account. " : ""
          }Music query: ${data.musicQuery || "default (trending)"}. Progress updates below.`
        : data.error || "Upload failed"
    );
  };

  const generateCaption = async () => {
    setAiLoading(true);
    setMsg(null);
    try {
      const prompt = aiPrompt.trim();
      const topic = prompt
        ? prompt
        : file
          ? `Video idea from filename: ${file.name}`
          : "General TikTok caption idea";

      const res = await fetch("/api/ai/caption/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: topic }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMsg(data?.error || "AI caption generation failed");
        return;
      }
      setCaption(data.caption || "");
      setAiPrompt("");
      setMsg("AI caption generated.");
    } finally {
      setAiLoading(false);
    }
  };

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <PageHeader
        eyebrow="Publish"
        title="Upload to TikTok"
        description="Pick your video and caption, then choose which linked accounts should post the same clip. Each selected account runs automation in its own browser context using its saved session. If you use two servers, each server has its own “parallel browsers” setting — they do not change each other."
      />

      <form onSubmit={submit} className="space-y-10">
        <section className="rounded-2xl border border-zinc-200/90 bg-[var(--card)] p-6 shadow-lg shadow-zinc-200/30 dark:border-zinc-800 dark:shadow-black/30">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-rose-500 to-fuchsia-600 text-sm font-bold text-white">
              1
            </span>
            <div>
              <h2 className="text-lg font-bold text-zinc-900 dark:text-white">Video file</h2>
              <p className="text-sm text-zinc-500 dark:text-zinc-400">MP4 recommended</p>
            </div>
          </div>
          <label className="mt-5 flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-zinc-300 bg-zinc-50/80 px-6 py-12 transition hover:border-rose-400/60 hover:bg-rose-50/30 dark:border-zinc-600 dark:bg-zinc-900/50 dark:hover:border-rose-500/40">
            <input
              type="file"
              accept="video/mp4,.mp4"
              className="hidden"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
            />
            <span className="text-3xl">📹</span>
            <span className="mt-2 text-sm font-semibold text-zinc-700 dark:text-zinc-200">
              {file ? file.name : "Click to choose video"}
            </span>
            <span className="mt-1 text-xs text-zinc-500">or drag and drop (browser dependent)</span>
          </label>
        </section>

        <section className="rounded-2xl border border-zinc-200/90 bg-[var(--card)] p-6 shadow-lg shadow-zinc-200/30 dark:border-zinc-800 dark:shadow-black/30">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-violet-500 to-indigo-600 text-sm font-bold text-white">
              2
            </span>
            <div>
              <h2 className="text-lg font-bold text-zinc-900 dark:text-white">Caption</h2>
              <p className="text-sm text-zinc-500 dark:text-zinc-400">Shown as the TikTok description</p>
            </div>
          </div>
          <textarea
            className="mt-5 min-h-[120px] w-full resize-y rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-900 shadow-inner outline-none ring-0 transition focus:border-violet-400 focus:ring-2 focus:ring-violet-500/20 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-violet-500"
            placeholder="Hashtags, mentions, description…"
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
          />

          <label className="mt-4 block">
            <span className="mb-2 block text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              Sound search (optional)
            </span>
            <input
              className="w-full rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-900 shadow-inner outline-none transition focus:border-teal-400 focus:ring-2 focus:ring-teal-500/20 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-teal-500"
              placeholder='e.g. "Cupid - Fifty Fifty" or "trending"'
              value={musicQuery}
              onChange={(e) => setMusicQuery(e.target.value)}
            />
            <span className="mt-1 block text-xs text-zinc-500 dark:text-zinc-400">
              If set, automation opens Add sound, searches, and picks the first matching result before Post.
            </span>
          </label>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <input
              className="w-full rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-900 shadow-inner outline-none transition focus:border-rose-400 focus:ring-2 focus:ring-rose-500/20 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-rose-500"
              placeholder="AI prompt (topic/keywords) — optional"
              value={aiPrompt}
              onChange={(e) => setAiPrompt(e.target.value)}
              disabled={aiLoading}
            />
            <button
              type="button"
              onClick={() => void generateCaption()}
              disabled={aiLoading}
              className="rounded-xl bg-gradient-to-r from-rose-600 via-fuchsia-600 to-violet-600 px-5 py-3 text-sm font-bold text-white shadow-lg shadow-rose-500/25 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {aiLoading ? "Generating…" : "Generate caption (AI)"}
            </button>
          </div>

          <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-xl border border-violet-200/90 bg-violet-50/60 px-4 py-3 dark:border-violet-900/50 dark:bg-violet-950/25">
            <input
              type="checkbox"
              checked={uniqueCaptionPerAccount}
              onChange={(e) => setUniqueCaptionPerAccount(e.target.checked)}
              className="mt-1 h-4 w-4 shrink-0 rounded border-violet-400 text-violet-600 focus:ring-violet-500"
            />
            <span className="min-w-0">
              <span className="font-semibold text-zinc-900 dark:text-zinc-100">Different AI description per account</span>
              <span className="mt-1 block text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">
                On upload, the server generates a distinct caption for each selected account (same video). Topic order: caption
                above, then optional AI keywords field, then sound search, then the video file name. Requires{" "}
                <code className="rounded bg-white/80 px-1 font-mono text-[11px] dark:bg-zinc-900">GROQ_API_KEY</code> on the
                server. May take a few seconds before the batch starts.
              </span>
            </span>
          </label>
        </section>

        <section className="rounded-2xl border border-zinc-200/90 bg-[var(--card)] p-6 shadow-lg shadow-zinc-200/30 dark:border-zinc-800 dark:shadow-black/30">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 text-sm font-bold text-white">
                3
              </span>
              <div>
                <h2 className="text-lg font-bold text-zinc-900 dark:text-white">Select TikTok accounts</h2>
                <p className="text-sm text-zinc-500 dark:text-zinc-400">
                  Use the checklist below (scroll inside the box if you have many accounts). Order follows selection: first
                  checked is first in the rotation queue, then stagger delay applies to the next.
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <label className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs font-semibold text-zinc-700 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-200">
                Parallel browsers
                <select
                  className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs font-semibold text-zinc-800 outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                  value={parallelism}
                  onChange={(e) => setParallelism(Number(e.target.value))}
                >
                  {Array.from({ length: 16 }).map((_, i) => {
                    const v = i + 1;
                    return (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    );
                  })}
                </select>
              </label>
              <button
                type="button"
                onClick={selectAll}
                className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs font-semibold text-zinc-700 hover:bg-zinc-50 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
              >
                Select all
              </button>
              <button
                type="button"
                onClick={clearSelection}
                className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs font-semibold text-zinc-700 hover:bg-zinc-50 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
              >
                Clear
              </button>
            </div>
          </div>

          <div className="mt-4 grid gap-3 rounded-xl border border-zinc-200/80 bg-zinc-50/80 p-4 dark:border-zinc-700 dark:bg-zinc-900/40 sm:grid-cols-2">
            <label className="block text-xs font-semibold text-zinc-700 dark:text-zinc-200">
              Seconds between accounts (rotation)
              <input
                type="number"
                min={0}
                max={86400}
                step={1}
                value={staggerSeconds}
                onChange={(e) => setStaggerSeconds(Math.min(86400, Math.max(0, Number(e.target.value) || 0)))}
                className="mt-1.5 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm font-medium text-zinc-900 dark:border-zinc-600 dark:bg-zinc-950 dark:text-zinc-100"
              />
              <span className="mt-1 block font-normal text-zinc-500 dark:text-zinc-400">
                0 = all eligible at once (within parallelism). Larger values space jobs out automatically.
              </span>
            </label>
            <label className="block text-xs font-semibold text-zinc-700 dark:text-zinc-200">
              Start batch at (optional)
              <input
                type="datetime-local"
                value={scheduledStartAt}
                onChange={(e) => setScheduledStartAt(e.target.value)}
                className="mt-1.5 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm font-medium text-zinc-900 dark:border-zinc-600 dark:bg-zinc-950 dark:text-zinc-100"
              />
              <span className="mt-1 block font-normal text-zinc-500 dark:text-zinc-400">
                Leave empty to start from “now” (or from submit time). Combined with stagger, first account uses this time.
              </span>
            </label>
          </div>

          <div className="mt-2 flex items-center justify-between text-sm">
            <span className="font-semibold text-rose-600 dark:text-rose-400">
              {selected.size} of {accounts.length} selected
            </span>
            {accountQuota && (
              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                Linked {accountQuota.linkedCount}
                {accountQuota.maxLinkedAccounts != null ? ` / ${accountQuota.maxLinkedAccounts} allowed` : " (no limit)"}
                {!accountQuota.canAddMore && " — at account limit"}
              </span>
            )}
            {accounts.length === 0 && (
              <Link
                href="/accounts"
                className="font-semibold text-violet-600 underline decoration-violet-400/50 underline-offset-2 hover:text-violet-500 dark:text-violet-400"
              >
                Add accounts first →
              </Link>
            )}
          </div>
          {accountsListInfo && (
            <AccountsListExplain
              listScope={accountsListInfo.listScope}
              totalInDatabase={accountsListInfo.totalInDatabase}
              listCount={accounts.length}
              linkedCount={accountQuota?.linkedCount ?? accounts.length}
              maxLinkedAccounts={accountQuota?.maxLinkedAccounts ?? null}
            />
          )}

          {accounts.length === 0 ? (
            <div className="mt-6 rounded-xl bg-zinc-100/80 px-6 py-10 text-center dark:bg-zinc-900/60">
              <p className="text-zinc-600 dark:text-zinc-400">No accounts available. Link TikTok sessions on the Accounts page.</p>
              <Link
                href="/accounts"
                className="mt-4 inline-flex rounded-xl bg-gradient-to-r from-rose-600 to-violet-600 px-5 py-2.5 text-sm font-bold text-white shadow-lg shadow-rose-500/25"
              >
                Go to Accounts
              </Link>
            </div>
          ) : (
            <div className="mt-6 max-h-[min(22rem,55vh)] overflow-y-auto rounded-xl border border-zinc-200/90 bg-white dark:border-zinc-700 dark:bg-zinc-950/40">
              <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {accounts.map((a) => {
                  const on = selected.has(a.id);
                  const noSession = a.hasSession === false;
                  return (
                    <li key={a.id}>
                      <label
                        className={`flex cursor-pointer items-center gap-3 px-3 py-2.5 transition ${
                          noSession
                            ? "cursor-not-allowed opacity-50"
                            : on
                              ? "bg-rose-500/10 dark:bg-rose-950/30"
                              : "hover:bg-zinc-50 dark:hover:bg-zinc-900/60"
                        }`}
                      >
                        <input
                          type="checkbox"
                          className="h-4 w-4 shrink-0 rounded border-zinc-300 text-rose-600 focus:ring-rose-500 dark:border-zinc-600"
                          checked={on}
                          disabled={noSession}
                          onChange={() => toggle(a.id)}
                        />
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-semibold text-zinc-900 dark:text-white">{a.username}</p>
                          <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                            {noSession ? "No session — fix on Accounts" : "Session ready"}
                          </p>
                        </div>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </section>

        <button
          type="submit"
          disabled={loading || accounts.length === 0}
          className="w-full rounded-2xl bg-gradient-to-r from-rose-600 via-fuchsia-600 to-violet-600 py-4 text-base font-bold text-white shadow-xl shadow-rose-500/30 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50 dark:shadow-rose-900/40"
        >
          {loading ? "Starting uploads…" : "Start upload to selected accounts"}
        </button>
      </form>

      {batchStatus && !batchStatus.complete && (
        <div
          className={`mt-8 rounded-2xl border p-5 shadow-md ${
            batchStatus.failed > 0 || (batchStatus.staleUploading && batchStatus.staleUploading.length > 0)
              ? "border-amber-300/90 bg-amber-50/90 dark:border-amber-900/50 dark:bg-amber-950/25"
              : "border-teal-200/90 bg-teal-50/80 dark:border-teal-900/50 dark:bg-teal-950/30"
          }`}
        >
          <p className="text-sm font-bold text-zinc-900 dark:text-zinc-100">Batch progress</p>
          <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
            {batchStatus.hasParallelismNote ||
              "Parallel browsers applies only on this server’s worker — not other machines."}
          </p>
          <div className="mt-3 flex flex-wrap justify-between gap-2 text-xs font-semibold text-zinc-800 dark:text-zinc-200">
            <span>
              Done: {batchStatus.done} / {batchStatus.total} · Remaining: {batchStatus.accountsRemaining}
              {batchStatus.failed > 0 && (
                <span className="ml-2 text-amber-800 dark:text-amber-200">
                  ({batchStatus.failed} failed so far)
                </span>
              )}
            </span>
            <span>
              Parallelism: {batchStatus.parallelism || parallelism} · ~
              {Math.max(0, Math.ceil(batchStatus.estimatedSecondsRemaining / 60))} min est.
            </span>
          </div>
          <div className="mt-2 h-3 w-full overflow-hidden rounded-full bg-zinc-200/80 dark:bg-zinc-800/80">
            <div
              className="h-full rounded-full bg-gradient-to-r from-teal-500 to-emerald-500 transition-all duration-500"
              style={{
                width: `${batchStatus.total ? (batchStatus.done / batchStatus.total) * 100 : 0}%`,
              }}
            />
          </div>
          {batchStatus.staleUploading && batchStatus.staleUploading.length > 0 && (
            <div className="mt-4 rounded-xl border border-orange-300 bg-orange-50 px-4 py-3 text-sm text-orange-950 dark:border-orange-800 dark:bg-orange-950/40 dark:text-orange-100">
              <p className="font-bold">These accounts look stuck “uploading” too long</p>
              <ul className="mt-2 list-inside list-disc space-y-1">
                {batchStatus.staleUploading.map((s, i) => (
                  <li key={i}>
                    @{s.accountUsername} (~{s.minutesStuckApprox} min) — the worker may have crashed or lost the
                    video. Check this server’s logs or History; you may need to upload again.
                  </li>
                ))}
              </ul>
            </div>
          )}
          {batchStatus.failedDetails && batchStatus.failedDetails.length > 0 && (
            <div className="mt-4 rounded-xl border border-amber-300 bg-amber-50/90 px-4 py-3 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/35 dark:text-amber-100">
              <p className="font-bold">Problems on some accounts (not silent — read below)</p>
              <ul className="mt-2 space-y-2">
                {batchStatus.failedDetails.map((f, i) => (
                  <li key={i} className="rounded-lg bg-white/60 px-3 py-2 dark:bg-zinc-900/40">
                    <span className="font-semibold">@{f.accountUsername}</span>
                    <span className="mt-1 block text-[13px] leading-snug">{f.friendlyMessage}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      {batchStatus?.complete && (
        <div
          className={`mt-8 rounded-2xl border px-5 py-4 text-sm font-semibold ${
            batchStatus.failed > 0
              ? "border-amber-300/90 bg-amber-50/90 text-amber-950 dark:border-amber-900/50 dark:bg-amber-950/35 dark:text-amber-100"
              : "border-emerald-200/90 bg-emerald-50/90 text-emerald-900 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-200"
          }`}
        >
          {batchStatus.failed === 0 ? (
            <p>Finished: all {batchStatus.success} upload(s) succeeded.</p>
          ) : (
            <div>
              <p>
                Finished: {batchStatus.success} succeeded, {batchStatus.failed} failed (out of {batchStatus.total}).
              </p>
              {batchStatus.failedDetails && batchStatus.failedDetails.length > 0 && (
                <ul className="mt-3 space-y-2 font-normal">
                  {batchStatus.failedDetails.map((f, i) => (
                    <li key={i} className="rounded-lg bg-white/70 px-3 py-2 text-[13px] leading-snug dark:bg-zinc-900/50">
                      <span className="font-semibold">@{f.accountUsername}:</span> {f.friendlyMessage}
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-3 text-xs font-normal opacity-90">
                Open History for a full log. Technical codes are stored for admins.
              </p>
            </div>
          )}
        </div>
      )}

      {msg && (
        <div
          className={`mt-6 rounded-xl border px-4 py-3 text-sm font-medium ${
            msg.includes("failed") || msg.includes("Choose")
              ? "border-red-200 bg-red-50 text-red-800 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-200"
              : "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-200"
          }`}
        >
          {msg}
        </div>
      )}
    </div>
  );
}
