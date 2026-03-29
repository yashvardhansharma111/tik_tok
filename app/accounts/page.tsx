"use client";

import { useEffect, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { ConnectTikTok } from "@/components/ConnectTikTok";

type Account = { id: string; username: string; proxy?: string; status: string; hasSession: boolean };

export default function AccountsPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [captureUser, setCaptureUser] = useState("");
  const [captureProxy, setCaptureProxy] = useState("");
  const [captureBusy, setCaptureBusy] = useState(false);
  const [interactiveAllowed, setInteractiveAllowed] = useState(true);

  const [importUser, setImportUser] = useState("");
  const [importProxy, setImportProxy] = useState("");
  const [importJson, setImportJson] = useState("");
  const [importBusy, setImportBusy] = useState(false);

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

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/session/capture-eligibility");
      if (!res.ok) return;
      const data = (await res.json()) as { interactiveAllowed?: boolean };
      if (typeof data.interactiveAllowed === "boolean") setInteractiveAllowed(data.interactiveAllowed);
    })();
  }, []);

  const captureSession = async () => {
    if (!interactiveAllowed) return;
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
      alert("Session from your local Playwright run was saved. (Captured on this machine — not on a remote server.)");
    } finally {
      setCaptureBusy(false);
    }
  };

  const importSession = async () => {
    const u = importUser.trim();
    if (!u) return alert("Enter account label / username");
    const raw = importJson.trim();
    if (!raw) return alert("Paste TikTok storageState JSON");
    try {
      JSON.parse(raw);
    } catch {
      return alert("Invalid JSON — export storageState from Playwright or your browser tooling");
    }
    setImportBusy(true);
    try {
      const res = await fetch("/api/accounts/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: u, session: raw, proxy: importProxy.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || "Import failed");
        return;
      }
      setImportUser("");
      setImportProxy("");
      setImportJson("");
      await load();
      alert(
        "A copy of the session was stored for server-side uploads. The export file stays on your computer — re-export if you rotate passwords."
      );
    } finally {
      setImportBusy(false);
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
        description="Creating and exporting a TikTok session happens on your local computer only — a remote server cannot log in to TikTok in a browser for you. Optional: paste JSON below to store a copy for automated uploads. Use Upload and Rename from the sidebar as usual."
      />

      <div
        className="mb-8 rounded-2xl border border-indigo-200/90 bg-indigo-50/95 px-5 py-4 text-sm leading-relaxed text-indigo-950 shadow-md shadow-indigo-200/20 dark:border-indigo-900/50 dark:bg-indigo-950/50 dark:text-indigo-100 dark:shadow-black/20"
        role="note"
      >
        <p className="font-semibold text-indigo-950 dark:text-white">Sessions are created on your local machine, not on the server</p>
        <p className="mt-2 text-indigo-900/90 dark:text-indigo-200/90">
          Playwright capture and browser export only run where you have a real desktop (your PC, <code className="rounded bg-white/80 px-1 font-mono text-xs dark:bg-zinc-800">npm run dev</code>
          ). A production VPS does not save your TikTok login from a browser. Use <strong>Import session</strong> only to
          upload a <em>copy</em> of JSON you exported locally so background uploads can use it.
        </p>
      </div>

      <div className="mb-8 flex flex-wrap items-center gap-3">
        <ConnectTikTok />
        <span className="max-w-xl text-sm text-zinc-600 dark:text-zinc-400">
          Opens TikTok on <strong>this device</strong> only — no session is sent to the server from this button. Use Import
          afterward if you need automation.
        </span>
      </div>

      <div className="rounded-2xl border border-emerald-200/90 bg-gradient-to-br from-emerald-50 via-teal-50/80 to-zinc-50/60 p-6 shadow-lg shadow-emerald-200/15 dark:border-emerald-900/40 dark:from-emerald-950/40 dark:via-zinc-900 dark:to-zinc-950/40">
        <h2 className="text-lg font-bold text-emerald-950 dark:text-emerald-100">Import session (copy for server uploads)</h2>
        <p className="mt-2 text-sm leading-relaxed text-emerald-900/85 dark:text-emerald-200/80">
          Export <strong>Playwright storageState</strong> JSON on <strong>your computer</strong> while logged into TikTok,
          then paste it here. This stores a <strong>copy</strong> in the app database so upload workers can run — the
          original export file stays on your machine.
        </p>
        <div className="mt-4 flex flex-col gap-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
            <input
              className={`${inputClass} min-w-[12rem] flex-1`}
              placeholder="Account label / @username"
              value={importUser}
              onChange={(e) => setImportUser(e.target.value)}
              disabled={importBusy}
            />
            <input
              className={`${inputClass} min-w-[12rem] flex-1`}
              placeholder="Proxy (optional)"
              value={importProxy}
              onChange={(e) => setImportProxy(e.target.value)}
              disabled={importBusy}
            />
          </div>
          <textarea
            className={`${inputClass} min-h-[140px] font-mono text-xs`}
            placeholder='{ "cookies": [ ... ], "origins": [ ... ] }'
            value={importJson}
            onChange={(e) => setImportJson(e.target.value)}
            disabled={importBusy}
          />
          <button
            type="button"
            className="w-fit rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 px-6 py-3 text-sm font-bold text-white shadow-lg shadow-emerald-600/25 transition hover:brightness-110 disabled:opacity-50"
            disabled={importBusy}
            onClick={() => void importSession()}
          >
            {importBusy ? "Saving copy…" : "Save pasted copy for uploads"}
          </button>
        </div>
      </div>

      <div className="mt-8 rounded-2xl border border-amber-200/90 bg-gradient-to-br from-amber-50 via-orange-50/80 to-rose-50/60 p-6 shadow-lg shadow-amber-200/20 dark:border-amber-900/40 dark:from-amber-950/50 dark:via-zinc-900 dark:to-rose-950/30 dark:shadow-black/30">
        <h2 className="text-lg font-bold text-amber-950 dark:text-amber-100">Capture session (Playwright — local machine only)</h2>
        <p className="mt-2 text-sm leading-relaxed text-amber-900/80 dark:text-amber-200/80">
          Runs only on <strong>your computer</strong> where <code className="rounded-md bg-white/70 px-1.5 py-0.5 font-mono text-xs dark:bg-zinc-800">npm run dev</code> runs —{" "}
          <strong>not</strong> on a remote server. A browser window opens here; you log in; the session is written from{" "}
          <strong>this machine</strong>. Do not rely on this on a headless VPS unless you use a display/xvfb and{" "}
          <code className="rounded-md bg-white/70 px-1 font-mono text-xs dark:bg-zinc-800">ALLOW_INTERACTIVE_SESSION_CAPTURE</code>.
        </p>
        {!interactiveAllowed && (
          <p className="mt-3 rounded-lg border border-amber-300/80 bg-amber-100/80 px-3 py-2 text-sm font-medium text-amber-950 dark:border-amber-700 dark:bg-amber-950/50 dark:text-amber-100">
            Interactive capture is off on this server. Export session on your <strong>local</strong> dev machine, then use{" "}
            <strong>Import session</strong> here.
          </p>
        )}
        <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
          <input
            className={`${inputClass} min-w-[12rem] flex-1`}
            placeholder="Account label / username"
            value={captureUser}
            onChange={(e) => setCaptureUser(e.target.value)}
            disabled={captureBusy || !interactiveAllowed}
          />
          <input
            className={`${inputClass} min-w-[12rem] flex-1`}
            placeholder="Proxy (optional)"
            value={captureProxy}
            onChange={(e) => setCaptureProxy(e.target.value)}
            disabled={captureBusy || !interactiveAllowed}
          />
          <button
            type="button"
            className="rounded-xl bg-gradient-to-r from-amber-600 to-orange-600 px-6 py-3 text-sm font-bold text-white shadow-lg shadow-amber-600/30 transition hover:brightness-110 disabled:opacity-50"
            disabled={captureBusy || !interactiveAllowed}
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
