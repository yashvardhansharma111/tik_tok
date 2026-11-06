/**
 * Sweep AdsPower profiles and sync each account's stored @handle with the live one.
 *
 * Fixes drift from TikTok accounts renamed by hand. Read-only by default:
 *   npx tsx scripts/reconcile-usernames.ts            # report what would change
 *   npx tsx scripts/reconcile-usernames.ts --apply    # write the changes
 *   LIMIT=5 npx tsx scripts/reconcile-usernames.ts    # sample a few first
 */
import "dotenv/config";
import mongoose from "mongoose";
import { chromium } from "playwright";
import { startAdsPowerBrowser, stopAdsPowerBrowser } from "../automation/adspowerCapture";
import { extractTikTokUsername } from "../automation/loginAndCaptureSession";
import { reconcileAccountUsername, handlesMatch, normalizeHandle } from "../lib/accountReconcile";

const APPLY = process.argv.includes("--apply");
const LIMIT = Number(process.env.LIMIT || 0);

async function main() {
  await mongoose.connect(process.env.MONGODB_URI!, {
    dbName: process.env.MONGODB_DB || "tiktok_automation",
  });

  const col = mongoose.connection.collection(
    process.env.ADSPOWER_ACCOUNTS_COLLECTION || "adspower_accounts"
  );
  const q = col.find({ adspowerProfileId: { $exists: true } }).sort({ updatedAt: -1 });
  const docs = await (LIMIT > 0 ? q.limit(LIMIT) : q).toArray();

  console.log(`${APPLY ? "APPLY" : "DRY RUN"} — checking ${docs.length} account(s)\n`);

  const drifted: string[] = [];
  const conflicts: string[] = [];
  let loggedOut = 0;
  let errors = 0;

  type Row = { accountId?: unknown; username?: string; adspowerProfileId: string };
  for (const d of docs as unknown as Row[]) {
    const stored = normalizeHandle(d.username);
    let browser;
    try {
      const { wsUrl } = await startAdsPowerBrowser(d.adspowerProfileId);
      browser = await chromium.connectOverCDP(wsUrl);
      const ctx = browser.contexts()[0];
      const page = ctx.pages()[0] || (await ctx.newPage());

      await page
        .goto("https://www.tiktok.com/tiktokstudio/upload", {
          waitUntil: "domcontentloaded",
          timeout: 60000,
        })
        .catch(() => {});
      await page.waitForTimeout(4000);

      if (/\/login|\/signup/i.test(page.url())) {
        loggedOut++;
        console.log(`  SKIP     ${stored} — logged out, cannot read handle`);
        continue;
      }

      const live = await extractTikTokUsername(page);
      if (!live) {
        console.log(`  UNKNOWN  ${stored} — could not read live handle`);
        continue;
      }
      if (handlesMatch(live, stored)) {
        console.log(`  OK       ${stored}`);
        continue;
      }

      if (!APPLY) {
        drifted.push(`${stored} -> ${normalizeHandle(live)}`);
        console.log(`  DRIFT    ${stored} -> ${normalizeHandle(live)}  (dry run, not written)`);
        continue;
      }

      const outcome = await reconcileAccountUsername(String(d.accountId), live);
      if (outcome.changed) {
        drifted.push(`${outcome.from} -> ${outcome.to}`);
        console.log(`  FIXED    ${outcome.from} -> ${outcome.to}`);
      } else if (outcome.reason === "conflict") {
        conflicts.push(`${outcome.from} -> ${outcome.to}`);
        console.log(`  CONFLICT ${outcome.from} -> ${outcome.to} (held by ${outcome.conflictAccountId})`);
      } else {
        console.log(`  NOOP     ${stored} (${outcome.reason})`);
      }
    } catch (e) {
      errors++;
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`  ERROR    ${stored} — ${msg.slice(0, 100)}`);
    } finally {
      if (browser) await browser.close().catch(() => {});
      await stopAdsPowerBrowser(d.adspowerProfileId).catch(() => {});
    }
  }

  console.log("\n===== SUMMARY =====");
  console.log(`checked     ${docs.length}`);
  console.log(`drifted     ${drifted.length}${APPLY ? " (written)" : " (dry run)"}`);
  drifted.forEach((x) => console.log(`              ${x}`));
  console.log(`conflicts   ${conflicts.length}`);
  conflicts.forEach((x) => console.log(`              ${x}`));
  console.log(`logged out  ${loggedOut}`);
  console.log(`errors      ${errors}`);
  if (!APPLY && drifted.length > 0) console.log("\nRe-run with --apply to write these changes.");

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error("FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
