/** Defaults must match `GET /api/accounts` query handling. */
export const ACCOUNTS_LIST_DEFAULT_LIMIT = 50;
export const ACCOUNTS_LIST_MAX_LIMIT = 2000;

/** Chunk size when loading full lists for multi-select UIs (upload, campaign, rename). */
const SELECTOR_CHUNK_LIMIT = 200;

export type AccountsApiRow = {
  id: string;
  username: string;
  proxy?: string;
  status: string;
  lastUsedAt?: unknown;
  hasSession?: boolean;
};

export type AccountsApiPayload = {
  accounts: AccountsApiRow[];
  page: number;
  limit: number;
  listTotal: number;
  totalPages: number;
  linkedCount: number;
  maxLinkedAccounts: number | null;
  canAddMore: boolean;
  totalInDatabase: number;
  listScope: "owner_only" | "all_in_database";
};

function accountsUrl(page: number, limit: number): string {
  const p = Math.max(1, page);
  const l = Math.min(ACCOUNTS_LIST_MAX_LIMIT, Math.max(1, limit));
  return `/api/accounts?page=${p}&limit=${l}`;
}

/**
 * One page of accounts (accounts list UI).
 */
export async function fetchAccountsPage(
  page: number,
  limit: number = ACCOUNTS_LIST_DEFAULT_LIMIT
): Promise<{ res: Response; data: AccountsApiPayload }> {
  const res = await fetch(accountsUrl(page, limit));
  const data = (await res.json()) as AccountsApiPayload;
  return { res, data };
}

/**
 * Every account visible to the current user, for checkboxes / multi-select.
 * Paginates on the client to avoid huge single responses.
 */
export async function fetchAllAccountsForSelectors(): Promise<{
  res: Response;
  data: AccountsApiPayload & { accounts: AccountsApiRow[] };
}> {
  let page = 1;
  const accounts: AccountsApiRow[] = [];
  let lastRes: Response | null = null;
  let lastData: AccountsApiPayload | null = null;

  while (true) {
    const res = await fetch(accountsUrl(page, SELECTOR_CHUNK_LIMIT));
    const data = (await res.json()) as AccountsApiPayload;
    lastRes = res;
    if (!res.ok) {
      return { res, data: { ...data, accounts: [] } };
    }
    lastData = data;
    accounts.push(...(data.accounts ?? []));
    const chunk = data.accounts?.length ?? 0;
    if (chunk < SELECTOR_CHUNK_LIMIT || accounts.length >= data.listTotal) break;
    page += 1;
    if (page > 500) break;
  }

  if (!lastData || !lastRes) {
    return {
      res: new Response(JSON.stringify({ error: "No account data" }), { status: 500 }),
      data: {
        accounts: [],
        page: 1,
        limit: SELECTOR_CHUNK_LIMIT,
        listTotal: 0,
        totalPages: 0,
        linkedCount: 0,
        maxLinkedAccounts: null,
        canAddMore: true,
        totalInDatabase: 0,
        listScope: "owner_only",
      },
    };
  }

  return {
    res: lastRes,
    data: {
      ...lastData,
      accounts,
    },
  };
}
