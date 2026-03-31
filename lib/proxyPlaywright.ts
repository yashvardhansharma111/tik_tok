/**
 * Shared proxy config for Playwright (upload + rename + capture).
 *
 * Why proxy traffic is high (not a bug by itself):
 * - Playwright routes **all** browser traffic (HTML, JS, images, video chunks, WebSockets) through
 *   `server` + sticky `username`/`password` when set — same as a full desktop session on TikTok Studio.
 * - **Parallel uploads** (N browser contexts) ≈ N concurrent sessions × normal page weight.
 * - Retries, sound search, and long flows add more requests. Residential/datacenter proxies bill by GB.
 * - To reduce usage: lower “Parallel browsers”, shorten flows, fix flaky networks to avoid retries,
 *   or run without a proxy only where TikTok is reachable without it (not all regions).
 */
export type PlaywrightProxyConfig = {
  server: string;
  username?: string;
  password?: string;
};

export function buildStickyProxyForAccount(accountUsername: string, accountProxy?: string, attemptNumber = 1): PlaywrightProxyConfig | undefined {
  const server =
    (accountProxy && accountProxy.trim()) || process.env.PROXY_SERVER || "";
  if (!server) return undefined;

  const username = process.env.PROXY_USERNAME;
  const passwordBase = process.env.PROXY_PASSWORD;
  if (!username || !passwordBase) {
    return { server };
  }
  const suffix = attemptNumber ? `-${attemptNumber}` : "";
  return {
    server,
    username,
    password: `${passwordBase}_session-${accountUsername.replace(/[^a-zA-Z0-9_-]/g, "_")}${suffix}`,
  };
}
