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

type AdminAccountRow = {
  id: string;
  username: string;
  /** Legacy first owner */
  ownerId: string | null;
  ownerIds: string[];
  ownerEmails: string[];
};

export default function AdminPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [accounts, setAccounts] = useState<AdminAccountRow[]>([]);
  const [accountsError, setAccountsError] = useState<string | null>(null);
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

  useEffect(() => {
    void load();
    void loadAccounts();
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

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <PageHeader
        eyebrow="Administration"
        title="User management"
        description="Approve signups, set per-user TikTok account limits, and assign which TikTok accounts belong to which app user. Use assignments when you run several servers: log in to each server as a different app user so each only sees its own TikTok accounts and sessions do not overlap."
      />

      {error && (
        <div className="mb-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
          {error}
        </div>
      )}

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

      <h2 className="mt-14 text-lg font-bold text-zinc-900 dark:text-white">Assign TikTok accounts to users</h2>
      <p className="mt-2 max-w-3xl text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
        Each row is a stored TikTok login. Pick one or more <strong>app users</strong> (hold Ctrl/Cmd in the list) so a TikTok session can be shared between testers. For production, usually one owner per row. Use bulk actions below to wire all accounts to one user for quick testing.
      </p>

      <div className="mt-6 flex flex-wrap items-end gap-3 rounded-xl border border-teal-200/80 bg-teal-50/50 px-4 py-4 dark:border-teal-900/50 dark:bg-teal-950/20">
        <label className="flex flex-col gap-1 text-xs font-semibold text-zinc-700 dark:text-zinc-200">
          Testing: pick user then bulk action
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
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-200 bg-gradient-to-r from-teal-100 to-cyan-50 dark:border-zinc-800 dark:from-teal-950/40 dark:to-cyan-950/30">
                <th className="px-4 py-4 font-bold text-zinc-700 dark:text-zinc-300">TikTok username</th>
                <th className="px-4 py-4 font-bold text-zinc-700 dark:text-zinc-300">App users (multi-select)</th>
                <th className="px-4 py-4 font-bold text-zinc-700 dark:text-zinc-300"> </th>
              </tr>
            </thead>
            <tbody>
              {accounts.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-4 py-8 text-center text-zinc-500 dark:text-zinc-400">
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
    <tr className="border-t border-zinc-100 dark:border-zinc-800">
      <td className="px-4 py-3 font-mono text-sm font-medium text-zinc-900 dark:text-zinc-100">{row.username}</td>
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
