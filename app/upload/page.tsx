/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { PageHeader } from "@/components/PageHeader";

type Account = { id: string; username: string; hasSession?: boolean };

export default function UploadPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [caption, setCaption] = useState("");
  const [musicQuery, setMusicQuery] = useState("");
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [file, setFile] = useState<File | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [batchUploadId, setBatchUploadId] = useState<string | null>(null);
  const [batchStatus, setBatchStatus] = useState<{
    total: number;
    done: number;
    accountsRemaining: number;
    estimatedSecondsRemaining: number;
    complete: boolean;
  } | null>(null);

  useEffect(() => {
    fetch("/api/accounts").then(async (r) => {
      if (r.status === 401) {
        window.location.href = "/login";
        return;
      }
      const data = await r.json();
      if (r.ok)
        setAccounts(
          data.map((a: any) => ({
            id: a.id,
            username: a.username,
            hasSession: a.hasSession,
          }))
        );
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
        done: data.done,
        accountsRemaining: data.accountsRemaining,
        estimatedSecondsRemaining: data.estimatedSecondsRemaining,
        complete: data.complete,
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

    const res = await fetch("/api/upload", { method: "POST", body: form });
    const data = await res.json();
    setLoading(false);
    if (res.ok && data.uploadId) {
      setBatchUploadId(data.uploadId);
      setBatchStatus({
        total: data.processed,
        done: 0,
        accountsRemaining: data.processed,
        estimatedSecondsRemaining: data.processed * 90,
        complete: false,
      });
    }
    setMsg(
      res.ok
        ? `Started upload to ${data.processed} account(s). Music query: ${data.musicQuery || "default (trending)"}. Progress updates below.`
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
        description="Pick your video and caption, then choose which linked accounts should post the same clip. Each selected account runs automation in its own browser context using its saved session."
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
                  Tap cards to select. Upload runs once per selected account (multi-post).
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
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

          <div className="mt-2 flex items-center justify-between text-sm">
            <span className="font-semibold text-rose-600 dark:text-rose-400">
              {selected.size} of {accounts.length} selected
            </span>
            {accounts.length === 0 && (
              <Link
                href="/accounts"
                className="font-semibold text-violet-600 underline decoration-violet-400/50 underline-offset-2 hover:text-violet-500 dark:text-violet-400"
              >
                Add accounts first →
              </Link>
            )}
          </div>

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
            <div className="mt-6 grid gap-3 sm:grid-cols-2">
              {accounts.map((a) => {
                const on = selected.has(a.id);
                const noSession = a.hasSession === false;
                return (
                  <button
                    key={a.id}
                    type="button"
                    disabled={noSession}
                    onClick={() => toggle(a.id)}
                    className={`flex items-center gap-4 rounded-xl border-2 px-4 py-4 text-left transition ${
                      noSession
                        ? "cursor-not-allowed border-zinc-200/60 opacity-50 dark:border-zinc-800"
                        : on
                          ? "border-rose-500 bg-gradient-to-br from-rose-500/10 to-violet-500/10 shadow-md shadow-rose-500/10 ring-2 ring-rose-500/30 dark:border-rose-400 dark:ring-rose-400/25"
                          : "border-zinc-200/80 bg-zinc-50/50 hover:border-zinc-300 hover:bg-white dark:border-zinc-700 dark:bg-zinc-900/40 dark:hover:border-zinc-600"
                    }`}
                  >
                    <span
                      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full border-2 text-sm font-bold ${
                        on
                          ? "border-rose-600 bg-rose-600 text-white"
                          : "border-zinc-300 bg-transparent text-transparent dark:border-zinc-600"
                      }`}
                    >
                      {on ? "✓" : " "}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-bold text-zinc-900 dark:text-white">{a.username}</p>
                      <p className="text-xs text-zinc-500 dark:text-zinc-400">
                        {noSession ? "No session — fix on Accounts" : "Session ready"}
                      </p>
                    </div>
                  </button>
                );
              })}
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
        <div className="mt-8 rounded-2xl border border-teal-200/90 bg-teal-50/80 p-5 shadow-md dark:border-teal-900/50 dark:bg-teal-950/30">
          <p className="text-sm font-bold text-teal-900 dark:text-teal-100">Batch progress</p>
          <div className="mt-3 flex flex-wrap justify-between gap-2 text-xs font-semibold text-teal-800 dark:text-teal-200">
            <span>
              Accounts remaining: {batchStatus.accountsRemaining} / {batchStatus.total}
            </span>
            <span>
              ~{Math.ceil(batchStatus.estimatedSecondsRemaining / 60)} min left (estimate)
            </span>
          </div>
          <div className="mt-2 h-3 w-full overflow-hidden rounded-full bg-teal-200/80 dark:bg-teal-900/50">
            <div
              className="h-full rounded-full bg-gradient-to-r from-teal-500 to-emerald-500 transition-all duration-500"
              style={{
                width: `${batchStatus.total ? ((batchStatus.total - batchStatus.accountsRemaining) / batchStatus.total) * 100 : 0}%`,
              }}
            />
          </div>
        </div>
      )}
      {batchStatus?.complete && (
        <div className="mt-8 rounded-2xl border border-emerald-200/90 bg-emerald-50/90 px-5 py-4 text-sm font-semibold text-emerald-900 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-200">
          All uploads in this batch finished ({batchStatus.done}/{batchStatus.total}).
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
