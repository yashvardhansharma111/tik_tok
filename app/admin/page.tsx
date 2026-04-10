/* eslint-disable react-hooks/set-state-in-effect */
"use client";

import { useEffect, useState } from "react";
import { PageHeader } from "@/components/PageHeader";

type User = {
  _id: string;
  email: string;
  role: "admin" | "user";
  status: "pending" | "active" | "blocked";
  emailVerified: boolean;
  createdAt: string;
  maxLinkedAccounts?: number | null;
};

type RenameInfo = {
  originalUsername: string;
  appliedUsername: string;
  renamedAt: string;
  renamedBy: string;
};

type AdminAccountRow = {
  id: string;
  username: string;
  /** Legacy first owner */
  ownerId: string | null;
  ownerIds: string[];
  ownerEmails: string[];
  renamed: boolean;
  renameInfo: RenameInfo | null;
};

type RenameItem = {
  accountId: string;
  username: string;
  proposedName: string;
  appliedUsername: string;
  status: string;
  error?: string;
};

type RenameJobRow = {
  id: string;
  ownerId: string | null;
  ownerEmail: string;
  status: string;
  prompt: string;
  total: number;
  completed: number;
  error?: string;
  createdAt: string | null;
  updatedAt: string | null;
  items: RenameItem[];
};

type AdminTab = "users" | "accounts" | "renames";

export default function AdminPage() {
  const [tab, setTab] = useState<AdminTab>("accounts");
  const [users, setUsers] = useState<User[]>([]);
  const [accounts, setAccounts] = useState<AdminAccountRow[]>([]);
  const [renameJobs, setRenameJobs] = useState<RenameJobRow[]>([]);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [renamesError, setRenamesError] = useState<string | null>(null);
  const [bulkUserId, setBulkUserId] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    const res = await fetch("/api/admin/users");
    const data = await res.json();
    if (!res.ok) return setError(data.error || "Failed to load users");
    setUsers(data);
  };

  const loadAccounts = async () => {
    setAccountsError(null);
    const res = await fetch("/api/admin/accounts");
    const data = await res.json();
    if (!res.ok) {
      setAccountsError((data as { error?: string }).error || "Failed to load accounts");
      return;
    }
    setAccounts(Array.isArray(data) ? data : []);
  };

  const loadRenames = async () => {
    setRenamesError(null);
    const res = await fetch("/api/admin/renames?limit=200");
    const data = await res.json();
    if (!res.ok) {
      setRenamesError((data as { error?: string }).error || "Failed to load rename history");
      return;
    }
    setRenameJobs(Array.isArray((data as { jobs?: unknown }).jobs) ? (data as { jobs: RenameJobRow[] }).jobs : []);
  };

  useEffect(() => {
    void load();
    void loadAccounts();
    void loadRenames();
  }, []);

  const action = async (route: string, userId: string) => {
    const res = await fetch(route, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId }),
    });
    const data = await res.json();
    if (!res.ok) return alert(data.error || "Action failed");
    load();
  };

  const bulkAssign = async (mode: "exclusive" | "addToAll") => {
    if (!bulkUserId.trim()) {
      alert("Choose an app user first.");
      return;
    }
    const msg =
      mode === "exclusive"
        ? "Set EVERY TikTok account to ONLY this user? All other owners are removed from every account."
        : "Add this user to every TikTok account (shared with existing owners)?";
    if (!confirm(msg)) return;
    setBulkBusy(true);
    try {
      const res = await fetch("/api/admin/accounts/bulk-assign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: bulkUserId.trim(), mode }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert((data as { error?: string }).error || "Bulk assign failed");
        return;
      }
      await loadAccounts();
      await load();
    } finally {
      setBulkBusy(false);
    }
  };

  const saveMaxAccounts = async (userId: string, raw: string) => {
    const trimmed = raw.trim();
    const maxLinkedAccounts =
      trimmed === "" || trimmed.toLowerCase() === "unlimited" ? null : Number.parseInt(trimmed, 10);
    if (maxLinkedAccounts !== null && (!Number.isFinite(maxLinkedAccounts) || maxLinkedAccounts < 1)) {
      return alert("Enter a positive number, or leave empty for unlimited.");
    }
    const res = await fetch(`/api/admin/users/${userId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxLinkedAccounts }),
    });
    const data = await res.json();
    if (!res.ok) return alert(data.error || "Save failed");
    load();
  };

  const renamedCount = accounts.filter((a) => a.renamed).length;
  const totalSuccessRenames = renameJobs.reduce(
    (sum, j) => sum + j.items.filter((it) => it.status === "done" && it.appliedUsername).length,
    0
  );

  const tabs: { key: AdminTab; label: string; count?: number }[] = [
    { key: "accounts", label: "Accounts", count: accounts.length },
    { key: "renames", label: "Rename history", count: totalSuccessRenames },
    { key: "users", label: "Users", count: users.length },
  ];

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <PageHeader
        eyebrow="Administration"
        title="Admin panel"
        description="Manage users, assign TikTok accounts, and view all rename history across every user."
      />

      {error && (
        <div className="mb-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
          {error}
        </div>
      )}

      {/* ─── Tab bar ─── */}
      <div className="mb-8 flex gap-1 rounded-xl border border-zinc-200/80 bg-zinc-100/60 p-1 dark:border-zinc-700 dark:bg-zinc-800/60">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`rounded-lg px-5 py-2.5 text-sm font-bold transition-all ${
              tab === t.key
                ? "bg-white text-zinc-900 shadow-md dark:bg-zinc-700 dark:text-white"
                : "text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
            }`}
          >
            {t.label}
            {t.count != null && (
              <span className="ml-2 rounded-full bg-zinc-200/80 px-2 py-0.5 text-[0.65rem] font-semibold text-zinc-600 dark:bg-zinc-600 dark:text-zinc-200">
                {t.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ═══════════ USERS TAB ═══════════ */}
      {tab === "users" && (
        <>
          <div className="overflow-hidden rounded-2xl border border-zinc-200/90 bg-[var(--card)] shadow-xl dark:border-zinc-800">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[960px] text-left text-sm">
                <thead>
                  <tr className="border-b border-zinc-200 bg-gradient-to-r from-violet-100 to-fuchsia-50 dark:border-zinc-800 dark:from-violet-950/50 dark:to-fuchsia-950/30">
                    <th className="px-4 py-4 font-bold text-zinc-700 dark:text-zinc-300">Email</th>
                    <th className="px-4 py-4 font-bold text-zinc-700 dark:text-zinc-300">Role</th>
                    <th className="px-4 py-4 font-bold text-zinc-700 dark:text-zinc-300">Status</th>
                    <th className="px-4 py-4 font-bold text-zinc-700 dark:text-zinc-300">Verified</th>
                    <th className="px-4 py-4 font-bold text-zinc-700 dark:text-zinc-300">Max accounts</th>
                    <th className="px-4 py-4 font-bold text-zinc-700 dark:text-zinc-300">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u._id} className="border-t border-zinc-100 dark:border-zinc-800">
                      <td className="px-4 py-3 font-medium">{u.email}</td>
                      <td className="px-4 py-3">{u.role}</td>
                      <td className="px-4 py-3">{u.status}</td>
                      <td className="px-4 py-3">{u.emailVerified ? "Yes" : "No"}</td>
                      <td className="px-4 py-3">
                        <form
                          className="flex flex-wrap items-center gap-2"
                          onSubmit={(e) => {
                            e.preventDefault();
                            const fd = new FormData(e.currentTarget);
                            void saveMaxAccounts(u._id, String(fd.get("max") ?? ""));
                          }}
                        >
                          <input
                            name="max"
                            type="text"
                            defaultValue={u.maxLinkedAccounts == null ? "" : String(u.maxLinkedAccounts)}
                            placeholder="∞ unlimited"
                            className="w-28 rounded-lg border border-zinc-200 bg-white px-2 py-1 text-xs font-medium text-zinc-900 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100"
                          />
                          <button
                            type="submit"
                            className="rounded-lg bg-zinc-700 px-2 py-1 text-xs font-bold text-white hover:bg-zinc-600"
                          >
                            Save
                          </button>
                        </form>
                      </td>
                      <td className="space-x-2 px-4 py-3">
                        <button
                          type="button"
                          className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white shadow-md hover:bg-emerald-500"
                          onClick={() => action("/api/admin/approve", u._id)}
                        >
                          Approve
                        </button>
                        <button
                          type="button"
                          className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-bold text-white shadow-md hover:bg-red-500"
                          onClick={() => action("/api/admin/block", u._id)}
                        >
                          Block
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* ═══════════ ACCOUNTS TAB ═══════════ */}
      {tab === "accounts" && (
        <>
          <h2 className="text-lg font-bold text-zinc-900 dark:text-white">
            TikTok accounts
            {renamedCount > 0 && (
              <span className="ml-3 rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                {renamedCount} renamed
              </span>
            )}
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
            Renamed accounts are sorted <strong>first</strong> with a green badge showing <code>@old → @new</code>.
            Assign accounts to app users below.
          </p>

          <div className="mt-6 flex flex-wrap items-end gap-3 rounded-xl border border-teal-200/80 bg-teal-50/50 px-4 py-4 dark:border-teal-900/50 dark:bg-teal-950/20">
            <label className="flex flex-col gap-1 text-xs font-semibold text-zinc-700 dark:text-zinc-200">
              Bulk assign: pick user then action
              <select
                className="min-w-[14rem] rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm font-medium text-zinc-900 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100"
                value={bulkUserId}
                onChange={(e) => setBulkUserId(e.target.value)}
                disabled={bulkBusy}
              >
                <option value="">— Select app user —</option>
                {users.map((u) => (
                  <option key={u._id} value={u._id}>
                    {u.email}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="rounded-lg bg-teal-700 px-4 py-2 text-xs font-bold text-white shadow-md hover:bg-teal-600 disabled:opacity-50"
              disabled={bulkBusy || !bulkUserId}
              onClick={() => void bulkAssign("exclusive")}
            >
              All accounts → this user only
            </button>
            <button
              type="button"
              className="rounded-lg border border-teal-600 bg-white px-4 py-2 text-xs font-bold text-teal-800 hover:bg-teal-50 disabled:opacity-50 dark:border-teal-700 dark:bg-teal-950 dark:text-teal-200 dark:hover:bg-teal-900"
              disabled={bulkBusy || !bulkUserId}
              onClick={() => void bulkAssign("addToAll")}
            >
              Add user to every account (shared)
            </button>
          </div>
          {accountsError && (
            <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              {accountsError}
            </div>
          )}
          <div className="mt-6 overflow-hidden rounded-2xl border border-zinc-200/90 bg-[var(--card)] shadow-xl dark:border-zinc-800">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[820px] text-left text-sm">
                <thead>
                  <tr className="border-b border-zinc-200 bg-gradient-to-r from-teal-100 to-cyan-50 dark:border-zinc-800 dark:from-teal-950/40 dark:to-cyan-950/30">
                    <th className="px-4 py-4 font-bold text-zinc-700 dark:text-zinc-300">TikTok username</th>
                    <th className="px-4 py-4 font-bold text-zinc-700 dark:text-zinc-300">Rename status</th>
                    <th className="px-4 py-4 font-bold text-zinc-700 dark:text-zinc-300">App users (multi-select)</th>
                    <th className="px-4 py-4 font-bold text-zinc-700 dark:text-zinc-300"> </th>
                  </tr>
                </thead>
                <tbody>
                  {accounts.length === 0 && (
                    <tr>
                      <td colSpan={4} className="px-4 py-8 text-center text-zinc-500 dark:text-zinc-400">
                        No TikTok accounts in the database yet.
                      </td>
                    </tr>
                  )}
                  {accounts.map((a) => (
                    <AccountAssignRow
                      key={a.id}
                      row={a}
                      users={users}
                      onApplied={() => {
                        void loadAccounts();
                        void load();
                      }}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* ═══════════ RENAME HISTORY TAB ═══════════ */}
      {tab === "renames" && (
        <>
          <h2 className="text-lg font-bold text-zinc-900 dark:text-white">
            All rename history
            {totalSuccessRenames > 0 && (
              <span className="ml-3 rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                {totalSuccessRenames} successful
              </span>
            )}
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
            Every rename job across all users. Successful renames show <code>@old → @new</code> with who triggered it.
          </p>
          {renamesError && (
            <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              {renamesError}
            </div>
          )}
          <button
            type="button"
            className="mt-4 rounded-lg bg-zinc-700 px-4 py-2 text-xs font-bold text-white hover:bg-zinc-600"
            onClick={() => void loadRenames()}
          >
            Refresh
          </button>
          <div className="mt-4 space-y-4">
            {renameJobs.length === 0 && (
              <p className="py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
                No rename jobs found.
              </p>
            )}
            {renameJobs.map((job) => {
              const successes = job.items.filter((it) => it.status === "done" && it.appliedUsername);
              const failures = job.items.filter((it) => it.status === "failed");
              return (
                <div
                  key={job.id}
                  className="overflow-hidden rounded-2xl border border-zinc-200/90 bg-[var(--card)] shadow dark:border-zinc-800"
                >
                  <div className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <span
                      className={`rounded-full px-2 py-0.5 text-[0.65rem] font-bold uppercase ${
                        job.status === "done"
                          ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
                          : job.status === "partial"
                            ? "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
                            : job.status === "failed"
                              ? "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300"
                              : "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300"
                      }`}
                    >
                      {job.status}
                    </span>
                    <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                      by <strong className="text-zinc-700 dark:text-zinc-200">{job.ownerEmail}</strong>
                    </span>
                    <span className="text-xs text-zinc-400 dark:text-zinc-500">
                      {job.createdAt ? new Date(job.createdAt).toLocaleString() : "—"}
                    </span>
                    <span className="text-xs text-zinc-500 dark:text-zinc-400">
                      {job.completed}/{job.total} completed
                    </span>
                  </div>
                  <div className="border-t border-zinc-100 px-4 py-2 dark:border-zinc-800">
                    <p className="text-xs italic text-zinc-500 dark:text-zinc-400 truncate">
                      Prompt: {job.prompt}
                    </p>
                  </div>

                  {successes.length > 0 && (
                    <div className="border-t border-emerald-200/60 bg-emerald-50/40 px-4 py-3 dark:border-emerald-900/40 dark:bg-emerald-950/20">
                      <h4 className="text-xs font-bold text-emerald-700 dark:text-emerald-300">
                        Renamed ({successes.length})
                      </h4>
                      <ul className="mt-1.5 space-y-0.5">
                        {successes.map((it) => (
                          <li
                            key={it.accountId}
                            className="font-mono text-xs text-emerald-800 dark:text-emerald-200"
                          >
                            <span className="text-zinc-500 dark:text-zinc-400">@{it.username}</span>
                            {" → "}
                            <span className="font-bold">@{it.appliedUsername}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {failures.length > 0 && (
                    <div className="border-t border-red-200/60 bg-red-50/30 px-4 py-3 dark:border-red-900/40 dark:bg-red-950/20">
                      <h4 className="text-xs font-bold text-red-700 dark:text-red-300">
                        Failed ({failures.length})
                      </h4>
                      <ul className="mt-1.5 space-y-0.5">
                        {failures.map((it) => (
                          <li
                            key={it.accountId}
                            className="font-mono text-xs text-red-700 dark:text-red-300"
                          >
                            @{it.username}
                            {it.error && (
                              <span className="ml-2 font-sans text-[0.6rem] text-red-500 dark:text-red-400">
                                {it.error}
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function sortedEq(a: string[], b: string[]) {
  return JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
}

function rowOwnerIds(r: AdminAccountRow): string[] {
  if (r.ownerIds && r.ownerIds.length > 0) return [...r.ownerIds];
  if (r.ownerId) return [r.ownerId];
  return [];
}

function AccountAssignRow(props: {
  row: AdminAccountRow;
  users: User[];
  onApplied: () => void;
}) {
  const { row, users, onApplied } = props;
  const [ownerIds, setOwnerIds] = useState<string[]>(() => rowOwnerIds(row));
  const [busy, setBusy] = useState(false);

  /** One primitive dep so the deps array length never changes (fixes React “constant size” warning). */
  const rowOwnersKey = `${row.id}|${row.ownerId ?? ""}|${JSON.stringify((row.ownerIds ?? []).slice().sort())}`;
  useEffect(() => {
    setOwnerIds(rowOwnerIds(row));
  }, [rowOwnersKey]);

  const apply = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/accounts/${encodeURIComponent(row.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ownerIds }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert((data as { error?: string }).error || "Assignment failed");
        return;
      }
      onApplied();
    } finally {
      setBusy(false);
    }
  };

  const dirty = !sortedEq(ownerIds, rowOwnerIds(row));

  return (
    <tr className={`border-t ${row.renamed ? "border-emerald-100 bg-emerald-50/20 dark:border-emerald-900/30 dark:bg-emerald-950/10" : "border-zinc-100 dark:border-zinc-800"}`}>
      <td className="px-4 py-3">
        <span className="font-mono text-sm font-medium text-zinc-900 dark:text-zinc-100">@{row.username}</span>
      </td>
      <td className="px-4 py-3">
        {row.renamed && row.renameInfo ? (
          <div>
            <span className="inline-block rounded-full bg-emerald-100 px-2 py-0.5 text-[0.65rem] font-bold text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
              RENAMED
            </span>
            <p className="mt-1 font-mono text-xs text-emerald-800 dark:text-emerald-200">
              <span className="text-zinc-500 dark:text-zinc-400">@{row.renameInfo.originalUsername}</span>
              {" → "}
              <span className="font-bold">@{row.renameInfo.appliedUsername}</span>
            </p>
            {row.renameInfo.renamedBy && (
              <p className="text-[0.6rem] text-zinc-500 dark:text-zinc-400">
                by {row.renameInfo.renamedBy}
                {row.renameInfo.renamedAt && (
                  <> · {new Date(row.renameInfo.renamedAt).toLocaleDateString()}</>
                )}
              </p>
            )}
          </div>
        ) : (
          <span className="text-xs text-zinc-400 dark:text-zinc-500">—</span>
        )}
      </td>
      <td className="px-4 py-3">
        <select
          multiple
          size={Math.min(10, Math.max(4, users.length))}
          className="max-w-md rounded-lg border border-zinc-200 bg-white px-2 py-1 text-xs font-medium text-zinc-900 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100"
          value={ownerIds}
          onChange={(e) => {
            const selected = [...e.target.selectedOptions].map((o) => o.value);
            setOwnerIds(selected);
          }}
          disabled={busy}
        >
          {users.map((u) => (
            <option key={u._id} value={u._id}>
              {u.email}
              {u.maxLinkedAccounts != null ? ` (max ${u.maxLinkedAccounts})` : ""}
            </option>
          ))}
        </select>
        <p className="mt-1 max-w-md text-[0.65rem] text-zinc-500 dark:text-zinc-400">
          Ctrl/Cmd+click for multiple. Empty = unassigned.
        </p>
      </td>
      <td className="px-4 py-3">
        <button
          type="button"
          className="rounded-lg bg-teal-600 px-3 py-1.5 text-xs font-bold text-white shadow-md hover:bg-teal-500 disabled:opacity-50"
          disabled={busy || !dirty}
          onClick={() => void apply()}
        >
          {busy ? "Saving…" : "Apply"}
        </button>
      </td>
    </tr>
  );
}
