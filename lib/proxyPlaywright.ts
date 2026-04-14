/**
 * Shared proxy config for Playwright (upload + rename + capture + health check).
 *
 * **1:1 mapping:** every TikTok account gets its own unique sticky session.
 * The session key is the account's MongoDB `_id`, ensuring:
 *   - No two accounts ever share the same proxy IP
 *   - The same account always gets the same IP (until the provider rotates)
 *   - Login, upload, rename, and health checks all use the same session
 *
 * Proxy username format (IPRoyal):
 *   <PROXY_USERNAME><PROXY_SESSION_SEP><sessionKey>
 * Example (default sep "_session-"):
 *   tDcJl2f7pYXAjziS_session-69c35cb55c2f87582236a6ed
 *
 * Env controls:
 *   PROXY_STICKY_SESSION=false  — disable session appending entirely (plain username only)
 *   PROXY_SESSION_SEP=_session- — separator between username and session key (default: _session-)
 *                                 try "_session=" if "_session-" fails with your provider
 */

export type PlaywrightProxyConfig = {
  server: string;
  username?: string;
  password?: string;
};

/**
 * Build a sticky proxy config for a specific account.
 *
 * - `accountId` is **required** for 1:1 mapping. If missing, falls back to
 *   sanitized `accountUsername` (legacy callers that haven't been updated).
 * - `attemptNumber` is accepted for API compatibility but **ignored** --
 *   retries use the same session/IP to avoid detection.
 * - `accountProxy` overrides `PROXY_SERVER` if the account has a per-account proxy URL.
 */
export function buildStickyProxyForAccount(
  accountUsername: string,
  accountProxy?: string,
  _attemptNumber = 1,
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

  // PROXY_STICKY_SESSION=false -> use plain username, no session suffix (for testing / unsupported providers)
  const stickyEnabled = process.env.PROXY_STICKY_SESSION !== "false" && process.env.PROXY_STICKY_SESSION !== "0";

  if (!stickyEnabled) {
    console.log(
      `[PROXY_DEBUG] sticky=OFF accountId=${accountId ?? "N/A"} proxyUsername=${username}`
    );
    return { server, username, password: passwordBase };
  }

  const sessionKey = accountId && accountId.trim()
    ? accountId.trim()
    : accountUsername.replace(/[^a-zA-Z0-9_-]/g, "_");

  // PROXY_SESSION_SEP controls the separator (default: _session-)
  // Try PROXY_SESSION_SEP="_session=" if "_session-" causes auth errors with your provider
  const sep = process.env.PROXY_SESSION_SEP ?? "_session-";

  const proxyUsername = `${username}${sep}${sessionKey}`;

  console.log(
    `[PROXY_DEBUG] sticky=ON sep="${sep}" accountId=${accountId ?? "N/A"} sessionId=${sessionKey} proxyUsername=${proxyUsername}`
  );

  return {
    server,
    username: proxyUsername,
    password: passwordBase,
  };
}
