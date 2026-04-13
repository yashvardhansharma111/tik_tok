/**
 * Standalone script for checking TikTok session health via Playwright.
 * Spawned by the API route as a child process to avoid Turbopack compilation issues.
 *
 * Usage: npx tsx scripts/checkSessionHealth.ts
 * Reads JSON from stdin: { accountIds: string[] }
 * Writes JSON to stdout on completion: { results: CheckResult[], summary: {...} }
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import dotenv from "dotenv";
dotenv.config();

import mongoose from "mongoose";
import fs from "fs";
import os from "os";
import path from "path";

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI || "";
const DB_NAME = process.env.MONGODB_DB || "tiktok_automation";
const CHECK_URL = "https://www.tiktok.com/tiktokstudio/upload?from=webapp";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const PARALLEL = 15;

type CheckResult = {
  id: string;
  username: string;
  previousStatus: string;
  currentStatus: "active" | "expired";
  changed: boolean;
};

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function buildProxy(username: string, accountId: string, accountProxy?: string) {
  const { createHash } = require("crypto");
  const server = (accountProxy?.trim()) || process.env.PROXY_SERVER || "";
  if (!server) return undefined;

  const proxyUser = process.env.PROXY_USERNAME;
  const passwordBase = process.env.PROXY_PASSWORD;
  if (!proxyUser || !passwordBase) return { server };

  const slotCount = Math.max(0, Math.min(512, Number(process.env.PROXY_STICKY_SLOT_COUNT || 0)));
  const rotateMinutes = Number(process.env.PROXY_ROTATE_MINUTES ?? 60);
  const rotation = rotateMinutes > 0
    ? `r${Math.floor(Date.now() / (Math.max(1, rotateMinutes) * 60_000))}`
    : "";

  let sessionKey: string;
  if (slotCount >= 2 && accountId) {
    const buf = createHash("sha256").update(accountId).digest();
    const k = buf.readUInt32BE(0) % slotCount;
    sessionKey = `slot${k}${rotation}`;
  } else {
    sessionKey = `${username.replace(/[^a-zA-Z0-9_-]/g, "_")}${rotation}`;
  }

  return {
    server,
    username: `${proxyUser}-session-${sessionKey}-1`,
    password: passwordBase,
  };
}

async function checkOneAccount(
  browser: any,
  account: { _id: string; username: string; session: string; proxy?: string; status: string }
): Promise<CheckResult> {
  const id = account._id;
  const tmpFile = path.join(os.tmpdir(), `hc-${id}-${Date.now()}.json`);
  let context: any;

  try {
    if (!account.session || account.session.length < 10) {
      return { id, username: account.username, previousStatus: account.status, currentStatus: "expired", changed: account.status !== "expired" };
    }

    fs.writeFileSync(tmpFile, account.session, "utf-8");
    const proxy = buildProxy(account.username, id, account.proxy);

    context = await browser.newContext({
      storageState: tmpFile,
      userAgent: UA,
      locale: "en-US",
      timezoneId: "America/New_York",
      ...(proxy?.server ? { proxy } : {}),
    });

    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });

    const page = await context.newPage();
    await page.goto(CHECK_URL, { waitUntil: "commit", timeout: 60000 });
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await page.waitForTimeout(3000);

    const loggedOut = await checkLoggedOut(page);
    const currentStatus = loggedOut ? "expired" : "active";

    return { id, username: account.username, previousStatus: account.status, currentStatus, changed: account.status !== currentStatus };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`[check-health] ${account.username}: error — ${msg}\n`);
    return { id, username: account.username, previousStatus: account.status, currentStatus: "expired", changed: account.status !== "expired" };
  } finally {
    await context?.close().catch(() => {});
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

async function checkLoggedOut(page: any): Promise<boolean> {
  const url = page.url();
  if (/tiktok\.com\/(login|signup)(\/|\?|$)/i.test(url)) return true;

  await page.waitForTimeout(600);

  const fileInput = page.locator('input[type="file"]');
  const uploadVisible = await fileInput.first().isVisible().catch(() => false);
  if (uploadVisible) return false;

  const profileHint = page.locator('[data-e2e="nav-profile"], [data-e2e="profile-icon"], a[href^="/@"]').first();
  if (await profileHint.isVisible().catch(() => false)) return false;

  const loginLink = page.getByRole("link", { name: /^log in$/i }).first();
  const loginBtn = page.getByRole("button", { name: /^log in$/i }).first();
  if (await loginLink.isVisible().catch(() => false)) return true;
  if (await loginBtn.isVisible().catch(() => false)) return true;

  const headingLogin = page.getByRole("heading", { name: /log in to tiktok/i });
  if (await headingLogin.isVisible().catch(() => false)) return true;

  return false;
}

async function main() {
  const input = JSON.parse(await readStdin());
  const accountIds: string[] = input.accountIds || [];

  if (accountIds.length === 0) {
    process.stdout.write(JSON.stringify({ error: "No account IDs" }));
    process.exit(1);
  }

  process.stderr.write(`[check-health] Starting health check for ${accountIds.length} accounts\n`);

  await mongoose.connect(MONGO_URI, { dbName: DB_NAME });
  const Account = mongoose.connection.collection("accounts");

  const objectIds = accountIds.map((id) => new mongoose.Types.ObjectId(id));

  // Step 1: load lightweight metadata only (no session blob)
  const accountMetas = await Account.find(
    { _id: { $in: objectIds } },
    { projection: { username: 1, proxy: 1, status: 1 } }
  ).toArray();

  process.stderr.write(`[check-health] Found ${accountMetas.length} accounts in DB\n`);

  const { chromium } = await import("playwright");

  const launchArgs = ["--disable-blink-features=AutomationControlled", "--disable-background-networking",
    "--disable-component-update", "--disable-default-apps", "--disable-sync",
    "--metrics-recording-only", "--no-first-run"];
  if (process.platform === "linux") {
    launchArgs.push("--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage");
  }

  const browser = await chromium.launch({
    headless: false,
    args: launchArgs,
  });

  process.stderr.write(`[check-health] Browser launched, checking in batches of ${PARALLEL}\n`);

  const results: CheckResult[] = [];

  for (let i = 0; i < accountMetas.length; i += PARALLEL) {
    const batchMetas = accountMetas.slice(i, i + PARALLEL);

    // Step 2: load session blobs one batch at a time
    const batchIds = batchMetas.map((m) => m._id);
    const batchWithSessions = await Account.find(
      { _id: { $in: batchIds } },
      { projection: { username: 1, session: 1, proxy: 1, status: 1 } }
    ).toArray();

    const batchResults = await Promise.all(
      batchWithSessions.map((acc: any) =>
        checkOneAccount(browser, {
          _id: String(acc._id),
          username: acc.username,
          session: acc.session,
          proxy: acc.proxy,
          status: acc.status || "active",
        })
      )
    );
    results.push(...batchResults);
    process.stderr.write(`[check-health] Progress: ${Math.min(i + PARALLEL, accountMetas.length)}/${accountMetas.length}\n`);
  }

  await browser.close().catch(() => {});

  const bulkOps = results
    .filter((r) => r.changed)
    .map((r) => ({
      updateOne: {
        filter: { _id: new mongoose.Types.ObjectId(r.id) },
        update: { $set: { status: r.currentStatus } },
      },
    }));

  if (bulkOps.length > 0) {
    await Account.bulkWrite(bulkOps);
    process.stderr.write(`[check-health] Updated ${bulkOps.length} accounts in DB\n`);
  }

  await mongoose.disconnect();

  const summary = {
    checked: results.length,
    active: results.filter((r) => r.currentStatus === "active").length,
    expired: results.filter((r) => r.currentStatus === "expired").length,
    changed: results.filter((r) => r.changed).length,
  };

  process.stdout.write(JSON.stringify({ results, summary }));
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`[check-health] Fatal: ${err}\n`);
  process.stdout.write(JSON.stringify({ error: String(err) }));
  process.exit(1);
});
