/**
 * Shared proxy config for Playwright (upload + rename + capture).
 *
 * Why proxy traffic is high (not a bug by itself):
 * - Playwright routes **all** browser traffic (HTML, JS, images, video chunks, WebSockets) through
 *   `server` + sticky `username`/`password` when set — same as a full desktop session on TikTok Studio.
 * - **Parallel uploads** (N browser contexts) ≈ N concurrent sessions × normal page weight.
 * - Retries, sound search, and long flows add more requests. Residential/datacenter proxies bill by GB.
 *
 * **Shared sticky slots (`PROXY_STICKY_SLOT_COUNT`):** map many accounts onto a **fixed number** of
 * session password suffixes (`slot0`…`slotN-1`) so **2–3+ accounts** can share one proxy identity before
 * you exhaust the slot space — **not** a new session string per account on every job.
 *
 * **IP rotation (`PROXY_ROTATE_MINUTES`):** rotate proxy IPs periodically so that heavy usage
 * doesn't burn a fixed set of IPs. The rotation window is appended to the session key so the
 * proxy provider assigns fresh IPs each period. Default: 60 minutes.
 */
import { createHash } from "crypto";

export type PlaywrightProxyConfig = {
  server: string;
  username?: string;
  password?: string;
};

function safeUserSegment(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function slotFromAccountId(accountId: string, slots: number): number {
  const buf = createHash("sha256").update(accountId).digest();
  return buf.readUInt32BE(0) % slots;
}

/**
 * Time-based rotation window. Changes the session key every N minutes
 * so the proxy provider assigns a fresh IP.
 */
function rotationWindow(): string {
  const minutes = Math.max(1, Number(process.env.PROXY_ROTATE_MINUTES || 60));
  const epoch = Math.floor(Date.now() / (minutes * 60_000));
  return `r${epoch}`;
}

/**
 * Sticky proxy for an account with periodic IP rotation.
 *
 * - **Default (`PROXY_STICKY_SLOT_COUNT` unset or 0):** one session key per **username** (legacy).
 * - **Shared slots (`PROXY_STICKY_SLOT_COUNT` ≥ 2):** session key is `slot<K>` where `K = hash(accountId) % N`.
 *   Set **N ≈ ceil(account_count / desired_accounts_per_proxy)** (e.g. 30 accounts, ~3 per proxy → **N=10**).
 * - **Rotation (`PROXY_ROTATE_MINUTES`):** IPs rotate every N minutes (default 60). Set 0 to disable rotation.
 *
 * `attemptNumber` appends `-1`, `-2` for retries (provider sticky rotation).
 */
export function buildStickyProxyForAccount(
  accountUsername: string,
  accountProxy?: string,
  attemptNumber = 1,
  accountId?: string
): PlaywrightProxyConfig | undefined {
  const server =
    (accountProxy && accountProxy.trim()) || process.env.PROXY_SERVER || "";
  if (!server) return undefined;

  const username = process.env.PROXY_USERNAME;
  const passwordBase = process.env.PROXY_PASSWORD;
  if (!username || !passwordBase) {
    return { server };
  }

  const slotCount = Math.max(0, Math.min(512, Number(process.env.PROXY_STICKY_SLOT_COUNT || 0)));
  const suffix = attemptNumber ? `-${attemptNumber}` : "";

  const rotateMinutes = Number(process.env.PROXY_ROTATE_MINUTES ?? 60);
  const rotation = rotateMinutes > 0 ? rotationWindow() : "";

  let sessionKey: string;
  if (slotCount >= 2 && accountId && accountId.trim()) {
    const k = slotFromAccountId(accountId.trim(), slotCount);
    sessionKey = `slot${k}${rotation}`;
  } else {
    sessionKey = `${safeUserSegment(accountUsername)}${rotation}`;
  }

  return {
    server,
    username: `${username}-session-${sessionKey}${suffix}`,
    password: passwordBase,
  };
}
