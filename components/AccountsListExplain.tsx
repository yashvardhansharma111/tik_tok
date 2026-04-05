/**
 * Explains checklist length: multi-tenant total row count vs this user's rows,
 * and optional admin max-linked cap (`null` = unlimited default).
 */
export function AccountsListExplain(props: {
  listScope: "owner_only" | "all_in_database";
  totalInDatabase: number;
  listCount: number;
  linkedCount: number;
  maxLinkedAccounts: number | null;
  className?: string;
}) {
  const { listScope, totalInDatabase, listCount, linkedCount, maxLinkedAccounts, className } = props;
  const othersApprox = Math.max(0, totalInDatabase - listCount);

  const baseClass =
    className ?? "mt-2 text-xs leading-relaxed text-zinc-600 dark:text-zinc-400";

  if (listScope === "all_in_database") {
    return (
      <p className={baseClass}>
        <strong className="text-zinc-800 dark:text-zinc-200">Admin view:</strong> listing all{" "}
        <strong>{listCount}</strong> account row(s) in the database. “Linked” in the header counts only accounts tied to
        your admin user, not the full list. See console{" "}
        <code className="rounded bg-zinc-200/90 px-1 font-mono text-[0.7rem] dark:bg-zinc-800">[accounts list]</code>.
      </p>
    );
  }

  const cap = maxLinkedAccounts;
  const atCap = cap != null && linkedCount >= cap;

  return (
    <p className={baseClass}>
      <strong className="text-zinc-800 dark:text-zinc-200">Why this many:</strong> the database has{" "}
      <strong>{totalInDatabase}</strong> account row(s) in total (every app user). You see{" "}
      <strong>{listCount}</strong> for <em>your</em> login — not a random UI limit.{" "}
      {cap != null ? (
        <>
          An admin set your maximum linked accounts to <strong>{cap}</strong>
          {atCap ? (
            <>; you are at that limit, so you cannot add more until the cap is increased or cleared (null = unlimited).</>
          ) : (
            <>
              {" "}
              ({linkedCount} of {cap} used — you can still add more until you reach {cap}.)
            </>
          )}
        </>
      ) : (
        <>
          No admin cap is set (default <strong>unlimited</strong> links for this user), so you can add more on the Accounts
          page until you choose to stop.{" "}
        </>
      )}
      Roughly <strong>{othersApprox}</strong> other row(s) here belong to <em>other</em> users. Logs:{" "}
      <code className="rounded bg-zinc-200/90 px-1 font-mono text-[0.7rem] dark:bg-zinc-800">[api/accounts GET]</code> ·{" "}
      <code className="rounded bg-zinc-200/90 px-1 font-mono text-[0.7rem] dark:bg-zinc-800">[accounts list]</code>.
    </p>
  );
}
