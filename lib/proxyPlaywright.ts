/** Shared proxy config for Playwright (upload + rename + capture). */
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
