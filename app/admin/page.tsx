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
};

export default function AdminPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    const res = await fetch("/api/admin/users");
    const data = await res.json();
    if (!res.ok) return setError(data.error || "Failed to load users");
    setUsers(data);
  };

  useEffect(() => {
    void load();
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

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <PageHeader
        eyebrow="Administration"
        title="User management"
        description="Approve new signups or block access. Only admins see this page."
      />

      {error && (
        <div className="mb-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
          {error}
        </div>
      )}

      <div className="overflow-hidden rounded-2xl border border-zinc-200/90 bg-[var(--card)] shadow-xl dark:border-zinc-800">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-200 bg-gradient-to-r from-violet-100 to-fuchsia-50 dark:border-zinc-800 dark:from-violet-950/50 dark:to-fuchsia-950/30">
                <th className="px-4 py-4 font-bold text-zinc-700 dark:text-zinc-300">Email</th>
                <th className="px-4 py-4 font-bold text-zinc-700 dark:text-zinc-300">Role</th>
                <th className="px-4 py-4 font-bold text-zinc-700 dark:text-zinc-300">Status</th>
                <th className="px-4 py-4 font-bold text-zinc-700 dark:text-zinc-300">Verified</th>
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
    </div>
  );
}
