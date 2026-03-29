/** Legacy JSON manifest under storage/accounts.json (cookie file paths). */
export interface FileBackedAccount {
  id: string;
  username: string;
  cookieFile: string;
  addedAt: string;
  lastUsedAt: string | null;
}

/** App-level account shape (Mongo mirrors this for API responses). */
export interface Account {
  id: string;
  username: string;
  session: string;
  proxy?: string;
  status: "active" | "expired";
  lastUsedAt?: string | null;
}

export interface UploadHistoryItem {
  id: string;
  accountId: string;
  accountUsername: string;
  videoFileName: string;
  caption: string;
  musicQuery?: string;
  soundUsed?: string;
  status: "pending" | "uploading" | "success" | "failed";
  error?: string;
  timestamp: string;
}
