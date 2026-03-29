import path from "path";
import fs from "fs";
import type { FileBackedAccount, UploadHistoryItem } from "./types";

const STORAGE_DIR = path.join(process.cwd(), "storage");
const ACCOUNTS_PATH = path.join(STORAGE_DIR, "accounts.json");
const HISTORY_PATH = path.join(STORAGE_DIR, "uploadHistory.json");

function ensureStorage() {
  if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR, { recursive: true });
  if (!fs.existsSync(ACCOUNTS_PATH)) fs.writeFileSync(ACCOUNTS_PATH, "[]");
  if (!fs.existsSync(HISTORY_PATH)) fs.writeFileSync(HISTORY_PATH, "[]");
}

export function getAccounts(): FileBackedAccount[] {
  ensureStorage();
  return JSON.parse(fs.readFileSync(ACCOUNTS_PATH, "utf-8"));
}

export function saveAccounts(accounts: FileBackedAccount[]) {
  ensureStorage();
  fs.writeFileSync(ACCOUNTS_PATH, JSON.stringify(accounts, null, 2));
}

export function getAccountById(id: string): FileBackedAccount | undefined {
  return getAccounts().find((a) => a.id === id);
}

export function getAccountByUsername(username: string): FileBackedAccount | undefined {
  return getAccounts().find((a) => a.username === username);
}

export function addAccount(username: string, cookieFileName: string): FileBackedAccount {
  const accounts = getAccounts();
  const id = `acc-${Date.now()}`;
  const account: FileBackedAccount = {
    id,
    username,
    cookieFile: cookieFileName.startsWith("cookies/") ? cookieFileName : `cookies/${cookieFileName}`,
    addedAt: new Date().toISOString(),
    lastUsedAt: null,
  };
  accounts.push(account);
  saveAccounts(accounts);
  return account;
}

export function deleteAccount(id: string) {
  const accounts = getAccounts().filter((a) => a.id !== id);
  saveAccounts(accounts);
}

export function updateAccountCookieFile(username: string, cookieFile: string) {
  const accounts = getAccounts();
  const idx = accounts.findIndex((a) => a.username === username);
  if (idx >= 0) {
    accounts[idx].cookieFile = cookieFile.startsWith("cookies/") ? cookieFile : `cookies/${cookieFile}`;
    saveAccounts(accounts);
  }
}

export function updateAccountLastUsed(id: string) {
  const accounts = getAccounts();
  const idx = accounts.findIndex((a) => a.id === id);
  if (idx >= 0) {
    accounts[idx].lastUsedAt = new Date().toISOString();
    saveAccounts(accounts);
  }
}

export function getUploadHistory(): UploadHistoryItem[] {
  ensureStorage();
  return JSON.parse(fs.readFileSync(HISTORY_PATH, "utf-8"));
}

export function appendUploadHistory(item: UploadHistoryItem) {
  const history = getUploadHistory();
  history.unshift(item);
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
}

export function updateHistoryItemStatus(id: string, status: UploadHistoryItem["status"], error?: string) {
  const history = getUploadHistory();
  const item = history.find((h) => h.id === id);
  if (item) {
    item.status = status;
    if (error) item.error = error;
    fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
  }
}

export function getCookiePath(cookieFile: string): string {
  return path.join(process.cwd(), "storage", cookieFile);
}
