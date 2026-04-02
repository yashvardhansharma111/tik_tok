import type { BrowserContext } from "playwright";

export type ProxyKeyFields = { server?: string; username?: string; password?: string };

/**
 * Stable key: same account + same proxy credentials → reuse one BrowserContext (HTTP cache warm).
 * Include full password so IPRoyal sticky session suffix (retry attempt) does not collide.
 */
export function makeUploadContextPoolKey(username: string, proxy?: ProxyKeyFields): string {
  const safeUser = username.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (!proxy?.server) return `${safeUser}::direct`;
  return `${safeUser}::${proxy.server}::${proxy.username ?? ""}::${proxy.password ?? ""}`;
}

const entries = new Map<string, BrowserContext>();

function maxEntries(): number {
  const n = Number(process.env.TIKTOK_UPLOAD_CONTEXT_POOL_MAX || 16);
  return Number.isFinite(n) && n > 0 ? Math.min(64, Math.floor(n)) : 16;
}

/** Remove and return a pooled context, or undefined. */
export function takeUploadContext(key: string): BrowserContext | undefined {
  const c = entries.get(key);
  if (!c) return undefined;
  entries.delete(key);
  return c;
}

/**
 * Keep context alive for the next upload with the same key (warm cache).
 * Replaces any existing entry for this key and closes the previous context.
 */
export function offerUploadContext(key: string, context: BrowserContext): void {
  const prev = entries.get(key);
  if (prev && prev !== context) {
    prev.close().catch(() => {});
  }
  while (entries.size >= maxEntries()) {
    evictOne();
  }
  entries.set(key, context);
}

function evictOne(): void {
  const first = entries.keys().next();
  if (first.done) return;
  const k = first.value as string;
  const c = entries.get(k);
  entries.delete(k);
  c?.close().catch(() => {});
}

/** Close and drop a pooled context (e.g. session error). */
export function discardUploadContext(key: string): void {
  const c = entries.get(key);
  if (!c) return;
  entries.delete(key);
  c.close().catch(() => {});
}
