/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { logAccountsListLoaded } from "@/lib/accountsListMeta";
import { fetchAllAccountsForSelectors } from "@/lib/fetchAccountsClient";

type Account = { id: string; username: string; hasSession?: boolean; status?: string };

type CampaignProgress = {
  uploadId: string;
  status: string;
  createdAt: string;
  videoCount: number;
  accountCount: number;
  accountUsernames: string[];
  parallelism: number;
  captionMode: string;
  musicQuery: string | null;
  repeatForever: boolean;
  maxCycles: number | null;
  currentCycle: number;
  cycleGapSeconds: number;
  wave: { start: number; size: number; finished: number };
  jobs: {
    total: number;
    totalExpectedThisCycle: number;
    success: number;
    failed: number;
    uploading: number;
    pending: number;
  };
};

export default function CampaignPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [activeCampaigns, setActiveCampaigns] = useState<CampaignProgress[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [captions, setCaptions] = useState("");
  const [musicQuery, setMusicQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [parallelism, setParallelism] = useState(5);
  const [staggerSeconds, setStaggerSeconds] = useState(0);
  const [cycleGapSeconds, setCycleGapSeconds] = useState(120);
  const [repeatForever, setRepeatForever] = useState(true);
  /** Full passes when repeat forever is off (1 = once). */
  const [maxCycles, setMaxCycles] = useState(1);
  const [shufflePerAccount, setShufflePerAccount] = useState(false);
  const [captionMode, setCaptionMode] = useState<"same" | "per_video" | "ai_unique_each">("per_video");
  const [scheduledStartAt, setScheduledStartAt] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showCampaigns, setShowCampaigns] = useState(false);
  const addVideosInputRef = useRef<HTMLInputElement>(null);

  const fetchProgress = useCallback(async () => {
    try {
      const r = await fetch("/api/campaign/progress");
      if (r.ok) setActiveCampaigns(await r.json());
    } catch {}
  }, []);

  const stopCampaign = async (uploadId: string) => {
    if (!confirm("Stop this campaign?")) return;
    const r = await fetch("/api/campaign/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uploadId }),
    });
    if (r.ok) fetchProgress();
  };

  const stopAllCampaigns = async () => {
    if (!confirm(`Stop all ${activeCampaigns.length} active campaigns?`)) return;
    const r = await fetch("/api/campaign/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stopAll: true }),
    });
    if (r.ok) fetchProgress();
  };

  useEffect(() => {
    fetchProgress();
    const iv = setInterval(fetchProgress, 30000);
    return () => clearInterval(iv);
  }, [fetchProgress]);

  const previewUrls = useMemo(() => files.map((f) => URL.createObjectURL(f)), [files]);
  useEffect(() => {
    return () => previewUrls.forEach((u) => URL.revokeObjectURL(u));
  }, [previewUrls]);

  const addVideosFromPicker = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files || []);
    if (picked.length) setFiles((prev) => [...prev, ...picked]);
    e.target.value = "";
  };

  const removeVideoAt = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  };

  useEffect(() => {
    void (async () => {
      const { res, data } = await fetchAllAccountsForSelectors();
      if (res.status === 401) {
        window.location.href = "/login";
        return;
      }
      if (res.ok) {
        const list = data.accounts ?? [];
        setAccounts(
          list
            .filter((a: any) => a.status !== "expired")
            .map((a: any) => ({
              id: a.id,
              username: a.username,
              hasSession: a.hasSession,
              status: a.status,
            }))
        );
        logAccountsListLoaded(
          {
            accounts: list,
            linkedCount: data.linkedCount,
            totalInDatabase: data.totalInDatabase,
            listScope: data.listScope,
            maxLinkedAccounts: data.maxLinkedAccounts,
            listTotal: data.listTotal,
          },
          "campaign page"
        );
      }
    })();
  }, []);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (files.length === 0 || selected.size === 0) {
      setMsg("Add videos and select at least one account.");
      return;
    }
    if (captionMode !== "ai_unique_each" && !captions.trim()) {
      setMsg("Enter caption(s) or choose AI unique mode.");
      return;
    }

    setLoading(true);
    setMsg(null);

    const form = new FormData();
    for (const f of files) {
      form.append("videos", f);
    }
    form.append("accountIds", JSON.stringify([...selected]));
    const capLines = captions
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (captionMode === "per_video" && capLines.length > 1) {
      form.append("captions", JSON.stringify(capLines));
    } else if (captionMode === "ai_unique_each" && capLines.length === 0) {
      form.append("captions", JSON.stringify([]));
    } else {
      form.append("captions", JSON.stringify(capLines.length ? capLines : [captions.trim()]));
    }
    const mq = musicQuery.trim();
    if (mq) form.append("musicQuery", mq);

    form.append("parallelism", String(parallelism));
    form.append("staggerSeconds", String(staggerSeconds));
    form.append("cycleGapSeconds", String(cycleGapSeconds));
    form.append("repeatForever", repeatForever ? "1" : "0");
    form.append("maxCycles", String(Math.max(1, Math.min(10000, maxCycles))));
    form.append("shufflePerAccount", shufflePerAccount ? "1" : "0");
    form.append("captionMode", captionMode);
    if (scheduledStartAt.trim()) form.append("scheduledStartAt", new Date(scheduledStartAt).toISOString());

    const res = await fetch("/api/campaign", { method: "POST", body: form });
    const data = await res.json();
    setLoading(false);
    if (res.ok) {
      const cap =
        typeof data.serverParallelCap === "number" && typeof data.effectiveParallelism === "number"
          ? ` Effective concurrent jobs per wave: ${data.effectiveParallelism} (server cap ${data.serverParallelCap}${data.effectiveParallelism < data.parallelism ? " — raise UPLOAD_PARALLEL_BATCH_SIZE in .env to match your parallelism setting" : ""}).`
          : "";
      setMsg(
        `Campaign started: ${data.videoCount} videos × ${data.accountCount} accounts, parallelism ${data.parallelism}.${cap} uploadId=${data.uploadId}. Repeat: ${
          data.repeatForever ? "forever" : `${data.maxCycles ?? 1} full pass(es)`
        }.`
      );
      setFiles([]);
      setCaptions("");
      setMusicQuery("");
      fetchProgress();
    } else {
      setMsg(data.error || "Failed");
    }
  };

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <PageHeader
        eyebrow="Automation"
        title="Multi-video campaign"
        description="Upload several videos, pick accounts in order, set parallelism (waves of accounts), optional shuffle per account, captions, and optional repeats (a set number of full passes or forever) with a gap between cycles. Each account posts all its videos in sequence on one browser tab; the next wave runs when those finish."
      />

      {activeCampaigns.length > 0 && (
        <div className="mb-8 space-y-4">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowCampaigns((v) => !v)}
              className="flex flex-1 items-center justify-between rounded-xl bg-violet-50 px-4 py-3 text-left transition hover:bg-violet-100 dark:bg-violet-950/40 dark:hover:bg-violet-950/60"
            >
              <span className="text-lg font-bold text-zinc-900 dark:text-white">
                Active campaigns
                <span className="ml-2 inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-violet-600 px-1.5 text-[0.65rem] font-bold leading-none text-white">
                  {activeCampaigns.length}
                </span>
              </span>
              <span className={`text-sm text-violet-600 transition-transform dark:text-violet-400 ${showCampaigns ? "rotate-180" : ""}`}>
                ▼
              </span>
            </button>
            {showCampaigns && (
              <button
                type="button"
                onClick={stopAllCampaigns}
                className="shrink-0 rounded-xl bg-red-600 px-4 py-3 text-sm font-bold text-white shadow transition hover:bg-red-700"
              >
                Stop all
              </button>
            )}
          </div>
          {showCampaigns && activeCampaigns.map((c) => {
            const { jobs } = c;
            const done = jobs.success + jobs.failed;
            const total = jobs.total || 1;
            const pctDone = Math.round((done / total) * 100);
            const pctSuccess = Math.round((jobs.success / total) * 100);
            const pctFailed = Math.round((jobs.failed / total) * 100);
            const pctUploading = Math.round((jobs.uploading / total) * 100);

            return (
              <div
                key={c.uploadId}
                className="rounded-2xl border border-zinc-200/90 bg-[var(--card)] p-5 shadow-lg dark:border-zinc-800"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-bold text-zinc-900 dark:text-white">
                      {c.videoCount} videos &times; {c.accountCount} accounts
                      <span className="ml-2 text-xs font-normal text-zinc-500 dark:text-zinc-400">
                        {c.uploadId}
                      </span>
                    </p>
                    <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                      Cycle {c.currentCycle + 1}
                      {c.repeatForever ? " (repeat forever)" : ` / ${c.maxCycles}`}
                      {" · "}Wave {Math.floor(c.wave.start / c.parallelism) + 1} ({c.wave.finished}/{c.wave.size} accounts done)
                      {" · "}Parallelism {c.parallelism}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="rounded-full bg-violet-100 px-2.5 py-0.5 text-xs font-bold text-violet-800 dark:bg-violet-950 dark:text-violet-300">
                      {c.status}
                    </span>
                    <button
                      type="button"
                      onClick={() => stopCampaign(c.uploadId)}
                      className="rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-bold text-red-700 transition hover:bg-red-600 hover:text-white dark:bg-red-950 dark:text-red-300 dark:hover:bg-red-600 dark:hover:text-white"
                    >
                      Stop
                    </button>
                  </div>
                </div>

                <div className="mt-3">
                  <div className="mb-1.5 flex items-baseline justify-between text-xs">
                    <span className="font-semibold text-zinc-700 dark:text-zinc-300">
                      {pctDone}% complete
                    </span>
                    <span className="text-zinc-500 dark:text-zinc-400">
                      {done} / {total} jobs
                    </span>
                  </div>
                  <div className="h-3 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
                    <div className="flex h-full">
                      {pctSuccess > 0 && (
                        <div
                          className="bg-emerald-500 transition-all duration-500"
                          style={{ width: `${pctSuccess}%` }}
                        />
                      )}
                      {pctFailed > 0 && (
                        <div
                          className="bg-red-500 transition-all duration-500"
                          style={{ width: `${pctFailed}%` }}
                        />
                      )}
                      {pctUploading > 0 && (
                        <div
                          className="animate-pulse bg-amber-400 transition-all duration-500"
                          style={{ width: `${pctUploading}%` }}
                        />
                      )}
                    </div>
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap gap-3 text-xs">
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block h-2.5 w-2.5 rounded-full bg-emerald-500" />
                    <span className="font-medium text-zinc-700 dark:text-zinc-300">{jobs.success} success</span>
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block h-2.5 w-2.5 rounded-full bg-red-500" />
                    <span className="font-medium text-zinc-700 dark:text-zinc-300">{jobs.failed} failed</span>
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block h-2.5 w-2.5 animate-pulse rounded-full bg-amber-400" />
                    <span className="font-medium text-zinc-700 dark:text-zinc-300">{jobs.uploading} uploading</span>
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block h-2.5 w-2.5 rounded-full bg-zinc-400" />
                    <span className="font-medium text-zinc-700 dark:text-zinc-300">{jobs.pending} pending</span>
                  </span>
                </div>

                {c.accountUsernames.length > 0 && (
                  <p className="mt-2 truncate text-xs text-zinc-500 dark:text-zinc-400">
                    Accounts: {c.accountUsernames.join(", ")}
                    {c.accountCount > c.accountUsernames.length && ` +${c.accountCount - c.accountUsernames.length} more`}
                  </p>
                )}

                <p className="mt-1 text-[0.65rem] text-zinc-400 dark:text-zinc-500">
                  Started {new Date(c.createdAt).toLocaleString()}
                </p>
              </div>
            );
          })}
        </div>
      )}



      <form onSubmit={submit} className="space-y-8">
        <section className="rounded-2xl border border-zinc-200/90 bg-[var(--card)] p-6 shadow-lg dark:border-zinc-800">
          <h2 className="text-lg font-bold text-zinc-900 dark:text-white">Videos (order = A,B,C,…)</h2>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            First clip = video 0, second = video 1, … Preview order is upload order. Shuffle reorders per account.
          </p>

          <input
            ref={addVideosInputRef}
            type="file"
            accept="video/mp4,video/*,.mp4"
            multiple
            className="sr-only"
            aria-hidden
            tabIndex={-1}
            onChange={addVideosFromPicker}
          />

          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
            {files.map((file, i) => (
              <div
                key={`${file.name}-${file.size}-${file.lastModified}-${i}`}
                className="relative aspect-video overflow-hidden rounded-xl border border-zinc-200/90 bg-zinc-950 shadow-inner dark:border-zinc-700"
              >
                <video
                  src={previewUrls[i]}
                  className="h-full w-full object-cover"
                  muted
                  playsInline
                  preload="metadata"
                  onMouseEnter={(e) => e.currentTarget.play().catch(() => {})}
                  onMouseLeave={(e) => {
                    e.currentTarget.pause();
                    e.currentTarget.currentTime = 0;
                  }}
                />
                <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-2 pb-7 pt-6">
                  <p className="truncate text-[0.65rem] font-medium text-white/95" title={file.name}>
                    {i + 1}. {file.name}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => removeVideoAt(i)}
                  className="absolute right-1.5 top-1.5 flex h-8 w-8 items-center justify-center rounded-full bg-black/55 text-white shadow-md backdrop-blur-sm transition hover:bg-red-600"
                  aria-label={`Remove ${file.name}`}
                >
                  <span className="text-lg leading-none">×</span>
                </button>
              </div>
            ))}

            <button
              type="button"
              onClick={() => addVideosInputRef.current?.click()}
              aria-label="Add video files"
              className="flex aspect-video flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-zinc-300 bg-zinc-50/80 text-zinc-500 transition hover:border-violet-400 hover:bg-violet-50/50 hover:text-violet-700 dark:border-zinc-600 dark:bg-zinc-900/40 dark:text-zinc-400 dark:hover:border-violet-500 dark:hover:bg-violet-950/30 dark:hover:text-violet-300"
            >
              <span className="text-3xl font-light leading-none">+</span>
              <span className="px-2 text-center text-xs font-semibold">Add videos</span>
            </button>
          </div>

          <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-300">
            {files.length === 0 ? "No videos yet — click the box to choose files." : `${files.length} video(s) in queue.`}
          </p>
        </section>

        <section className="rounded-2xl border border-zinc-200/90 bg-[var(--card)] p-6 shadow-lg dark:border-zinc-800">
          <h2 className="text-lg font-bold text-zinc-900 dark:text-white">Captions &amp; sound</h2>
          <div className="mt-3 space-y-3">
            <label className="block text-xs font-semibold text-zinc-600 dark:text-zinc-400">
              Caption mode
              <select
                className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                value={captionMode}
                onChange={(e) => setCaptionMode(e.target.value as typeof captionMode)}
              >
                <option value="same">Same caption for every video</option>
                <option value="per_video">One caption per video (see below)</option>
                <option value="ai_unique_each">AI unique caption each upload (needs GROQ_API_KEY)</option>
              </select>
            </label>
            <textarea
              className="min-h-[100px] w-full rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              placeholder={
                captionMode === "per_video"
                  ? "One line per video (same order as files), or one line to reuse for all"
                  : "Caption text…"
              }
              value={captions}
              onChange={(e) => setCaptions(e.target.value)}
            />
            <input
              type="text"
              className="w-full rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              placeholder="Optional: one TikTok sound search for every video in this campaign"
              value={musicQuery}
              onChange={(e) => setMusicQuery(e.target.value)}
              autoComplete="off"
            />
            <p className="text-[0.7rem] leading-relaxed text-zinc-500 dark:text-zinc-400">
              Leave empty to use the uploader default (<strong>trending</strong>). The same sound applies to all videos and all accounts in the campaign.
            </p>
          </div>
        </section>

        <section className="rounded-2xl border border-zinc-200/90 bg-[var(--card)] p-6 shadow-lg dark:border-zinc-800">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold text-zinc-900 dark:text-white">Accounts (order = priority)</h2>
            <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-violet-600 dark:text-violet-400">
              <input
                type="checkbox"
                checked={accounts.length > 0 && accounts.filter((a) => a.hasSession !== false).every((a) => selected.has(a.id))}
                onChange={(e) => {
                  if (e.target.checked) {
                    setSelected(new Set(accounts.filter((a) => a.hasSession !== false).map((a) => a.id)));
                  } else {
                    setSelected(new Set());
                  }
                }}
                className="h-4 w-4 rounded"
              />
              Select all ({accounts.filter((a) => a.hasSession !== false).length})
            </label>
          </div>
          <div className="mt-4 max-h-64 overflow-y-auto rounded-xl border border-zinc-200 dark:border-zinc-700">
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {accounts.map((a) => (
                <li key={a.id}>
                  <label className="flex cursor-pointer items-center gap-3 px-3 py-2">
                    <input
                      type="checkbox"
                      checked={selected.has(a.id)}
                      disabled={a.hasSession === false}
                      onChange={() => toggle(a.id)}
                      className="h-4 w-4 rounded"
                    />
                    <span className={`font-medium ${a.hasSession === false ? "text-zinc-400 dark:text-zinc-600" : "text-zinc-900 dark:text-white"}`}>{a.username}</span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="rounded-2xl border border-zinc-200/90 bg-[var(--card)] p-6 shadow-lg dark:border-zinc-800">
          <h2 className="text-lg font-bold text-zinc-900 dark:text-white">Schedule &amp; waves</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <label className="text-xs font-semibold text-zinc-600 dark:text-zinc-400">
              Parallel accounts (browsers per wave)
              <input
                type="number"
                min={1}
                max={32}
                value={parallelism}
                onChange={(e) => setParallelism(Number(e.target.value))}
                className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
              />
            </label>
            <label className="text-xs font-semibold text-zinc-600 dark:text-zinc-400">
              Stagger between accounts in a wave (seconds)
              <input
                type="number"
                min={0}
                value={staggerSeconds}
                onChange={(e) => setStaggerSeconds(Number(e.target.value))}
                className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
              />
            </label>
            <label className="text-xs font-semibold text-zinc-600 dark:text-zinc-400">
              Gap before next cycle (seconds)
              <input
                type="number"
                min={0}
                value={cycleGapSeconds}
                onChange={(e) => setCycleGapSeconds(Number(e.target.value))}
                className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
              />
            </label>
            <label className="text-xs font-semibold text-zinc-600 dark:text-zinc-400">
              Start at (optional)
              <input
                type="datetime-local"
                value={scheduledStartAt}
                onChange={(e) => setScheduledStartAt(e.target.value)}
                className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
              />
            </label>
          </div>
          <p className="mt-3 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
            <strong className="text-zinc-700 dark:text-zinc-300">Parallel accounts</strong> is how many accounts are eligible to run at once per wave.{" "}
            <strong className="text-zinc-700 dark:text-zinc-300">Stagger</strong> used to delay the 2nd, 3rd… account in a wave, which blocked parallel claims until each delay passed. When parallelism is greater than 1, stagger within a wave is ignored so every account in the wave can start together; use stagger 0 for clarity.
          </p>
          <label className="mt-4 flex items-center gap-2 text-sm font-medium text-zinc-800 dark:text-zinc-200">
            <input
              type="checkbox"
              checked={shufflePerAccount}
              onChange={(e) => setShufflePerAccount(e.target.checked)}
            />
            Shuffle video order per account (e.g. A,B,C,D,E → random order per account)
          </label>
          <label className="mt-2 flex items-center gap-2 text-sm font-medium text-zinc-800 dark:text-zinc-200">
            <input
              type="checkbox"
              checked={repeatForever}
              onChange={(e) => setRepeatForever(e.target.checked)}
            />
            Repeat forever (unlimited full passes; gap applies between passes)
          </label>
          <label className="mt-3 block text-xs font-semibold text-zinc-600 dark:text-zinc-400">
            Full campaign runs (when not repeating forever)
            <input
              type="number"
              min={1}
              max={10000}
              disabled={repeatForever}
              value={maxCycles}
              onChange={(e) => setMaxCycles(Math.max(1, Math.min(10000, Number(e.target.value) || 1)))}
              className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900"
            />
            <span className="mt-1 block font-normal text-zinc-500 dark:text-zinc-400">
              One run = every account posts every video once. Use <strong className="text-zinc-700 dark:text-zinc-300">2</strong> for two complete passes, etc. Gap above waits between passes.
            </span>
          </label>
        </section>

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-2xl bg-gradient-to-r from-rose-600 to-violet-600 py-4 font-bold text-white shadow-lg disabled:opacity-50"
        >
          {loading ? "Starting…" : "Start campaign"}
        </button>
      </form>

      {msg && (
        <div className="mt-6 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100">
          {msg}
        </div>
      )}

      <p className="mt-8 text-center text-sm text-zinc-500">
        <Link href="/upload" className="text-violet-600 underline">
          Single-video upload
        </Link>{" "}
        · Track progress on History.
      </p>
    </div>
  );
}
