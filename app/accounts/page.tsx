"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { ConnectTikTok } from "@/components/ConnectTikTok";
import { AccountsListExplain } from "@/components/AccountsListExplain";
import { logAccountsListLoaded } from "@/lib/accountsListMeta";
import {
  ACCOUNTS_LIST_DEFAULT_LIMIT,
  fetchAccountsPage,
  fetchAllAccountsForSelectors,
} from "@/lib/fetchAccountsClient";

type Account = { id: string; username: string; previousUsername?: string; proxy?: string; status: string; hasSession: boolean };
type Tab = "active" | "expired" | "health";

/**
 * A single key:value row with a "Copy" button. Used in the GoLogin paste-flow
 * modal to let the user one-click copy each proxy credential.
 */
function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      alert("Clipboard blocked. Select and copy manually.");
    }
  };
  return (
    <div className="flex items-center gap-2">
      <span className="w-44 shrink-0 text-indigo-700 dark:text-indigo-300">{label}</span>
      <span
        className="flex-1 truncate rounded bg-indigo-50 px-2 py-1 text-zinc-900 dark:bg-indigo-950/50 dark:text-zinc-100"
        title={value}
      >
        {value}
      </span>
      <button
        type="button"
        onClick={onCopy}
        className={`shrink-0 rounded-md px-3 py-1 text-xs font-semibold transition ${
          copied
            ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300"
            : "bg-indigo-100 text-indigo-800 hover:bg-indigo-200 dark:bg-indigo-900/40 dark:text-indigo-300 dark:hover:bg-indigo-900/60"
        }`}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

type HealthResult = {
  id: string;
  username: string;
  previousStatus: string;
  currentStatus: "active" | "expired";
  changed: boolean;
  reason?: string;
};

export default function AccountsPage() {
  const [tab, setTab] = useState<Tab>("active");
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [expiredAccounts, setExpiredAccounts] = useState<Account[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(ACCOUNTS_LIST_DEFAULT_LIMIT);
  const [listTotal, setListTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [expiredPage, setExpiredPage] = useState(1);
  const [expiredListTotal, setExpiredListTotal] = useState(0);
  const [expiredTotalPages, setExpiredTotalPages] = useState(1);

  const [allAccounts, setAllAccounts] = useState<Account[]>([]);
  const [healthSelected, setHealthSelected] = useState<Set<string>>(new Set());
  const [healthBusy, setHealthBusy] = useState(false);
  const [healthResults, setHealthResults] = useState<HealthResult[] | null>(null);
  const [healthSummary, setHealthSummary] = useState<{ checked: number; active: number; expired: number; changed: number } | null>(null);
  const [healthProgress, setHealthProgress] = useState<string | null>(null);
  const [accountsListInfo, setAccountsListInfo] = useState<{
    totalInDatabase: number;
    listScope: "owner_only" | "all_in_database";
  } | null>(null);
  const [accountQuota, setAccountQuota] = useState<{
    linkedCount: number;
    maxLinkedAccounts: number | null;
  } | null>(null);
  const [captureUser, setCaptureUser] = useState("");
  const [captureProxy, setCaptureProxy] = useState("");
  const [captureBusy, setCaptureBusy] = useState(false);
  const [interactiveAllowed, setInteractiveAllowed] = useState(true);
  const [reAuthBusy, setReAuthBusy] = useState<string | null>(null);
  const [goLoginBusy, setGoLoginBusy] = useState<string | null>(null);
  const [captureGoLoginBusy, setCaptureGoLoginBusy] = useState(false);

  // ----- AdsPower one-click capture -----
  const [adspowerUsername, setAdspowerUsername] = useState("");
  const [adspowerBusy, setAdspowerBusy] = useState(false);

  // ----- Manual GoLogin paste flow -----
  const [gologinPasteUsername, setGoLoginPasteUsername] = useState("");
  const [gologinPasteBusy, setGoLoginPasteBusy] = useState(false);
  const [gologinPasteInfo, setGoLoginPasteInfo] = useState<{
    accountId: string;
    username: string;
    created: boolean;
    proxy: { host: string; port: number; username: string; password: string };
  } | null>(null);
  const [gologinPasteCookies, setGoLoginPasteCookies] = useState("");
  const [gologinImportBusy, setGoLoginImportBusy] = useState(false);

  const [importUser, setImportUser] = useState("");
  const [importProxy, setImportProxy] = useState("");
  const [importJson, setImportJson] = useState("");
  const [importBusy, setImportBusy] = useState(false);

  const load = useCallback(async (opts?: { page?: number; pageSize?: number }) => {
    const p = opts?.page ?? page;
    const ps = opts?.pageSize ?? pageSize;
    const { res, data } = await fetchAccountsPage(p, ps, "active");
    if (res.status === 401) {
      window.location.href = "/login";
      return;
    }
    if (res.ok) {
      const list: Account[] = (data.accounts ?? []).map((a) => ({
        id: a.id,
        username: a.username,
        previousUsername: a.previousUsername ?? "",
        proxy: a.proxy ?? "",
        status: a.status,
        hasSession: Boolean(a.hasSession),
      }));
      setAccounts(list);
      if (typeof data.listTotal === "number") {
        const listTotalN = data.listTotal;
        const totalPagesN = typeof data.totalPages === "number" ? data.totalPages : 1;
        let nextPage = typeof data.page === "number" ? data.page : p;
        if (nextPage > totalPagesN) nextPage = totalPagesN;
        if (nextPage < 1) nextPage = 1;
        setListTotal(listTotalN);
        setTotalPages(totalPagesN);
        setPage(nextPage);
      }
      if (typeof data.totalInDatabase === "number" && (data.listScope === "owner_only" || data.listScope === "all_in_database")) {
        setAccountsListInfo({ totalInDatabase: data.totalInDatabase, listScope: data.listScope });
      } else {
        setAccountsListInfo(null);
      }
      if (typeof data.linkedCount === "number") {
        setAccountQuota({
          linkedCount: data.linkedCount,
          maxLinkedAccounts: data.maxLinkedAccounts ?? null,
        });
      } else {
        setAccountQuota(null);
      }
      logAccountsListLoaded(
        {
          accounts: list,
          linkedCount: data.linkedCount,
          totalInDatabase: data.totalInDatabase,
          listScope: data.listScope,
          maxLinkedAccounts: data.maxLinkedAccounts,
          listTotal: data.listTotal,
          page: data.page,
          totalPages: data.totalPages,
        },
        "accounts page"
      );
    }
  }, [page, pageSize]);

  const loadExpired = useCallback(async (opts?: { page?: number }) => {
    const p = opts?.page ?? expiredPage;
    const { res, data } = await fetchAccountsPage(p, pageSize, "expired");
    if (res.ok) {
      const list: Account[] = (data.accounts ?? []).map((a) => ({
        id: a.id,
        username: a.username,
        previousUsername: a.previousUsername ?? "",
        proxy: a.proxy ?? "",
        status: a.status,
        hasSession: Boolean(a.hasSession),
      }));
      setExpiredAccounts(list);
      if (typeof data.listTotal === "number") {
        setExpiredListTotal(data.listTotal);
        const tp = typeof data.totalPages === "number" ? data.totalPages : 1;
        setExpiredTotalPages(tp);
        let np = typeof data.page === "number" ? data.page : p;
        if (np > tp) np = tp;
        if (np < 1) np = 1;
        setExpiredPage(np);
      }
    }
  }, [expiredPage, pageSize]);

  const loadAllAccounts = useCallback(async () => {
    const { res, data } = await fetchAllAccountsForSelectors(undefined);
    if (res.ok) {
      setAllAccounts(
        (data.accounts ?? []).map((a) => ({
          id: a.id,
          username: a.username,
          previousUsername: a.previousUsername ?? "",
          proxy: a.proxy ?? "",
          status: a.status,
          hasSession: Boolean(a.hasSession),
        }))
      );
    }
  }, []);

  useEffect(() => {
    void load({ page, pageSize });
  }, [load, page, pageSize]);

  useEffect(() => {
    void loadExpired({ page: expiredPage });
  }, [loadExpired, expiredPage]);

  useEffect(() => {
    if (tab === "health" && allAccounts.length === 0) {
      void loadAllAccounts();
    }
  }, [tab, allAccounts.length, loadAllAccounts]);

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/session/capture-eligibility");
      if (!res.ok) return;
      const data = (await res.json()) as { interactiveAllowed?: boolean };
      if (typeof data.interactiveAllowed === "boolean") setInteractiveAllowed(data.interactiveAllowed);
    })();
  }, []);

  const runHealthCheck = async () => {
    if (healthSelected.size === 0) return alert("Select at least one account to check.");
    setHealthBusy(true);
    setHealthResults(null);
    setHealthSummary(null);
    setHealthProgress(`Checking ${healthSelected.size} account(s)…`);
    try {
      const res = await fetch("/api/check-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountIds: [...healthSelected] }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || "Health check failed");
        return;
      }
      setHealthResults(data.results ?? []);
      setHealthSummary(data.summary ?? null);
      setHealthProgress(null);
      void load({ page, pageSize });
      void loadExpired({ page: expiredPage });
      void loadAllAccounts();
    } finally {
      setHealthBusy(false);
    }
  };

  /**
   * Capture session via an already-running GoLogin profile.
   * Prerequisite: the user has launched their GoLogin profile with --remote-debugging-port=9222
   * (or whichever port GOLOGIN_CDP_ENDPOINT points to in .env).
   *
   * On click: server attaches via CDP, opens TikTok login in the GoLogin window,
   * waits for the user to complete login, then auto-saves session + proxy into
   * the gologin_accounts collection. The upload runner will pick it up automatically.
   */
  const goLoginCapture = async (account: Account) => {
    const ok = confirm(
      `Capture ${account.username} via GoLogin?\n\n` +
      `Before clicking OK:\n` +
      `1. Open this account's GoLogin profile\n` +
      `2. Make sure it's running with --remote-debugging-port=9222\n\n` +
      `Then complete the TikTok login in the GoLogin window when it opens.`
    );
    if (!ok) return;
    setGoLoginBusy(account.id);
    try {
      const res = await fetch("/api/gologin/capture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: account.id }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert((data as { hint?: string; error?: string }).hint || data.error || "GoLogin capture failed");
        return;
      }
      await load({ page, pageSize });
      await loadExpired({ page: expiredPage });
      const d = data as { username?: string; cookieCount?: number; proxyHost?: string };
      alert(
        `Session captured via GoLogin.\n\n` +
        `  account: ${d.username ?? account.username}\n` +
        `  cookies: ${d.cookieCount ?? "?"}\n` +
        `  proxy:   ${d.proxyHost ?? "?"}\n\n` +
        `Upload runner will use this session automatically.`
      );
    } catch (e) {
      alert("GoLogin capture error: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setGoLoginBusy(null);
    }
  };

  const reAuthCapture = async (account: Account) => {
    if (!interactiveAllowed) return;
    setReAuthBusy(account.id);
    try {
      const res = await fetch("/api/session/capture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: account.id, username: account.username, proxy: account.proxy || undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert((data as { hint?: string; error?: string }).hint || data.error || "Capture failed");
        return;
      }
      await load({ page, pageSize });
      await loadExpired({ page: expiredPage });
      alert(`Session refreshed for ${(data as { username?: string }).username ?? "account"} — it's active again.`);
    } finally {
      setReAuthBusy(null);
    }
  };

  /**
   * One-click AdsPower capture. Fully automated: creates an AdsPower profile with
   * the right sticky proxy, opens the browser, waits for login, captures session
   * natively via Playwright, saves to MongoDB, closes the browser. User only needs
   * to complete the TikTok login when the window opens.
   */
  const captureViaAdsPower = async () => {
    const u = adspowerUsername.trim();
    if (!u) return alert("Enter the TikTok username first");
    const ok = confirm(
      `Add "${u}" via AdsPower?\n\n` +
      `What will happen:\n` +
      `1. An AdsPower browser will open automatically\n` +
      `2. TikTok login page will load\n` +
      `3. Complete the login manually (captcha, 2FA if needed)\n` +
      `4. Session will be captured and saved automatically\n` +
      `5. Browser will close itself\n\n` +
      `Make sure AdsPower desktop is running.`
    );
    if (!ok) return;
    setAdspowerBusy(true);
    try {
      const res = await fetch("/api/adspower/capture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: u }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert((data as { hint?: string; error?: string }).hint || data.error || "AdsPower capture failed");
        return;
      }
      setAdspowerUsername("");
      await load({ page, pageSize });
      const d = data as { username?: string; cookieCount?: number; proxyHost?: string };
      alert(
        `Session captured via AdsPower!\n\n` +
        `  account: ${d.username ?? u}\n` +
        `  cookies: ${d.cookieCount ?? "?"}\n` +
        `  proxy:   ${d.proxyHost ?? "?"}\n\n` +
        `Upload runner will use this session automatically.`
      );
    } catch (e) {
      alert("AdsPower capture error: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setAdspowerBusy(false);
    }
  };

  /**
   * Step 1 of the manual GoLogin paste flow: generate the sticky proxy credentials
   * for a (new or existing) account so the user can paste them into GoLogin's
   * profile settings.
   */
  const generateGoLoginProxy = async () => {
    const u = gologinPasteUsername.trim();
    if (!u) return alert("Enter the TikTok username first");
    setGoLoginPasteBusy(true);
    try {
      const res = await fetch("/api/gologin/new-placeholder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: u }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert((data as { hint?: string; error?: string }).hint || data.error || "Failed to generate proxy");
        return;
      }
      setGoLoginPasteInfo(data as {
        accountId: string;
        username: string;
        created: boolean;
        proxy: { host: string; port: number; username: string; password: string };
      });
    } catch (e) {
      alert("Error: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setGoLoginPasteBusy(false);
    }
  };

  /**
   * Step 2 of the manual GoLogin paste flow: send the Cookie-Editor JSON
   * export to the backend, which parses it and saves to gologin_accounts
   * using the same sticky proxy generated in step 1.
   */
  const importGoLoginSession = async () => {
    if (!gologinPasteInfo) return alert("Click 'Generate proxy' first");
    const raw = gologinPasteCookies.trim();
    if (!raw) return alert("Paste the Cookie-Editor JSON export");
    try {
      JSON.parse(raw);
    } catch {
      return alert("Invalid JSON — paste the output from Cookie-Editor's Export → JSON");
    }
    setGoLoginImportBusy(true);
    try {
      const res = await fetch("/api/gologin/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: gologinPasteInfo.accountId,
          cookiesJson: raw,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert((data as { hint?: string; error?: string }).hint || data.error || "Import failed");
        return;
      }
      const d = data as { username?: string; cookieCount?: number; proxyHost?: string };
      alert(
        `Session saved.\n\n` +
        `  account: ${d.username ?? "(unknown)"}\n` +
        `  cookies: ${d.cookieCount ?? "?"}\n` +
        `  proxy:   ${d.proxyHost ?? "?"}\n\n` +
        `Upload runner will use this session automatically.`
      );
      setGoLoginPasteInfo(null);
      setGoLoginPasteUsername("");
      setGoLoginPasteCookies("");
      await load({ page, pageSize });
    } catch (e) {
      alert("Error: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setGoLoginImportBusy(false);
    }
  };

  /**
   * Add a NEW account via a running GoLogin profile. Takes the username from the
   * "Capture session" form input, creates a placeholder legacy Account doc, then
   * runs the GoLogin capture. Unlike captureSession() this does NOT spin up a
   * Playwright browser — it attaches to your already-running GoLogin profile on
   * port 9222.
   */
  const captureSessionViaGoLogin = async () => {
    if (!captureUser.trim()) return alert("Enter username for this account");
    const ok = confirm(
      `Add "${captureUser.trim()}" via GoLogin?\n\n` +
      `Before clicking OK:\n` +
      `1. Open the GoLogin profile for this TikTok account\n` +
      `2. Make sure it's running with --remote-debugging-port=9222\n\n` +
      `Then complete the TikTok login in the GoLogin window when it opens.`
    );
    if (!ok) return;
    setCaptureGoLoginBusy(true);
    try {
      const res = await fetch("/api/gologin/capture-new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: captureUser.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert((data as { hint?: string; error?: string }).hint || data.error || "GoLogin capture failed");
        return;
      }
      setCaptureUser("");
      setCaptureProxy("");
      await load({ page, pageSize });
      const d = data as { username?: string; cookieCount?: number; proxyHost?: string; created?: boolean };
      alert(
        `${d.created ? "Created" : "Refreshed"} via GoLogin.\n\n` +
        `  account: ${d.username ?? "(unknown)"}\n` +
        `  cookies: ${d.cookieCount ?? "?"}\n` +
        `  proxy:   ${d.proxyHost ?? "?"}\n\n` +
        `Upload runner will use this session automatically.`
      );
    } catch (e) {
      alert("GoLogin capture error: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setCaptureGoLoginBusy(false);
    }
  };

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
        alert((data as { error?: string; hint?: string }).hint || data.error || "Capture failed");
        return;
      }
      setCaptureUser("");
      setCaptureProxy("");
      await load({ page, pageSize });
      alert(`Session saved for ${(data as { username?: string }).username ?? "account"} — stored in the database for uploads.`);
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
      await load({ page, pageSize });
      alert(`Session saved for ${(data as { username?: string }).username ?? "account"} in the database.`);
    } finally {
      setImportBusy(false);
    }
  };

  const remove = async (id: string) => {
    const res = await fetch(`/api/accounts/${id}`, { method: "DELETE" });
    const data = await res.json();
    if (!res.ok) return alert(data.error || "Delete failed");
    if (tab === "expired") {
      if (expiredAccounts.length <= 1 && expiredPage > 1) {
        setExpiredPage((p) => p - 1);
      } else {
        void loadExpired({ page: expiredPage });
      }
    } else {
      if (accounts.length <= 1 && page > 1) {
        setPage((p) => p - 1);
      } else {
        void load({ page, pageSize });
      }
    }
  };

  const inputClass =
    "w-full rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-900 shadow-inner outline-none transition focus:border-rose-400 focus:ring-2 focus:ring-rose-500/20 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-rose-500";

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <PageHeader
        eyebrow="Connections"
        title="TikTok accounts"
        description="Use Playwright capture to open Chromium on this app’s host, log in to TikTok, and save the session to the database for uploads. Or paste storageState JSON. Use Upload and Rename in the sidebar as usual."
      />

      <div className="mt-2 rounded-xl border border-zinc-200/80 bg-zinc-50/90 px-4 py-3 text-sm text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900/60 dark:text-zinc-300">
        <strong className="text-zinc-900 dark:text-zinc-100">Where capture runs:</strong> the same machine as your Next.js server (
        <code className="rounded bg-white px-1 font-mono text-xs dark:bg-zinc-800">npm run dev</code> or production). Chromium
        opens there; when capture finishes, the session is sent to your DB. Headless Linux servers often need{" "}
        <code className="rounded bg-white px-1 font-mono text-xs dark:bg-zinc-800">xvfb-run</code>,{" "}
        <code className="rounded bg-white px-1 font-mono text-xs dark:bg-zinc-800">PLAYWRIGHT_DOCKER=true</code>, or paste JSON
        instead.
      </div>

      {/* AdsPower one-click capture — primary method */}
      <div className="mt-8 rounded-2xl border border-blue-200/90 bg-gradient-to-br from-blue-50 via-sky-50/80 to-zinc-50/60 p-6 shadow-lg shadow-blue-200/15 dark:border-blue-900/40 dark:from-blue-950/40 dark:via-zinc-900 dark:to-zinc-950/40">
        <h2 className="text-lg font-bold text-blue-950 dark:text-blue-100">
          Add account via AdsPower (recommended)
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-blue-900/85 dark:text-blue-200/80">
          One-click flow: enter a TikTok username → an AdsPower browser opens automatically with the right proxy →
          log in to TikTok → session is captured and saved. No extensions, no copy-paste, no debugging ports.
          <strong> AdsPower desktop must be running.</strong>
        </p>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
          <input
            className={`${inputClass} min-w-[12rem] flex-1`}
            placeholder="TikTok username (e.g. myhandle)"
            value={adspowerUsername}
            onChange={(e) => setAdspowerUsername(e.target.value)}
            disabled={adspowerBusy}
          />
          <button
            type="button"
            className="rounded-xl bg-gradient-to-r from-blue-600 to-sky-600 px-6 py-3 text-sm font-bold text-white shadow-lg shadow-blue-500/30 transition hover:brightness-110 disabled:opacity-50"
            disabled={adspowerBusy || !adspowerUsername.trim()}
            onClick={() => void captureViaAdsPower()}
          >
            {adspowerBusy ? "Browser open — complete login…" : "Open AdsPower & capture session"}
          </button>
        </div>
        {adspowerBusy && (
          <p className="mt-3 animate-pulse text-sm font-medium text-blue-800 dark:text-blue-300">
            An AdsPower browser window should be open. Complete the TikTok login there. This page will update automatically when done.
          </p>
        )}
      </div>

      <div className="mt-8 rounded-2xl border border-amber-200/90 bg-gradient-to-br from-amber-50 via-orange-50/80 to-rose-50/60 p-6 shadow-lg shadow-amber-200/20 dark:border-amber-900/40 dark:from-amber-950/50 dark:via-zinc-900 dark:to-rose-950/30 dark:shadow-black/30">
        <h2 className="text-lg font-bold text-amber-950 dark:text-amber-100">Capture session (Playwright → database)</h2>
        <p className="mt-2 text-sm leading-relaxed text-amber-900/80 dark:text-amber-200/80">
          Starts Chromium on the <strong>server host</strong> (where this app runs). Log in to TikTok in the browser window;
          when capture completes, the session is <strong>saved to the database</strong> for this account. Keep this tab open
          until it finishes (can take a few minutes).
        </p>
        {!interactiveAllowed && (
          <p className="mt-3 rounded-lg border border-amber-300/80 bg-amber-100/80 px-3 py-2 text-sm font-medium text-amber-950 dark:border-amber-700 dark:bg-amber-950/50 dark:text-amber-100">
            Capture is disabled (<code className="font-mono text-xs">DISABLE_INTERACTIVE_SESSION_CAPTURE</code>). Use Import
            below or unset that env variable.
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
            disabled={captureBusy || captureGoLoginBusy || !interactiveAllowed}
            onClick={() => void captureSession()}
            title="Launch a Playwright browser on the server and capture the session"
          >
            {captureBusy ? "Waiting for login…" : "Open browser & save session"}
          </button>
          <button
            type="button"
            className="rounded-xl bg-gradient-to-r from-indigo-600 to-violet-600 px-6 py-3 text-sm font-bold text-white shadow-lg shadow-indigo-500/30 transition hover:brightness-110 disabled:opacity-50"
            disabled={captureBusy || captureGoLoginBusy}
            onClick={() => void captureSessionViaGoLogin()}
            title="Attach to your already-running GoLogin profile (port 9222) and capture the session"
          >
            {captureGoLoginBusy ? "Waiting for login…" : "Save via GoLogin"}
          </button>
        </div>
        <p className="mt-3 text-xs text-zinc-600 dark:text-zinc-400">
          <strong>Save via GoLogin</strong> attaches to your already-running GoLogin profile (launched with <code className="rounded bg-zinc-200 px-1 py-0.5 dark:bg-zinc-800">--remote-debugging-port=9222</code>) — no Playwright browser starts on the server, so proxy-auth issues from the legacy flow don&apos;t apply.
        </p>
      </div>

      {/* Manual GoLogin paste flow — Step 1: generate sticky proxy; Step 2: paste Cookie-Editor JSON */}
      <div className="mt-8 rounded-2xl border border-indigo-200/90 bg-gradient-to-br from-indigo-50 via-violet-50/80 to-zinc-50/60 p-6 shadow-lg shadow-indigo-200/15 dark:border-indigo-900/40 dark:from-indigo-950/40 dark:via-zinc-900 dark:to-zinc-950/40">
        <h2 className="text-lg font-bold text-indigo-950 dark:text-indigo-100">
          Add via GoLogin (paste session)
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-indigo-900/85 dark:text-indigo-200/80">
          Fully manual flow: generate the sticky proxy → paste it into a new GoLogin profile → log into TikTok in that profile → export cookies via{" "}
          <a
            href="https://chromewebstore.google.com/detail/cookie-editor/hlkenndednhfkekhgcdicdfddnkalmdm"
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold underline"
          >
            Cookie-Editor extension
          </a>{" "}
          → paste the JSON back here. No debugging port needed.
        </p>

        {/* Step 1 — generate proxy */}
        <div className="mt-5">
          <p className="text-xs font-semibold uppercase tracking-wider text-indigo-800 dark:text-indigo-300">
            Step 1 — generate sticky proxy for this account
          </p>
          <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
            <input
              className={`${inputClass} min-w-[12rem] flex-1`}
              placeholder="TikTok username (e.g. myhandle)"
              value={gologinPasteUsername}
              onChange={(e) => setGoLoginPasteUsername(e.target.value)}
              disabled={gologinPasteBusy}
            />
            <button
              type="button"
              className="rounded-xl bg-gradient-to-r from-indigo-600 to-violet-600 px-6 py-3 text-sm font-bold text-white shadow-lg shadow-indigo-500/30 transition hover:brightness-110 disabled:opacity-50"
              disabled={gologinPasteBusy || !gologinPasteUsername.trim()}
              onClick={() => void generateGoLoginProxy()}
            >
              {gologinPasteBusy ? "Generating…" : "Generate proxy"}
            </button>
          </div>
        </div>

        {/* Generated proxy details + instructions */}
        {gologinPasteInfo && (
          <>
            <div className="mt-5 rounded-xl border border-indigo-300 bg-white/85 p-4 dark:border-indigo-800 dark:bg-zinc-950/60">
              <p className="text-xs font-semibold uppercase tracking-wider text-indigo-800 dark:text-indigo-300">
                Paste these into a new GoLogin profile ({gologinPasteInfo.created ? "placeholder created" : "existing account"})
              </p>
              <div className="mt-3 space-y-2 font-mono text-xs">
                <CopyRow label="Profile name / Account ID" value={gologinPasteInfo.accountId} />
                <CopyRow label="Proxy type" value="HTTP" />
                <CopyRow label="Proxy host" value={gologinPasteInfo.proxy.host} />
                <CopyRow label="Proxy port" value={String(gologinPasteInfo.proxy.port)} />
                <CopyRow label="Proxy username" value={gologinPasteInfo.proxy.username} />
                <CopyRow label="Proxy password" value={gologinPasteInfo.proxy.password} />
              </div>
              <ol className="mt-4 list-decimal space-y-1 pl-5 text-xs text-indigo-900/85 dark:text-indigo-200/80">
                <li>In GoLogin desktop → <strong>New Profile</strong> → name it with the Account ID above.</li>
                <li>In the profile&apos;s <strong>Proxy</strong> section, paste the 4 proxy values (type HTTP). Click <strong>Check proxy</strong> — should return a US IP.</li>
                <li>Save the profile, then click <strong>Start</strong> to open it.</li>
                <li>In the opened browser: install the <strong>Cookie-Editor</strong> Chrome extension, then log into tiktok.com normally.</li>
                <li>After login, click the Cookie-Editor toolbar icon → <strong>Export</strong> → <strong>JSON</strong>. It copies to clipboard.</li>
                <li>Come back here and paste into the box below → click <strong>Save session</strong>.</li>
              </ol>
            </div>

            {/* Step 2 — paste cookie JSON */}
            <div className="mt-5">
              <p className="text-xs font-semibold uppercase tracking-wider text-indigo-800 dark:text-indigo-300">
                Step 2 — after logging in, paste the Cookie-Editor JSON
              </p>
              <textarea
                className={`${inputClass} mt-2 min-h-[140px] font-mono text-xs`}
                placeholder='[{"domain":".tiktok.com","name":"sessionid","value":"...",...}]'
                value={gologinPasteCookies}
                onChange={(e) => setGoLoginPasteCookies(e.target.value)}
                disabled={gologinImportBusy}
              />
              <div className="mt-3 flex items-center justify-between gap-3">
                <p className="text-xs text-indigo-900/70 dark:text-indigo-200/60">
                  Account: <strong>{gologinPasteInfo.username}</strong> &middot; ID: <code className="rounded bg-indigo-100 px-1 dark:bg-indigo-950/60">{gologinPasteInfo.accountId}</code>
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="rounded-xl border border-indigo-300 px-4 py-2 text-sm font-semibold text-indigo-700 transition hover:bg-indigo-50 dark:border-indigo-700 dark:text-indigo-300 dark:hover:bg-indigo-950/40"
                    disabled={gologinImportBusy}
                    onClick={() => {
                      setGoLoginPasteInfo(null);
                      setGoLoginPasteCookies("");
                      setGoLoginPasteUsername("");
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 px-6 py-3 text-sm font-bold text-white shadow-lg shadow-emerald-500/30 transition hover:brightness-110 disabled:opacity-50"
                    disabled={gologinImportBusy || !gologinPasteCookies.trim()}
                    onClick={() => void importGoLoginSession()}
                  >
                    {gologinImportBusy ? "Saving…" : "Save session"}
                  </button>
                </div>
              </div>
            </div>
          </>
        )}
      </div>

      <div className="mt-8 rounded-2xl border border-emerald-200/90 bg-gradient-to-br from-emerald-50 via-teal-50/80 to-zinc-50/60 p-6 shadow-lg shadow-emerald-200/15 dark:border-emerald-900/40 dark:from-emerald-950/40 dark:via-zinc-900 dark:to-zinc-950/40">
        <h2 className="text-lg font-bold text-emerald-950 dark:text-emerald-100">Import session (paste JSON)</h2>
        <p className="mt-2 text-sm leading-relaxed text-emerald-900/85 dark:text-emerald-200/80">
          Alternative to capture: paste <strong>Playwright storageState</strong> JSON; it is stored in the database for the same
          upload automation.
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
            {importBusy ? "Saving…" : "Save pasted session"}
          </button>
        </div>
      </div>

      <div className="mt-8 flex flex-wrap items-center gap-3 border-t border-zinc-200 pt-8 dark:border-zinc-800">
        <ConnectTikTok />
        <span className="max-w-xl text-sm text-zinc-600 dark:text-zinc-400">
          Optional: open TikTok login in <strong>your browser</strong> (no session to DB). Use capture or import above for
          automation.
        </span>
      </div>

      {accountsListInfo && (
        <AccountsListExplain
          listScope={accountsListInfo.listScope}
          totalInDatabase={accountsListInfo.totalInDatabase}
          listCount={accounts.length}
          linkedCount={accountQuota?.linkedCount ?? accounts.length}
          maxLinkedAccounts={accountQuota?.maxLinkedAccounts ?? null}
          listTotal={listTotal > 0 ? listTotal : undefined}
          page={listTotal > 0 ? page : undefined}
          totalPages={listTotal > 0 ? totalPages : undefined}
          className="mt-10 rounded-xl border border-zinc-200/80 bg-zinc-50/90 px-4 py-3 text-xs leading-relaxed text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900/50 dark:text-zinc-400"
        />
      )}

      <div className="mt-12 flex items-center gap-1 border-b border-zinc-200 dark:border-zinc-700">
        <button
          type="button"
          onClick={() => setTab("active")}
          className={`relative px-5 py-2.5 text-sm font-semibold transition ${
            tab === "active"
              ? "text-emerald-700 dark:text-emerald-400"
              : "text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
          }`}
        >
          Active{listTotal > 0 && ` (${listTotal})`}
          {tab === "active" && (
            <span className="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-emerald-600 dark:bg-emerald-400" />
          )}
        </button>
        <button
          type="button"
          onClick={() => setTab("expired")}
          className={`relative px-5 py-2.5 text-sm font-semibold transition ${
            tab === "expired"
              ? "text-red-600 dark:text-red-400"
              : "text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
          }`}
        >
          Expired{expiredListTotal > 0 && ` (${expiredListTotal})`}
          {tab === "expired" && (
            <span className="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-red-600 dark:bg-red-400" />
          )}
        </button>
        <button
          type="button"
          onClick={() => setTab("health")}
          className={`relative px-5 py-2.5 text-sm font-semibold transition ${
            tab === "health"
              ? "text-violet-600 dark:text-violet-400"
              : "text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
          }`}
        >
          Health Check
          {tab === "health" && (
            <span className="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-violet-600 dark:bg-violet-400" />
          )}
        </button>
      </div>

      {tab === "active" && (
        <>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              {listTotal === 0 ? (
                "No active accounts."
              ) : (
                <>
                  Showing{" "}
                  <span className="font-semibold text-zinc-900 dark:text-zinc-100">
                    {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, listTotal)}
                  </span>{" "}
                  of <span className="font-semibold text-zinc-900 dark:text-zinc-100">{listTotal}</span>
                </>
              )}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
                <span className="sr-only sm:not-sr-only">Per page</span>
                <select
                  className="rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-sm dark:border-zinc-600 dark:bg-zinc-900"
                  value={pageSize}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    setPageSize(n);
                    setPage(1);
                  }}
                >
                  <option value={25}>25</option>
                  <option value={50}>50</option>
                  <option value={100}>100</option>
                </select>
              </label>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  disabled={page <= 1}
                  className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm font-medium text-zinc-800 disabled:opacity-40 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-200"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  Previous
                </button>
                <span className="px-2 text-sm text-zinc-600 dark:text-zinc-400">
                  Page {page} of {totalPages}
                </span>
                <button
                  type="button"
                  disabled={page >= totalPages}
                  className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm font-medium text-zinc-800 disabled:opacity-40 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-200"
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </button>
              </div>
            </div>
          </div>
          <ul className="mt-4 space-y-3">
            {accounts.map((a) => (
              <li
                key={a.id}
                className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-zinc-200/90 bg-[var(--card)] px-5 py-4 shadow-md dark:border-zinc-800"
              >
                <div className="min-w-0 flex-1">
                  <p className="font-bold text-zinc-900 dark:text-white">{a.username}</p>
                  {a.previousUsername && a.previousUsername !== a.username && (
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">
                      Old name: <span className="font-medium text-zinc-600 dark:text-zinc-300">{a.previousUsername}</span>
                    </p>
                  )}
                  <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
                    active | session {a.hasSession ? "ready" : "missing"}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={goLoginBusy === a.id}
                    className="rounded-xl bg-gradient-to-r from-indigo-600 to-violet-600 px-4 py-2 text-sm font-semibold text-white shadow-md shadow-indigo-500/25 transition hover:brightness-110 disabled:opacity-50"
                    onClick={() => void goLoginCapture(a)}
                    title="Open TikTok login in your running GoLogin profile (port 9222) and auto-save the session"
                  >
                    {goLoginBusy === a.id ? "Waiting for login…" : "Capture via GoLogin"}
                  </button>
                  <button
                    type="button"
                    className="rounded-xl bg-red-600 px-4 py-2 text-sm font-semibold text-white shadow-md shadow-red-500/20 transition hover:bg-red-500"
                    onClick={() => remove(a.id)}
                  >
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {tab === "health" && (
        <div className="mt-4">
          <div className="mb-4 rounded-xl border border-violet-200/80 bg-violet-50/70 px-4 py-3 text-sm text-violet-900 dark:border-violet-800/50 dark:bg-violet-950/30 dark:text-violet-200">
            Select accounts and click <strong>Check sessions</strong> to verify which ones have valid TikTok cookies.
            Checks cookie expiration instantly — expired sessions are automatically flagged and hidden from Upload/Campaign.
          </div>

          <div className="flex flex-wrap items-center gap-2 mb-4">
            <button
              type="button"
              disabled={healthBusy}
              onClick={() => setHealthSelected(new Set(allAccounts.map((a) => a.id)))}
              className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
            >
              Select all ({allAccounts.length})
            </button>
            <button
              type="button"
              disabled={healthBusy}
              onClick={() => setHealthSelected(new Set())}
              className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
            >
              Clear
            </button>
            <button
              type="button"
              disabled={healthBusy || healthSelected.size === 0}
              onClick={() => void runHealthCheck()}
              className="rounded-xl bg-gradient-to-r from-violet-600 to-indigo-600 px-5 py-2 text-sm font-bold text-white shadow-lg shadow-violet-600/25 transition hover:brightness-110 disabled:opacity-50"
            >
              {healthBusy ? "Checking…" : `Check sessions (${healthSelected.size})`}
            </button>
          </div>

          {healthProgress && (
            <div className="mb-4 rounded-xl border border-violet-200/80 bg-violet-50/60 px-4 py-3 text-sm font-medium text-violet-900 dark:border-violet-800/50 dark:bg-violet-950/25 dark:text-violet-200">
              {healthProgress}
            </div>
          )}

          {healthSummary && (
            <div className="mb-4 flex flex-wrap gap-3">
              <span className="rounded-full bg-zinc-100 px-3 py-1 text-xs font-bold text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                Checked: {healthSummary.checked}
              </span>
              <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-bold text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                Active: {healthSummary.active}
              </span>
              <span className="rounded-full bg-red-100 px-3 py-1 text-xs font-bold text-red-700 dark:bg-red-950 dark:text-red-300">
                Expired: {healthSummary.expired}
              </span>
              {healthSummary.changed > 0 && (
                <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-bold text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                  Status changed: {healthSummary.changed}
                </span>
              )}
            </div>
          )}

          {allAccounts.length === 0 ? (
            <div className="rounded-xl bg-zinc-100/80 px-6 py-10 text-center dark:bg-zinc-900/60">
              <p className="text-zinc-600 dark:text-zinc-400">Loading accounts…</p>
            </div>
          ) : (
            <div className="max-h-[min(28rem,60vh)] overflow-y-auto rounded-xl border border-zinc-200/90 bg-white dark:border-zinc-700 dark:bg-zinc-950/40">
              <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {allAccounts.map((a) => {
                  const on = healthSelected.has(a.id);
                  const result = healthResults?.find((r) => r.id === a.id);
                  const statusColor =
                    result
                      ? result.currentStatus === "active"
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-red-600 dark:text-red-400"
                      : a.status === "active"
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-red-600 dark:text-red-400";
                  const displayStatus = result ? result.currentStatus : a.status;

                  return (
                    <li key={a.id}>
                      <label
                        className={`flex cursor-pointer items-center gap-3 px-3 py-2.5 transition ${
                          on
                            ? "bg-violet-500/10 dark:bg-violet-950/30"
                            : "hover:bg-zinc-50 dark:hover:bg-zinc-900/60"
                        }`}
                      >
                        <input
                          type="checkbox"
                          className="h-4 w-4 shrink-0 rounded border-zinc-300 text-violet-600 focus:ring-violet-500 dark:border-zinc-600"
                          checked={on}
                          disabled={healthBusy}
                          onChange={() => {
                            setHealthSelected((prev) => {
                              const n = new Set(prev);
                              if (n.has(a.id)) n.delete(a.id);
                              else n.add(a.id);
                              return n;
                            });
                          }}
                        />
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-semibold text-zinc-900 dark:text-white">{a.username}</p>
                          {a.previousUsername && a.previousUsername !== a.username && (
                            <p className="truncate text-[11px] text-zinc-500 dark:text-zinc-400">
                              Old: <span className="font-medium text-zinc-600 dark:text-zinc-300">{a.previousUsername}</span>
                            </p>
                          )}
                          <div className="flex items-center gap-2 text-[11px]">
                            <span className={`font-bold uppercase ${statusColor}`} title={result?.reason ?? ""}>{displayStatus}</span>
                            {result?.reason && (
                              <span className="truncate text-zinc-400 dark:text-zinc-500">{result.reason}</span>
                            )}
                            {result?.changed && (
                              <span className="rounded bg-amber-100 px-1.5 py-0.5 font-bold text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                                changed
                              </span>
                            )}
                          </div>
                        </div>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      )}

      {tab === "expired" && (
        <>
          <div className="mt-4">
            {expiredListTotal === 0 ? (
              <div className="rounded-xl bg-zinc-100/80 px-6 py-10 text-center dark:bg-zinc-900/60">
                <p className="text-zinc-600 dark:text-zinc-400">No expired sessions. All accounts are active.</p>
              </div>
            ) : (
              <>
                <div className="mb-4 rounded-xl border border-amber-200/80 bg-amber-50/70 px-4 py-3 text-sm text-amber-900 dark:border-amber-800/50 dark:bg-amber-950/30 dark:text-amber-200">
                  These accounts have expired TikTok sessions. They won&apos;t appear in Upload or Campaign until
                  re-authenticated. Click <strong>Sign in again</strong> to open a Playwright browser and refresh the session.
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
                  <p className="text-sm text-zinc-600 dark:text-zinc-400">
                    Showing{" "}
                    <span className="font-semibold text-zinc-900 dark:text-zinc-100">
                      {(expiredPage - 1) * pageSize + 1}–{Math.min(expiredPage * pageSize, expiredListTotal)}
                    </span>{" "}
                    of <span className="font-semibold text-zinc-900 dark:text-zinc-100">{expiredListTotal}</span>
                  </p>
                  {expiredTotalPages > 1 && (
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        disabled={expiredPage <= 1}
                        className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm font-medium text-zinc-800 disabled:opacity-40 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-200"
                        onClick={() => setExpiredPage((p) => Math.max(1, p - 1))}
                      >
                        Previous
                      </button>
                      <span className="px-2 text-sm text-zinc-600 dark:text-zinc-400">
                        Page {expiredPage} of {expiredTotalPages}
                      </span>
                      <button
                        type="button"
                        disabled={expiredPage >= expiredTotalPages}
                        className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm font-medium text-zinc-800 disabled:opacity-40 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-200"
                        onClick={() => setExpiredPage((p) => p + 1)}
                      >
                        Next
                      </button>
                    </div>
                  )}
                </div>
                <ul className="space-y-3">
                  {expiredAccounts.map((a) => (
                    <li
                      key={a.id}
                      className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-red-200/70 bg-red-50/50 px-5 py-4 shadow-md dark:border-red-900/40 dark:bg-red-950/20"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="font-bold text-zinc-900 dark:text-white">{a.username}</p>
                        {a.previousUsername && a.previousUsername !== a.username && (
                          <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                            Old name: <span className="font-medium text-zinc-700 dark:text-zinc-300">{a.previousUsername}</span>
                          </p>
                        )}
                        <p className="mt-1 text-sm text-red-600 dark:text-red-400">
                          Session expired — not available for uploads
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          disabled={goLoginBusy === a.id}
                          className="rounded-xl bg-gradient-to-r from-indigo-600 to-violet-600 px-5 py-2 text-sm font-bold text-white shadow-md shadow-indigo-500/25 transition hover:brightness-110 disabled:opacity-50"
                          onClick={() => void goLoginCapture(a)}
                          title="Re-capture session via your running GoLogin profile (port 9222)"
                        >
                          {goLoginBusy === a.id ? "Waiting for login…" : "Capture via GoLogin"}
                        </button>
                        <button
                          type="button"
                          disabled={reAuthBusy === a.id || !interactiveAllowed}
                          className="rounded-xl bg-gradient-to-r from-amber-600 to-orange-600 px-5 py-2 text-sm font-bold text-white shadow-md shadow-amber-600/25 transition hover:brightness-110 disabled:opacity-50"
                          onClick={() => void reAuthCapture(a)}
                        >
                          {reAuthBusy === a.id ? "Waiting for login…" : "Sign in again"}
                        </button>
                        <button
                          type="button"
                          className="rounded-xl bg-red-600 px-4 py-2 text-sm font-semibold text-white shadow-md shadow-red-500/20 transition hover:bg-red-500"
                          onClick={() => remove(a.id)}
                        >
                          Remove
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
