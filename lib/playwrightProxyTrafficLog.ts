import type { Page } from "playwright";

export type ProxyTrafficLogHandle = {
  /** Call before closing the browser context. Logs summary to stdout. */
  finish: (opts?: {
    mainGotoMs?: number;
    mainGotoUrl?: string;
    /** `pooled` = reused BrowserContext (HTTP cache warm); `fresh` = new context; `chained-reuse` = same tab multi-upload. */
    browserContext?: "pooled" | "fresh" | "chained-reuse";
  }) => void;
};

/**
 * Estimates egress through the proxied context by summing `Content-Length` on responses.
 * Responses without that header (chunked, etc.) are counted as "unknown" — not included in MB total.
 * Enable with env `TIKTOK_PROXY_TRAFFIC_LOG=1`.
 */
export function attachProxyTrafficLog(page: Page, label: string): ProxyTrafficLogHandle | null {
  if (process.env.TIKTOK_PROXY_TRAFFIC_LOG !== "1") {
    return null;
  }

  const byHost = new Map<string, number>();
  const byType = new Map<string, number>();
  let totalFromLength = 0;
  let responsesWithLength = 0;
  let responsesWithoutLength = 0;

  const navigations: { url: string; at: number }[] = [];

  const onResponse = (response: import("playwright").Response) => {
    const req = response.request();
    const cl = response.headers()["content-length"];
    if (!cl || !/^\d+$/.test(cl.trim())) {
      responsesWithoutLength += 1;
      return;
    }
    const n = parseInt(cl.trim(), 10);
    if (!Number.isFinite(n) || n <= 0) {
      responsesWithoutLength += 1;
      return;
    }
    responsesWithLength += 1;
    totalFromLength += n;
    const type = req.resourceType();
    byType.set(type, (byType.get(type) ?? 0) + n);
    try {
      const host = new URL(response.url()).hostname;
      byHost.set(host, (byHost.get(host) ?? 0) + n);
    } catch {
      // ignore bad URL
    }
  };

  const onFrameNav = (frame: import("playwright").Frame) => {
    if (frame === page.mainFrame()) {
      navigations.push({ url: frame.url(), at: Date.now() });
    }
  };

  page.on("response", onResponse);
  page.on("framenavigated", onFrameNav);

  return {
    finish: (opts) => {
      page.off("response", onResponse);
      page.off("framenavigated", onFrameNav);

      const mb = totalFromLength / (1024 * 1024);
      const lines: string[] = [];
      lines.push(`[ProxyTraffic] ${label}`);
      if (opts?.mainGotoUrl != null) {
        lines.push(`  main navigation: ${opts.mainGotoUrl} (${opts.mainGotoMs ?? "?"} ms)`);
      }
      if (opts?.browserContext === "pooled") {
        lines.push(
          `  browser context: pooled (warm cache — lower MB than a fresh context when the same account runs again without restarting the server)`
        );
      } else if (opts?.browserContext === "fresh") {
        lines.push(
          `  browser context: fresh (cold cache — expect higher MB; same account’s next success reuses context if TIKTOK_REUSE_UPLOAD_CONTEXT is on)`
        );
      } else if (opts?.browserContext === "chained-reuse") {
        lines.push(
          `  browser context: chained same-page upload (repeat navigations to upload URL — typically lower MB than full cold Studio load)`
        );
      }
      lines.push(
        `  estimated download (Content-Length only): ${mb.toFixed(2)} MB across ${responsesWithLength} responses; ${responsesWithoutLength} responses had no length (chunked/unknown) — not counted`
      );

      const topHosts = [...byHost.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
      if (topHosts.length) {
        lines.push("  top hostnames (by counted bytes):");
        for (const [host, bytes] of topHosts) {
          lines.push(`    ${host}: ${(bytes / (1024 * 1024)).toFixed(2)} MB`);
        }
      }

      const types = [...byType.entries()].sort((a, b) => b[1] - a[1]);
      if (types.length) {
        lines.push("  by resource type:");
        for (const [t, bytes] of types) {
          lines.push(`    ${t}: ${(bytes / (1024 * 1024)).toFixed(2)} MB`);
        }
      }

      if (navigations.length > 1) {
        lines.push(`  main-frame navigations (${navigations.length}):`);
        for (let i = 0; i < navigations.length; i++) {
          const cur = navigations[i]!;
          const prev = navigations[i - 1];
          const deltaMs = prev ? cur.at - prev.at : 0;
          lines.push(`    [${i + 1}] +${deltaMs}ms ${cur.url.slice(0, 120)}${cur.url.length > 120 ? "…" : ""}`);
        }
      }

      console.log(lines.join("\n"));
    },
  };
}
