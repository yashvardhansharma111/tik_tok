/** Payload shape from GET /api/accounts (subset used for logging + UI hints). */
export type AccountsListMeta = {
  accounts?: unknown[];
  linkedCount?: number;
  totalInDatabase?: number;
  listScope?: "owner_only" | "all_in_database";
  /** Admin cap on how many accounts this user may link; `null` / unset = unlimited. */
  maxLinkedAccounts?: number | null;
};

/**
 * Logs why the account checklist shows N rows (server truth: filter + DB totals).
 * Call from browser after a successful GET /api/accounts.
 */
export function logAccountsListLoaded(meta: AccountsListMeta, context: string): void {
  const listCount = Array.isArray(meta.accounts) ? meta.accounts.length : 0;
  const total = meta.totalInDatabase;
  const linked = meta.linkedCount;
  const scope = meta.listScope;
  const cap = meta.maxLinkedAccounts;

  let explanation: string;
  if (scope === "owner_only") {
    const capNote =
      cap != null
        ? ` Admin max linked accounts for this user: ${cap} (you have ${linked ?? "?"}).`
        : " No admin cap (unlimited default).";
    explanation =
      `Non-admin: ${listCount} Account row(s) for this login; ${total ?? "?"} row(s) total in DB (all users).${capNote}` +
      ` Other rows belong to other app users unless you add more under this login (within cap).`;
  } else if (scope === "all_in_database") {
    explanation =
      `Admin: the list shows every account in the database (${listCount} row(s)). ` +
      `"Linked" counts only accounts tied to your admin user's ownerId (${linked ?? "?"}); it can differ from the list length.`;
  } else {
    explanation = `Loaded ${listCount} account(s) from the server.`;
  }

  console.info(`[accounts list] ${context}`, {
    listCount,
    totalInDatabase: total,
    linkedCount: linked,
    listScope: scope ?? "unknown",
    explanation,
  });
}
