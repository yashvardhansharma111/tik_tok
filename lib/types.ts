import type { MusicMode } from "./musicMode";

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
  musicMode?: MusicMode;
  allowComments?: boolean;
  soundUsed?: string;
  status: "pending" | "uploading" | "success" | "failed";
  error?: string;
  timestamp: string;
}
